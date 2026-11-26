import CoreGraphics
import XCTest
@testable import Cupmark

/// Answers each run with the next scripted outcome (`.completed` when the script is empty) and
/// records the jobs it was given. Like the live uploader, it deletes the file on `.completed`,
/// and after `.failed` it hands back a job that has got as far as the S3 POST.
private actor ScriptedUploader: LabelPhotoUploading {
    private var script: [LabelPhotoUploadOutcome]
    private(set) var runs: [LabelPhotoUploadJob] = []
    private let files: LabelPhotoFileStore

    init(_ script: [LabelPhotoUploadOutcome] = [], files: LabelPhotoFileStore) {
        self.script = script
        self.files = files
    }

    func run(_ job: LabelPhotoUploadJob) async -> LabelPhotoUploadResult {
        runs.append(job)
        let outcome = script.isEmpty ? LabelPhotoUploadOutcome.completed : script.removeFirst()
        var next = job
        switch outcome {
        case .completed:
            files.delete(job.file)
        case .failed:
            if let photoID = ResourceID(LabelPhotoFixtures.photoID(1)) {
                next.stage = .uploaded(photoID: photoID, completionUnconfirmed: true)
            }
        case .rejected, .noMorePhotos, .dailyLimitReached, .signInRequired:
            break
        }
        return LabelPhotoUploadResult(outcome: outcome, job: next)
    }
}

private struct StubEncodingFailure: Error {}

/// Holds every run until `open()`, then answers `outcome`. Counts the runs that started.
private final class GatedUploader: LabelPhotoUploading, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    private var startedRuns = 0
    private let outcome: LabelPhotoUploadOutcome

    init(outcome: LabelPhotoUploadOutcome) {
        self.outcome = outcome
    }

    var started: Int {
        lock.withLock { startedRuns }
    }

    func run(_ job: LabelPhotoUploadJob) async -> LabelPhotoUploadResult {
        lock.withLock { startedRuns += 1 }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resumeNow = lock.withLock {
                if isOpen {
                    return true
                }
                continuations.append(continuation)
                return false
            }
            if resumeNow {
                continuation.resume()
            }
        }
        return LabelPhotoUploadResult(outcome: outcome, job: job)
    }

    func open() {
        let waiting = lock.withLock {
            isOpen = true
            let all = continuations
            continuations = []
            return all
        }
        for continuation in waiting {
            continuation.resume()
        }
    }
}

/// `LabelPhotoUploadModel` (M2-T24): up to 3 photos per bean, what each upload outcome does to
/// a photo and its file, retry and retake; and `BeanEntryModel` handing the form's photo over
/// once an unverified bean is saved.
@MainActor
final class LabelPhotoUploadModelTests: XCTestCase {
    private var store = LabelPhotoFixtures.fileStore()
    /// The stub registry holds servers weakly, so each test keeps its servers alive here
    /// even when it ignores the one `makeEntry` returns.
    private var servers: [StubServer] = []

    override func tearDown() {
        try? FileManager.default.removeItem(at: store.directory)
        super.tearDown()
    }

    private func prepared() -> PreparedLabelPhoto {
        PreparedLabelPhoto(
            photo: EncodedLabelPhoto(data: LabelPhotoFixtures.jpeg, pixelWidth: 4, pixelHeight: 3, quality: 0.9),
            preview: nil
        )
    }

    private func capture() throws -> LabelPhotoCapture {
        LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 40, height: 20), orientation: .up)
    }

    private func makeModel(
        _ script: [LabelPhotoUploadOutcome] = [],
        prepare: LabelPhotoDraft.Prepare? = nil
    ) throws -> (LabelPhotoUploadModel, ScriptedUploader) {
        let uploader = ScriptedUploader(script, files: store)
        return (try makeModel(uploader: uploader, prepare: prepare), uploader)
    }

    private func makeModel(
        uploader: any LabelPhotoUploading,
        prepare: LabelPhotoDraft.Prepare? = nil
    ) throws -> LabelPhotoUploadModel {
        let result = prepared()
        let prepareStep: LabelPhotoDraft.Prepare = prepare ?? { _ in result }
        return LabelPhotoUploadModel(
            beanID: try LabelPhotoFixtures.bean(),
            account: LabelPhotoFixtures.photoAccount(files: store),
            uploader: uploader,
            prepare: prepareStep
        )
    }

    private func statuses(_ model: LabelPhotoUploadModel) -> [LabelPhotoUploadModel.Status] {
        model.photos.map(\.status)
    }

    // MARK: - Adding

    func testAPhotoIsUploadedAndItsFileDeleted() async throws {
        let (model, uploader) = try makeModel()

        await model.add(prepared())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.uploaded])
        XCTAssertEqual(model.uploadedCount, 1)
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs.first?.beanID, try LabelPhotoFixtures.bean())
        XCTAssertEqual(runs.first?.stage, .notStarted)
        XCTAssertTrue(store.files().isEmpty)
    }

    func testACaptureIsEncodedThenUploaded() async throws {
        let (model, uploader) = try makeModel()

        await model.add(try capture())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.uploaded])
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 1)
    }

    func testACaptureThatCannotBeEncodedOffersARetake() async throws {
        let (model, uploader) = try makeModel(prepare: { _ in throw StubEncodingFailure() })

        await model.add(try capture())

        XCTAssertEqual(statuses(model), [.encodingFailed])
        XCTAssertTrue(LabelPhotoUploadModel.canRetake(.encodingFailed))
        let runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty)
    }

    func testAtMostThreePhotosPerBean() async throws {
        let (model, uploader) = try makeModel()

        for _ in 0..<4 {
            await model.add(prepared())
        }
        await model.waitForUploads()

        XCTAssertEqual(LabelPhotoUploadModel.maxPhotos, 3)
        XCTAssertEqual(statuses(model), [.uploaded, .uploaded, .uploaded])
        XCTAssertFalse(model.canAddPhoto)
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 3)
    }

    // MARK: - Outcomes

    func testARejectedPhotoOffersARetakeAndDropsItsFile() async throws {
        let (model, uploader) = try makeModel([.rejected, .completed])

        await model.add(prepared())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.rejected])
        XCTAssertTrue(store.files().isEmpty)
        XCTAssertTrue(model.canAddPhoto)

        let id = try XCTUnwrap(model.photos.first?.id)
        await model.retake(id, with: try capture())
        await model.waitForUploads()

        XCTAssertEqual(model.photos.map(\.id), [id])
        XCTAssertEqual(statuses(model), [.uploaded])
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs.last?.stage, .notStarted)
    }

    func testA409StopsNewPhotos() async throws {
        let (model, _) = try makeModel([.noMorePhotos])

        await model.add(prepared())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.notAccepted])
        XCTAssertTrue(model.noMorePhotos)
        XCTAssertFalse(model.canAddPhoto)
        XCTAssertTrue(store.files().isEmpty)

        await model.add(prepared())
        XCTAssertEqual(model.photos.count, 1)
    }

    func testA429SaysTryAgainTomorrowAndStopsNewPhotos() async throws {
        let (model, _) = try makeModel([.dailyLimitReached])

        await model.add(prepared())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.dailyLimitReached])
        XCTAssertTrue(model.dailyLimitReached)
        XCTAssertFalse(model.canAddPhoto)
        XCTAssertTrue(store.files().isEmpty)
    }

    func testAFailedUploadKeepsItsFileAndRetriesFromWhereItStopped() async throws {
        let (model, uploader) = try makeModel([.failed, .completed])

        await model.add(prepared())
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.failed])
        XCTAssertEqual(store.files().count, 1)

        let id = try XCTUnwrap(model.photos.first?.id)
        model.retry(id)
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.uploaded])
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs.last?.stage, .uploaded(photoID: try XCTUnwrap(ResourceID(LabelPhotoFixtures.photoID(1))), completionUnconfirmed: true))
        XCTAssertEqual(runs.first?.file, runs.last?.file)
        XCTAssertTrue(store.files().isEmpty)
    }

    func testSignInRequiredCanBeRetried() async throws {
        let (model, uploader) = try makeModel([.signInRequired, .completed])

        await model.add(prepared())
        await model.waitForUploads()
        XCTAssertEqual(statuses(model), [.signInRequired])

        model.retry(try XCTUnwrap(model.photos.first?.id))
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.uploaded])
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 2)
    }

    func testRemovingAFailedPhotoDeletesItsFileAndFreesItsPlace() async throws {
        let (model, _) = try makeModel([.failed, .failed, .failed])
        for _ in 0..<3 {
            await model.add(prepared())
        }
        await model.waitForUploads()
        XCTAssertFalse(model.canAddPhoto)
        XCTAssertEqual(store.files().count, 3)

        model.remove(try XCTUnwrap(model.photos.first?.id))

        XCTAssertEqual(model.photos.count, 2)
        XCTAssertEqual(store.files().count, 2)
        XCTAssertTrue(model.canAddPhoto)
    }

    func testAnUploadedPhotoCannotBeRemovedOrRetried() async throws {
        let (model, uploader) = try makeModel()
        await model.add(prepared())
        await model.waitForUploads()
        let id = try XCTUnwrap(model.photos.first?.id)

        model.remove(id)
        model.retry(id)
        await model.waitForUploads()

        XCTAssertEqual(statuses(model), [.uploaded])
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 1)
    }

    // MARK: - Bean entry

    private func bean(verified: Bool) -> API.Bean {
        API.Bean(
            beanId: LabelPhotoFixtures.beanID,
            vocabularyVersion: Vocabulary.version,
            verified: verified,
            openFoodFactsMatch: false,
            pickedAttributes: API.BeanAttributes(),
            operatorAttributes: API.BeanAttributes()
        )
    }

    private func makeEntry(saving bean: API.Bean, uploader: ScriptedUploader) throws -> (BeanEntryModel, StubServer) {
        let body = try JSONEncoder().encode(bean)
        let server = try StubServer { _ in StubResponse(status: 201, body: body, headers: ["Content-Type": "application/json"]) }
        servers.append(server)
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        let model = BeanEntryModel(
            barcode: nil,
            client: client,
            labelPhotos: LabelPhotoFixtures.photoAccount(files: store),
            photoUploader: uploader
        )
        return (model, server)
    }

    func testSavingAnUnverifiedBeanUploadsTheFormsPhoto() async throws {
        let uploader = ScriptedUploader(files: store)
        let (entry, server) = try makeEntry(saving: bean(verified: false), uploader: uploader)
        let draft = entry.labelPhoto
        await draft.attach(try capture())
        XCTAssertNotNil(draft.photo)

        await entry.save()

        let uploads = try XCTUnwrap(entry.labelPhotoUploads)
        XCTAssertEqual(uploads.beanID.rawValue, LabelPhotoFixtures.beanID)
        await uploads.waitForUploads()
        XCTAssertEqual(uploads.photos.map(\.status), [.uploaded])
        XCTAssertEqual(draft.state, .empty)
        let runs = await uploader.runs
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(server.requests.count, 1)
    }

    func testSavingAnUnverifiedBeanWithoutAPhotoOffersPhotos() async throws {
        let uploader = ScriptedUploader(files: store)
        let (entry, _) = try makeEntry(saving: bean(verified: false), uploader: uploader)

        await entry.save()

        let uploads = try XCTUnwrap(entry.labelPhotoUploads)
        XCTAssertTrue(uploads.photos.isEmpty)
        XCTAssertTrue(uploads.canAddPhoto)
        let runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty)
    }

    func testAVerifiedBeanTakesNoLabelPhotos() async throws {
        let uploader = ScriptedUploader(files: store)
        let (entry, _) = try makeEntry(saving: bean(verified: true), uploader: uploader)
        await entry.labelPhoto.attach(try capture())

        await entry.save()

        XCTAssertNil(entry.labelPhotoUploads)
        XCTAssertEqual(entry.labelPhoto.state, .empty)
        let runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty)
    }

    // MARK: - Files that outlive the screen

    /// Lets queued main-actor work run until `condition` holds, for at most about 2 s.
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func waitUntilStarted(_ uploader: GatedUploader) async throws {
        for _ in 0..<200 where uploader.started == 0 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(uploader.started, 1)
    }

    func testReleasingDeletesTheFilesOfPhotosThatAreNotUploading() async throws {
        let (model, _) = try makeModel([.failed, .signInRequired])
        await model.add(prepared())
        await model.add(prepared())
        await model.waitForUploads()
        XCTAssertEqual(store.files().count, 2)

        model.releaseFiles()

        XCTAssertTrue(store.files().isEmpty)
    }

    func testARunningUploadDeletesItsFileWhenItEndsAfterTheRelease() async throws {
        let uploader = GatedUploader(outcome: .failed)
        let model = try makeModel(uploader: uploader)
        await model.add(prepared())
        try await waitUntilStarted(uploader)

        model.releaseFiles()
        XCTAssertEqual(store.files().count, 1, "a running upload keeps its file")

        uploader.open()
        await model.waitForUploads()

        XCTAssertTrue(store.files().isEmpty)
    }

    func testTheFilesOfAFreedModelAreDeleted() async throws {
        let uploader = ScriptedUploader([.failed], files: store)
        var model: LabelPhotoUploadModel? = try makeModel(uploader: uploader)
        await model?.add(prepared())
        await model?.waitForUploads()
        XCTAssertEqual(store.files().count, 1)

        model = nil

        XCTAssertNil(model)
        XCTAssertTrue(store.files().isEmpty)
    }

    func testAnUploadThatOutlivesItsModelDeletesItsFile() async throws {
        let uploader = GatedUploader(outcome: .failed)
        var model: LabelPhotoUploadModel? = try makeModel(uploader: uploader)
        await model?.add(prepared())
        try await waitUntilStarted(uploader)

        model = nil
        XCTAssertNil(model)
        XCTAssertEqual(store.files().count, 1)
        uploader.open()

        try await eventually { store.files().isEmpty }
        XCTAssertTrue(store.files().isEmpty)
    }

    func testLeavingTheEntryReleasesItsPhotos() async throws {
        let uploader = ScriptedUploader([.failed], files: store)
        let (entry, _) = try makeEntry(saving: bean(verified: false), uploader: uploader)
        await entry.labelPhoto.attach(try capture())
        await entry.save()
        await entry.labelPhotoUploads?.waitForUploads()
        XCTAssertEqual(store.files().count, 1)

        entry.releaseLabelPhotos()

        XCTAssertTrue(store.files().isEmpty)
    }

    func testNobodySignedInMeansNoLabelPhotos() async throws {
        let body = try JSONEncoder().encode(bean(verified: false))
        let server = try StubServer { _ in StubResponse(status: 201, body: body, headers: ["Content-Type": "application/json"]) }
        servers.append(server)
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        let entry = BeanEntryModel(barcode: nil, client: client)
        await entry.labelPhoto.attach(try capture())

        await entry.save()

        XCTAssertNil(entry.labelPhotoUploads)
        XCTAssertEqual(entry.labelPhoto.state, .empty)
    }
}
