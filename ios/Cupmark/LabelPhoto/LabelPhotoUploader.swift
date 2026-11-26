import Foundation

/// The two API calls of a label photo upload (ADR 0016). `APIClient` is the live one; tests
/// use a fake.
protocol LabelPhotoAPI: Sendable {
    /// `POST /beans/{bean_id}/label_photos`.
    func createLabelPhotoUpload(beanID: ResourceID) async throws -> API.LabelPhotoUpload
    /// `POST /label_photos/{photo_id}/complete`.
    func completeLabelPhoto(photoID: ResourceID) async throws
}

extension APIClient: LabelPhotoAPI {}

/// Sends the presigned POST to S3 and returns the HTTP status. Throws `APIError.transport`
/// when the request did not complete, `CancellationError` when it was cancelled. Tests use a
/// stub that records the request.
protocol PresignedPostTransport: Sendable {
    func send(_ request: URLRequest, body: Data) async throws -> Int
}

/// Refuses every HTTP redirect, so the photo is never sent on to a URL that was not checked
/// against the contract. A 3xx is then the final response, which the uploader treats as a
/// failure.
final class RefuseRedirectsDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// The live transport: its own ephemeral session, so nothing of the API's session (and no
/// bearer token, which `APIClient` sets per request anyway) can reach S3. No cache, no
/// cookies, no redirects.
struct URLSessionPresignedPostTransport: PresignedPostTransport {
    /// One session for every upload of the app.
    static let shared = URLSessionPresignedPostTransport(session: URLSessionPresignedPostTransport.makeSession())

    let session: URLSession

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 60
        return URLSession(configuration: configuration, delegate: RefuseRedirectsDelegate(), delegateQueue: nil)
    }

    func send(_ request: URLRequest, body: Data) async throws -> Int {
        let response: URLResponse
        do {
            let result = try await session.upload(for: request, from: body)
            response = result.1
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            throw APIError.transport((error as? URLError)?.code ?? .unknown)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        return http.statusCode
    }
}

/// One label photo on its way to the server: the bean, the JPEG file, and how far it got.
/// `LabelPhotoUploader.run` takes a job and returns it updated, so a retry resumes where the
/// last attempt stopped (the S3 POST is not repeated after it succeeded, and an uncertain
/// completion is asked again). M2-T25 can keep jobs in the outbox to run them once online.
struct LabelPhotoUploadJob: Sendable, Equatable {
    enum Stage: Sendable, Equatable {
        /// No presigned POST yet, or the last one can no longer be used.
        case notStarted
        /// `POST /beans/{bean_id}/label_photos` answered; the S3 POST has not succeeded yet.
        case issued(API.LabelPhotoUpload)
        /// The S3 POST succeeded; completion has not answered 204 yet. `completionUnconfirmed`
        /// is set when a completion call failed without a status the server certainly did not
        /// act on, so the server may already have recorded the photo.
        case uploaded(photoID: ResourceID, completionUnconfirmed: Bool)
    }

    /// The account the photo was taken under. Every step first checks that it is still the
    /// one signed in (ADR 0025), so a photo is never sent with another account's token.
    let account: AccountID
    let beanID: ResourceID
    /// A file of the account's `LabelPhotoFileStore`.
    let file: URL
    var stage: Stage

    init(account: AccountID, beanID: ResourceID, file: URL, stage: Stage = .notStarted) {
        self.account = account
        self.beanID = beanID
        self.file = file
        self.stage = stage
    }
}

/// How an upload attempt ended.
enum LabelPhotoUploadOutcome: Equatable, Sendable {
    /// 204 on completion: the photo is stored for review. The file has been deleted.
    case completed
    /// 400 on completion, or S3 refused the file: the photo is rejected for good. Offer a
    /// retake.
    case rejected
    /// 409 (the bean is verified, or the caller has 3 photos for it), or the bean takes no
    /// photos (404 or 400 on starting the upload). No more photos for this bean.
    case noMorePhotos
    /// 429: the daily cap of new uploads is used up, or the API throttles. Try again tomorrow.
    case dailyLimitReached
    /// 401 after the client's refresh, or the job's account is no longer the one signed in:
    /// sign in again.
    case signInRequired
    /// Anything else (no network, 5xx, an upload URL outside the contract, ...). The job is
    /// kept and can be run again.
    case failed
}

struct LabelPhotoUploadResult: Sendable, Equatable {
    let outcome: LabelPhotoUploadOutcome
    /// The job as it stands now; run it again to retry after `.failed` or `.signInRequired`.
    let job: LabelPhotoUploadJob
}

/// Runs upload jobs. `LabelPhotoUploader` is the live one; model tests use a fake.
protocol LabelPhotoUploading: Sendable {
    func run(_ job: LabelPhotoUploadJob) async -> LabelPhotoUploadResult
}

/// The upload of one label photo (ADR 0016, M2-T24, contracts/openapi.yaml
/// `createLabelPhotoUpload` and `completeLabelPhoto`):
///
/// 1. `POST /beans/{bean_id}/label_photos` gives a photo id and a presigned S3 POST.
/// 2. The POST is checked against the contract (`PresignedLabelPhotoPost`): nothing is sent
///    unless the URL is a `cupmark-` bucket in eu-central-1 and every field matches its
///    pattern. Then a `multipart/form-data` POST to it: every field under its S3 name, `file`
///    last. It goes through `transport`, never through `APIClient`, so it carries no token.
/// 3. `POST /label_photos/{photo_id}/complete`. After its 204 the file is deleted.
///
/// Before each step the job's account must still be the one signed in (`isCurrentAccount`,
/// ADR 0025); otherwise the run stops with `signInRequired`.
///
/// New uploads, each of which counts against the daily cap of 20:
/// - An expiry, at most once per run: either `expires_at` has passed (or will within
///   `expiryMargin`) by the device clock, or S3 answers 403 (the policy expired). After that
///   one restart the device clock is not trusted again (it may be wrong): the POST is sent and
///   S3 decides, and a second 403 ends the run with `failed`.
/// - A 404 on completion, at most once per run.
/// So a run asks for at most 3 presigned POSTs (`maxUploadsPerRun`), and a skewed clock or a
/// policy S3 always refuses costs at most 2. Every other status ends the run with an outcome;
/// see `LabelPhotoUploadOutcome`.
struct LabelPhotoUploader: LabelPhotoUploading {
    /// New presigned POSTs one run may ask for; each counts against the daily cap.
    static let maxUploadsPerRun = 3
    /// A presigned POST this close to `expires_at` is not used: the upload could outlast it.
    static let expiryMargin: TimeInterval = 30
    /// The file name in the `file` part. S3 ignores it; the key is fixed by the policy.
    static let fileName = "label.jpg"

    let api: any LabelPhotoAPI
    let transport: any PresignedPostTransport
    let files: LabelPhotoFileStore
    let isCurrentAccount: @Sendable (AccountID) async -> Bool
    let now: @Sendable () -> Date
    let makeBoundary: @Sendable () -> String

    init(
        api: any LabelPhotoAPI,
        transport: any PresignedPostTransport = URLSessionPresignedPostTransport.shared,
        files: LabelPhotoFileStore,
        isCurrentAccount: @escaping @Sendable (AccountID) async -> Bool,
        now: @escaping @Sendable () -> Date = { Date() },
        makeBoundary: @escaping @Sendable () -> String = { MultipartFormBody.makeBoundary() }
    ) {
        self.api = api
        self.transport = transport
        self.files = files
        self.isCurrentAccount = isCurrentAccount
        self.now = now
        self.makeBoundary = makeBoundary
    }

    func run(_ initial: LabelPhotoUploadJob) async -> LabelPhotoUploadResult {
        var job = initial
        var newUploads = 0
        var expiryRestarted = false
        var notFoundRestarted = false
        while true {
            guard await isCurrentAccount(job.account) else {
                return LabelPhotoUploadResult(outcome: .signInRequired, job: job)
            }
            switch job.stage {
            case .notStarted:
                guard newUploads < LabelPhotoUploader.maxUploadsPerRun else {
                    return LabelPhotoUploadResult(outcome: .failed, job: job)
                }
                newUploads += 1
                do {
                    job.stage = .issued(try await api.createLabelPhotoUpload(beanID: job.beanID))
                } catch {
                    return LabelPhotoUploadResult(outcome: LabelPhotoUploader.outcomeOfStart(error), job: job)
                }

            case .issued(let upload):
                let expiredByClock = now() >= upload.expiresAt.date.addingTimeInterval(-LabelPhotoUploader.expiryMargin)
                if expiredByClock, !expiryRestarted {
                    expiryRestarted = true
                    job.stage = .notStarted
                    continue
                }
                let post: PresignedLabelPhotoPost
                do {
                    post = try PresignedLabelPhotoPost(validating: upload)
                } catch {
                    // Not our bucket, or a field outside the contract: never sent to.
                    job.stage = .notStarted
                    return LabelPhotoUploadResult(outcome: .failed, job: job)
                }
                switch await send(post, file: job.file) {
                case .uploaded:
                    job.stage = .uploaded(photoID: post.photoID, completionUnconfirmed: false)
                case .expired:
                    job.stage = .notStarted
                    guard !expiryRestarted else {
                        return LabelPhotoUploadResult(outcome: .failed, job: job)
                    }
                    expiryRestarted = true
                case .refused:
                    job.stage = .notStarted
                    return LabelPhotoUploadResult(outcome: .rejected, job: job)
                case .failed:
                    return LabelPhotoUploadResult(outcome: .failed, job: job)
                }

            case .uploaded(let photoID, let unconfirmed):
                do {
                    try await api.completeLabelPhoto(photoID: photoID)
                    files.delete(job.file)
                    return LabelPhotoUploadResult(outcome: .completed, job: job)
                } catch APIError.badRequest {
                    job.stage = .notStarted
                    return LabelPhotoUploadResult(outcome: .rejected, job: job)
                } catch APIError.notFound {
                    // Nothing pending under this id (the staging copy expired, for example).
                    job.stage = .notStarted
                    guard !notFoundRestarted else {
                        return LabelPhotoUploadResult(outcome: .failed, job: job)
                    }
                    notFoundRestarted = true
                } catch APIError.conflict {
                    if unconfirmed {
                        // The last completion most likely went through: 409 "already completed".
                        // If it never reached the server, this 409 may instead be the 3-photo
                        // cap, and the photo is shown as sent although it was not stored.
                        files.delete(job.file)
                        return LabelPhotoUploadResult(outcome: .completed, job: job)
                    }
                    return LabelPhotoUploadResult(outcome: .noMorePhotos, job: job)
                } catch APIError.tooManyRequests {
                    return LabelPhotoUploadResult(outcome: .dailyLimitReached, job: job)
                } catch APIError.unauthorized {
                    return LabelPhotoUploadResult(outcome: .signInRequired, job: job)
                } catch {
                    job.stage = .uploaded(photoID: photoID, completionUnconfirmed: true)
                    return LabelPhotoUploadResult(outcome: .failed, job: job)
                }
            }
        }
    }

    /// The outcome of a failed `POST /beans/{bean_id}/label_photos`.
    static func outcomeOfStart(_ error: any Error) -> LabelPhotoUploadOutcome {
        switch error as? APIError {
        case .conflict?, .notFound?, .badRequest?:
            return .noMorePhotos
        case .tooManyRequests?:
            return .dailyLimitReached
        case .unauthorized?:
            return .signInRequired
        default:
            return .failed
        }
    }

    private enum PostResult {
        /// 2xx (S3 answers 204 by default).
        case uploaded
        /// 403: the policy expired or no longer matches; a new upload is needed.
        case expired
        /// Another 4xx, or a file the policy cannot accept: the photo itself was refused.
        case refused
        /// No network, 5xx, or the body could not be built: try again later.
        case failed
    }

    /// The S3 POST of `file` to `post`.
    private func send(_ post: PresignedLabelPhotoPost, file: URL) async -> PostResult {
        guard files.contains(file), let jpeg = try? Data(contentsOf: file) else {
            return .refused
        }
        guard (1...post.maxBytes).contains(jpeg.count), jpeg.starts(with: [0xFF, 0xD8]) else {
            return .refused
        }
        guard let body = makeBody(post, jpeg: jpeg) else {
            return .failed
        }
        let status: Int
        do {
            status = try await transport.send(post.request(for: body), body: body.data)
        } catch {
            return .failed
        }
        switch status {
        case 200...299: return .uploaded
        case 403: return .expired
        case 400...499: return .refused
        default: return .failed
        }
    }

    /// The multipart body, with a new boundary if the first one happens to occur in the file.
    private func makeBody(_ post: PresignedLabelPhotoPost, jpeg: Data) -> MultipartFormBody? {
        for _ in 0..<3 {
            do {
                return try MultipartFormBody(
                    fields: post.fields,
                    fileFieldName: PresignedLabelPhotoPost.FieldName.file,
                    fileName: LabelPhotoUploader.fileName,
                    fileContentType: "image/jpeg",
                    file: jpeg,
                    boundary: makeBoundary()
                )
            } catch MultipartFormBody.BuildError.boundaryInContent {
                continue
            } catch {
                return nil
            }
        }
        return nil
    }
}
