import CoreGraphics
import Foundation
import Observation

/// The label photos of one saved, unverified bean (M2-T24, F1 step 4, ADR 0016): up to
/// `maxPhotos`, each written to a file of `LabelPhotoFileStore` and uploaded at once by
/// `LabelPhotoUploader`. The network is needed; nothing is queued yet (M2-T25).
///
/// - Uploads run in unstructured tasks, so leaving the screen does not cancel one the server
///   may already be acting on.
/// - What each outcome does to a photo: see `Status`. A rejected photo offers a retake, a
///   failed one "Try again" (which resumes its job), and 409 or 429 stop new photos.
/// - A photo's file is deleted when the upload completes (by the uploader), and when the photo
///   is rejected, refused or removed (here).
@MainActor
@Observable
final class LabelPhotoUploadModel {
    /// ADR 0016: at most 3 label photos per bean and user.
    static let maxPhotos = 3

    enum Status: Equatable, Sendable {
        /// A capture is being encoded.
        case preparing
        /// The capture could not be encoded. Retake.
        case encodingFailed
        /// The upload is running.
        case uploading
        /// 204: stored for review.
        case uploaded
        /// 400 on completion: the photo was not accepted. Retake.
        case rejected
        /// 409: the bean takes no more label photos. Not uploaded.
        case notAccepted
        /// 429: try again tomorrow. Not uploaded.
        case dailyLimitReached
        /// 401: sign in again, then try again.
        case signInRequired
        /// Any other failure: try again.
        case failed
    }

    struct Photo: Identifiable, Equatable {
        let id: UUID
        var status: Status
        /// A small upright preview; not compared.
        var preview: CGImage?

        static func == (lhs: Photo, rhs: Photo) -> Bool {
            lhs.id == rhs.id && lhs.status == rhs.status
        }
    }

    let beanID: ResourceID
    private(set) var photos: [Photo] = []
    /// Set by a 409: no new photo is offered.
    private(set) var noMorePhotos = false
    /// Set by a 429: no new photo is offered until the next time.
    private(set) var dailyLimitReached = false

    @ObservationIgnored private var jobs: [UUID: LabelPhotoUploadJob] = [:]
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    /// Raised per photo by every capture, so a slow encoding of a replaced capture is dropped.
    @ObservationIgnored private var generations: [UUID: Int] = [:]

    private let uploader: any LabelPhotoUploading
    private let files: LabelPhotoFileStore
    private let prepare: LabelPhotoDraft.Prepare

    init(
        beanID: ResourceID,
        uploader: any LabelPhotoUploading,
        files: LabelPhotoFileStore = .standard(),
        prepare: @escaping LabelPhotoDraft.Prepare = { try await PreparedLabelPhoto.prepare($0) }
    ) {
        self.beanID = beanID
        self.uploader = uploader
        self.files = files
        self.prepare = prepare
    }

    /// Whether another photo can be taken: fewer than `maxPhotos`, and no 409 or 429 yet.
    var canAddPhoto: Bool {
        photos.count < LabelPhotoUploadModel.maxPhotos && !noMorePhotos && !dailyLimitReached
    }

    var uploadedCount: Int {
        photos.filter { $0.status == .uploaded }.count
    }

    /// Whether any photo is being encoded or uploaded.
    var isBusy: Bool {
        photos.contains { $0.status == .preparing || $0.status == .uploading }
    }

    // MARK: - Actions

    /// Adds an already encoded photo (the one taken in the entry form) and uploads it.
    func add(_ prepared: PreparedLabelPhoto) {
        guard canAddPhoto else {
            return
        }
        let id = UUID()
        photos.append(Photo(id: id, status: .preparing, preview: prepared.preview))
        store(prepared, for: id)
    }

    /// Encodes `capture`, adds it and uploads it.
    func add(_ capture: LabelPhotoCapture) async {
        guard canAddPhoto else {
            return
        }
        let id = UUID()
        photos.append(Photo(id: id, status: .preparing, preview: nil))
        await encode(capture, for: id)
    }

    /// Replaces a photo that was rejected, could not be encoded or failed with a new capture.
    func retake(_ id: UUID, with capture: LabelPhotoCapture) async {
        guard let photo = photo(id), LabelPhotoUploadModel.canRetake(photo.status) else {
            return
        }
        discardJob(id)
        update(id) { photo in
            photo.status = .preparing
            photo.preview = nil
        }
        await encode(capture, for: id)
    }

    /// Runs a failed upload again, from where it stopped.
    func retry(_ id: UUID) {
        guard let photo = photo(id), LabelPhotoUploadModel.canRetry(photo.status), let job = jobs[id] else {
            return
        }
        start(id, job: job)
    }

    /// Drops a photo that is not uploading or uploaded, and its file.
    func remove(_ id: UUID) {
        guard let photo = photo(id), LabelPhotoUploadModel.canRemove(photo.status) else {
            return
        }
        generations[id, default: 0] += 1
        discardJob(id)
        photos.removeAll { $0.id == id }
    }

    /// Waits for every upload under way. For tests.
    func waitForUploads() async {
        while let task = tasks.values.first {
            await task.value
        }
    }

    static func canRetake(_ status: Status) -> Bool {
        status == .rejected || status == .encodingFailed || status == .failed
    }

    static func canRetry(_ status: Status) -> Bool {
        status == .failed || status == .signInRequired
    }

    static func canRemove(_ status: Status) -> Bool {
        switch status {
        case .preparing, .uploading, .uploaded: false
        case .encodingFailed, .rejected, .notAccepted, .dailyLimitReached, .signInRequired, .failed: true
        }
    }

    // MARK: - Steps

    private func encode(_ capture: LabelPhotoCapture, for id: UUID) async {
        generations[id, default: 0] += 1
        let generation = generations[id, default: 0]
        do {
            let prepared = try await prepare(capture)
            guard generations[id, default: 0] == generation, photo(id) != nil else {
                return
            }
            update(id) { $0.preview = prepared.preview }
            store(prepared, for: id)
        } catch {
            guard generations[id, default: 0] == generation else {
                return
            }
            update(id) { $0.status = .encodingFailed }
        }
    }

    /// Writes the JPEG to a file and starts its upload. A file that cannot be written counts
    /// as a failed encoding: retake.
    private func store(_ prepared: PreparedLabelPhoto, for id: UUID) {
        do {
            let file = try files.write(prepared.photo.data)
            start(id, job: LabelPhotoUploadJob(beanID: beanID, file: file))
        } catch {
            update(id) { $0.status = .encodingFailed }
        }
    }

    private func start(_ id: UUID, job: LabelPhotoUploadJob) {
        jobs[id] = job
        update(id) { $0.status = .uploading }
        let uploader = self.uploader
        tasks[id] = Task { [weak self] in
            let result = await uploader.run(job)
            self?.finish(id, with: result)
        }
    }

    private func finish(_ id: UUID, with result: LabelPhotoUploadResult) {
        tasks[id] = nil
        guard photo(id) != nil, jobs[id]?.file == result.job.file else {
            // Removed or retaken meanwhile.
            files.delete(result.job.file)
            return
        }
        switch result.outcome {
        case .completed:
            jobs[id] = nil
            update(id) { $0.status = .uploaded }
        case .rejected:
            discardJob(id)
            update(id) { $0.status = .rejected }
        case .noMorePhotos:
            discardJob(id)
            noMorePhotos = true
            update(id) { $0.status = .notAccepted }
        case .dailyLimitReached:
            // Nothing retries it in this task; M2-T25 will queue it instead.
            discardJob(id)
            dailyLimitReached = true
            update(id) { $0.status = .dailyLimitReached }
        case .signInRequired:
            jobs[id] = result.job
            update(id) { $0.status = .signInRequired }
        case .failed:
            jobs[id] = result.job
            update(id) { $0.status = .failed }
        }
    }

    private func discardJob(_ id: UUID) {
        if let job = jobs.removeValue(forKey: id) {
            files.delete(job.file)
        }
    }

    private func photo(_ id: UUID) -> Photo? {
        photos.first { $0.id == id }
    }

    private func update(_ id: UUID, _ change: (inout Photo) -> Void) {
        guard let index = photos.firstIndex(where: { $0.id == id }) else {
            return
        }
        change(&photos[index])
    }
}
