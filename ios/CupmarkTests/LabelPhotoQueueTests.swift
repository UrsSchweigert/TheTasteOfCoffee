import SwiftData
import XCTest
@testable import Cupmark

/// Answers the queue's runs with a script and records the jobs. Like the live uploader it
/// deletes the file on `.completed`; after `.failed` it hands back a job that got as far as the
/// S3 POST, so a resumed run can be told apart.
private actor QueueScriptedUploader: LabelPhotoUploading {
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
        case .failed, .dailyLimitReached:
            if let photoID = ResourceID(LabelPhotoFixtures.photoID(1)) {
                next.stage = .uploaded(photoID: photoID, completionUnconfirmed: true)
            }
        case .rejected, .noMorePhotos, .signInRequired:
            break
        }
        return LabelPhotoUploadResult(outcome: outcome, job: next)
    }
}

/// The label photo queue (M2-T25): photos wait in the account's store and queue folder until
/// their bean has a server id, then upload; each outcome; the job stored and resumed; and a
/// bean described offline whose photo uploads after the outbox created the bean.
@MainActor
final class LabelPhotoQueueTests: XCTestCase {
    private let root = LabelPhotoFixtures.temporaryDirectory()
    private var folders: LabelPhotoFolders { LabelPhotoFolders(root: root) }
    private var queueFiles: LabelPhotoFileStore { folders.queue(for: LabelPhotoFixtures.account) }
    private let clock = TestClock()
    /// Held for the whole test: the stub registry keeps servers weakly.
    private var servers: [FakeSyncServer] = []

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func makeQueue(_ store: AccountStore, _ uploader: QueueScriptedUploader) -> LabelPhotoQueue {
        let clock = self.clock
        return LabelPhotoQueue(
            store: store,
            account: LabelPhotoFixtures.account,
            files: queueFiles,
            uploader: uploader,
            now: { clock.now },
            jitter: { 1 }
        )
    }

    /// A bean in the store, with or without a server id.
    private func bean(in store: AccountStore, serverID: String? = LabelPhotoFixtures.beanID, verified: Bool = false) throws -> StoredBean {
        let bean = StoredBean(serverID: serverID, barcode: nil)
        bean.verified = verified
        try store.addBean(bean, syncState: serverID == nil ? .pendingCreate : .synced)
        return bean
    }

    /// A queued photo of `bean`: its file in the queue folder and its record in the store.
    private func queuePhoto(for bean: StoredBean, in store: AccountStore) throws -> URL {
        let file = try queueFiles.write(LabelPhotoFixtures.jpeg)
        store.queueLabelPhoto(fileName: file.lastPathComponent, beanLocalID: bean.localID)
        try store.save()
        return file
    }

    // MARK: - The job

    func testAJobSurvivesEncodingAtEveryStage() throws {
        let file = queueFiles.directory.appending(path: "label.jpg", directoryHint: .notDirectory)
        let photoID = try XCTUnwrap(ResourceID(LabelPhotoFixtures.photoID(2)))
        let stages: [LabelPhotoUploadJob.Stage] = [
            .notStarted,
            .issued(try LabelPhotoFixtures.upload(2)),
            .uploaded(photoID: photoID, completionUnconfirmed: true),
        ]
        for stage in stages {
            let job = LabelPhotoUploadJob(account: LabelPhotoFixtures.account, beanID: try LabelPhotoFixtures.bean(), file: file, stage: stage)
            let decoded = try JSONDecoder().decode(LabelPhotoUploadJob.self, from: JSONEncoder().encode(job))
            XCTAssertEqual(decoded, job)
        }
    }

    func testAnIDThatIsNotAContractIDDoesNotDecode() {
        XCTAssertThrowsError(try JSONDecoder().decode(ResourceID.self, from: Data(#""not-an-id""#.utf8)))
    }

    // MARK: - Running

    func testAPhotoWaitsUntilItsBeanHasAServerID() async throws {
        let store = try AccountStore.inMemory()
        let uploader = QueueScriptedUploader(files: queueFiles)
        let pending = try bean(in: store, serverID: nil)
        let file = try queuePhoto(for: pending, in: store)
        let queue = makeQueue(store, uploader)

        var outcome = await queue.run()

        XCTAssertEqual(outcome, .done)
        var runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty)
        XCTAssertEqual(try store.queuedLabelPhotos().count, 1)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(file))
        XCTAssertNil(queue.nextAttempt())

        pending.serverID = LabelPhotoFixtures.beanID
        try store.save()
        outcome = await queue.run()

        XCTAssertEqual(outcome, .done)
        runs = await uploader.runs
        XCTAssertEqual(runs.map(\.beanID.rawValue), [LabelPhotoFixtures.beanID])
        XCTAssertEqual(runs.first?.file.lastPathComponent, file.lastPathComponent)
        XCTAssertEqual(runs.first?.account, LabelPhotoFixtures.account)
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertFalse(LabelPhotoFixtures.fileExists(file))
    }

    func testAFailedRunKeepsTheJobBacksOffAndResumes() async throws {
        let store = try AccountStore.inMemory()
        let uploader = QueueScriptedUploader([.failed], files: queueFiles)
        let file = try queuePhoto(for: try bean(in: store), in: store)
        let queue = makeQueue(store, uploader)

        _ = await queue.run()

        let photo = try XCTUnwrap(store.queuedLabelPhotos().first)
        XCTAssertEqual(photo.attemptCount, 1)
        XCTAssertEqual(photo.nextAttemptAt, clock.now.addingTimeInterval(SyncBackoff().delay(afterAttempt: 1, jitter: 1)))
        XCTAssertEqual(queue.nextAttempt(), photo.nextAttemptAt)
        XCTAssertNotNil(photo.jobData)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(file))

        // Not before the wait.
        _ = await queue.run()
        var runs = await uploader.runs
        XCTAssertEqual(runs.count, 1)

        clock.advance(60)
        _ = await queue.run()

        runs = await uploader.runs
        XCTAssertEqual(runs.count, 2)
        // Resumed where the failed run stopped: after the S3 POST.
        let photoID = try XCTUnwrap(ResourceID(LabelPhotoFixtures.photoID(1)))
        XCTAssertEqual(runs.last?.stage, .uploaded(photoID: photoID, completionUnconfirmed: true))
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
    }

    func testARejectedOrRefusedPhotoLeavesTheQueueWithItsFile() async throws {
        for outcome in [LabelPhotoUploadOutcome.rejected, .noMorePhotos] {
            let store = try AccountStore.inMemory()
            let uploader = QueueScriptedUploader([outcome], files: queueFiles)
            let file = try queuePhoto(for: try bean(in: store), in: store)

            _ = await makeQueue(store, uploader).run()

            XCTAssertTrue(try store.queuedLabelPhotos().isEmpty, "\(outcome)")
            XCTAssertFalse(LabelPhotoFixtures.fileExists(file), "\(outcome)")
        }
    }

    func testTheDailyCapWaitsAndKeepsThePhoto() async throws {
        let store = try AccountStore.inMemory()
        let uploader = QueueScriptedUploader([.dailyLimitReached], files: queueFiles)
        let file = try queuePhoto(for: try bean(in: store), in: store)

        _ = await makeQueue(store, uploader).run()

        let photo = try XCTUnwrap(store.queuedLabelPhotos().first)
        XCTAssertEqual(photo.nextAttemptAt, clock.now.addingTimeInterval(LabelPhotoQueue.limitWait))
        XCTAssertTrue(LabelPhotoFixtures.fileExists(file))
    }

    func testSignInRequiredStopsTheRunAndKeepsThePhoto() async throws {
        let store = try AccountStore.inMemory()
        let uploader = QueueScriptedUploader([.signInRequired], files: queueFiles)
        let file = try queuePhoto(for: try bean(in: store), in: store)

        let outcome = await makeQueue(store, uploader).run()

        XCTAssertEqual(outcome, .signInRequired)
        let photo = try XCTUnwrap(store.queuedLabelPhotos().first)
        XCTAssertEqual(photo.attemptCount, 0)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(file))
    }

    func testAVerifiedOrMissingBeanDropsItsPhotos() async throws {
        let store = try AccountStore.inMemory()
        let uploader = QueueScriptedUploader(files: queueFiles)
        let verified = try queuePhoto(for: try bean(in: store, verified: true), in: store)
        let gone = try queueFiles.write(LabelPhotoFixtures.jpeg)
        store.queueLabelPhoto(fileName: gone.lastPathComponent, beanLocalID: UUID())
        try store.save()

        _ = await makeQueue(store, uploader).run()

        let runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty)
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertFalse(LabelPhotoFixtures.fileExists(verified))
        XCTAssertFalse(LabelPhotoFixtures.fileExists(gone))
    }

    // MARK: - Offline entry to upload

    func testAPhotoTakenOfflineUploadsOnceTheOutboxCreatedTheBean() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        servers.append(server)
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let photoAccount = LabelPhotoFixtures.photoAccount(files: folders.store(for: LabelPhotoFixtures.account))
        let entry = BeanEntryModel(barcode: nil, client: server.client(), labelPhotos: photoAccount, offlineStore: store)
        await entry.labelPhoto.attach(LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 40, height: 20), orientation: .up))
        XCTAssertNotNil(entry.labelPhoto.photo)

        await entry.save()

        guard case .savedOffline(let beanID) = entry.state else {
            return XCTFail("expected the bean to be saved on the device, got \(entry.state)")
        }
        let queued = try XCTUnwrap(store.queuedLabelPhotos().first)
        XCTAssertEqual(queued.beanLocalID, beanID)
        XCTAssertEqual(queueFiles.files().map(\.lastPathComponent), [queued.fileName])
        XCTAssertEqual(entry.labelPhoto.state, .empty)
        XCTAssertNil(entry.labelPhotoUploads)

        let uploader = QueueScriptedUploader(files: queueFiles)
        let queue = makeQueue(store, uploader)
        _ = await queue.run()
        var runs = await uploader.runs
        XCTAssertTrue(runs.isEmpty, "no upload before the bean has a server id")

        server.backend.setOverride(nil)
        let clock = self.clock
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })
        let drained = await engine.drain()
        XCTAssertEqual(drained, .idle)
        let serverID = try XCTUnwrap(store.bean(localID: beanID)?.serverID)

        _ = await queue.run()

        runs = await uploader.runs
        XCTAssertEqual(runs.map(\.beanID.rawValue), [serverID])
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertTrue(queueFiles.files().isEmpty)
    }

    func testMergingAPendingBeanIntoTheSameCatalogueBeanKeepsItsPhotos() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        servers.append(server)
        let catalogue = API.Bean(
            beanId: LabelPhotoFixtures.beanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: "4006381333931",
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(),
            operatorAttributes: API.BeanAttributes()
        )
        server.backend.seed(bean: catalogue)
        // A pending scan with a queued photo, and then the catalogue bean of the same barcode
        // cached on the device (by another flow) before the outbox looked the scan up.
        let barcode = try XCTUnwrap(CanonicalBarcode("4006381333931"))
        let pending = try store.pendingBean(barcode: barcode)
        let file = try queuePhoto(for: pending, in: store)
        // Read now: the engine deletes the pending bean.
        let pendingID = pending.localID
        let cached = StoredBean(catalogue)
        try store.addBean(cached, syncState: .synced)

        let clock = self.clock
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })
        _ = await engine.drain()

        XCTAssertNil(try store.bean(localID: pendingID))
        XCTAssertEqual(try store.queuedLabelPhotos().first?.beanLocalID, cached.localID)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(file))
    }
}
