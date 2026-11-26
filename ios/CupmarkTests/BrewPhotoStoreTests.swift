import CoreGraphics
import ImageIO
import SwiftData
import XCTest
@testable import Cupmark

/// Brew photos on the device (M2-T42, ADR 0033): the record and its file, the limit of 6, a
/// failed save, deleting one photo, every path that removes a brew, the sweep at store open,
/// the folder per account, a missing file, and the metadata the stored file does not carry.
///
/// Every folder is a temporary one, never the app's own. Every `StubServer` is kept by the test
/// (`servers`, or a `FakeSyncServer` local read after its last request), since the stub
/// registry holds servers weakly. Photos are added at fixed dates.
@MainActor
final class BrewPhotoStoreTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()
    private let account = AccountID(subject: "brew-photo-tests-account")
    private let other = AccountID(subject: "brew-photo-tests-other-account")
    private var servers: [StubServer] = []

    private var folders: BrewPhotoFolders {
        BrewPhotoFolders(root: root.appending(path: "BrewPhotos", directoryHint: .isDirectory))
    }

    private var files: BrewPhotoFileStore {
        folders.files(for: account)
    }

    override func tearDown() {
        servers = []
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private struct SaveRefused: Error {}

    private func makeStore() throws -> AccountStore {
        try AccountStore.inMemory(brewPhotoFiles: files)
    }

    private func id(_ n: Int) -> String {
        FakeSyncBackend.id(n)
    }

    /// The names of the photo files in the account's folder, sorted.
    private func storedNames() -> [String] {
        BrewPhotoFixtures.names(in: files)
    }

    private func photoCount(_ store: AccountStore) throws -> Int {
        try store.context.fetch(FetchDescriptor<StoredBrewPhoto>()).count
    }

    // MARK: - Add and read

    func testAPhotoIsAFileInTheAccountsFolderAndARecordThatNamesItsBrew() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        let queuedBefore = try store.outboxOperations().count

        let photo = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))

        XCTAssertEqual(photo.brewLocalID, brew.localID)
        XCTAssertEqual(photo.createdAt, BrewPhotoFixtures.at(minute: 1))
        XCTAssertTrue(BrewPhotoFileStore.isPhotoFileName(photo.fileName))
        XCTAssertEqual(storedNames(), [photo.fileName], "one file, no temporary file left")
        let url = try store.brewPhotoFileURL(of: photo)
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL.pathComponents, files.directory.standardizedFileURL.pathComponents)
        XCTAssertEqual(try Data(contentsOf: url), jpeg.data)
        XCTAssertEqual(try store.brewPhotos(of: brew).map(\.localID), [photo.localID])
        // Device only: nothing is queued for the server, and the brew is unchanged.
        XCTAssertEqual(try store.outboxOperations().count, queuedBefore)
        XCTAssertEqual(brew.syncState, .synced)
    }

    func testPhotosListNewestFirstForTheBrewAndForTheAccount() throws {
        let store = try makeStore()
        let first = try BrewPhotoFixtures.brew(in: store)
        let second = try BrewPhotoFixtures.brew(in: store, entry: first.shelfEntry, serverID: id(31), minute: 5)
        let jpeg = try BrewPhotoFixtures.photo()
        let a = try store.addBrewPhoto(to: first, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        let b = try store.addBrewPhoto(to: second, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 3))
        let c = try store.addBrewPhoto(to: first, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 2))

        XCTAssertEqual(try store.brewPhotos(of: first).map(\.localID), [c.localID, a.localID])
        XCTAssertEqual(try store.brewPhotos(of: second).map(\.localID), [b.localID])
        XCTAssertEqual(try store.allBrewPhotos().map(\.localID), [b.localID, c.localID, a.localID])
        XCTAssertEqual(try store.brewPhoto(localID: c.localID)?.fileName, c.fileName)
    }

    func testASeventhPhotoIsRefusedAndWritesNoFileAndNoRecord() throws {
        XCTAssertEqual(BrewPhotoLimits.maxPerBrew, 6)
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        for minute in 0..<BrewPhotoLimits.maxPerBrew {
            try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: minute))
        }
        let namesBefore = storedNames()
        XCTAssertEqual(namesBefore.count, 6)

        XCTAssertThrowsError(try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 10))) { error in
            XCTAssertEqual(error as? BrewPhotoError, .limitReached)
        }

        XCTAssertEqual(storedNames(), namesBefore)
        XCTAssertEqual(try store.brewPhotos(of: brew).count, 6)
        XCTAssertFalse(store.context.hasChanges)
        // The limit is per brew: another brew still takes one.
        let other = try BrewPhotoFixtures.brew(in: store, entry: brew.shelfEntry, serverID: id(32), minute: 1)
        XCTAssertNoThrow(try store.addBrewPhoto(to: other, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 11)))
        // Deleting one makes room again.
        let oldest = try XCTUnwrap(try store.brewPhotos(of: brew).last)
        try store.deleteBrewPhoto(oldest)
        XCTAssertNoThrow(try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 12)))
        XCTAssertEqual(try store.brewPhotos(of: brew).count, 6)
    }

    func testAFailedSaveDeletesTheFileItWroteAndLeavesNoRecord() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        store.willSave = { throw SaveRefused() }

        XCTAssertThrowsError(try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))) { error in
            XCTAssertTrue(error is SaveRefused)
        }

        XCTAssertEqual(storedNames(), [], "the file written before the record is gone")
        XCTAssertEqual(try photoCount(store), 0)
        XCTAssertFalse(store.context.hasChanges)

        store.willSave = nil
        let photo = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 2))
        XCTAssertEqual(storedNames(), [photo.fileName])
    }

    func testAPhotoIsOnlyAddedToALiveBrewOfThisStoreWithAFolder() throws {
        let jpeg = try BrewPhotoFixtures.photo()
        let withoutFolder = try AccountStore.inMemory()
        let brewWithoutFolder = try BrewPhotoFixtures.brew(in: withoutFolder)
        XCTAssertThrowsError(try withoutFolder.addBrewPhoto(to: brewWithoutFolder, jpeg: jpeg, createdAt: BrewPhotoFixtures.start)) { error in
            XCTAssertEqual(error as? BrewPhotoError, .noPhotoFolder)
        }

        let store = try makeStore()
        let elsewhere = try AccountStore.inMemory()
        let foreign = try BrewPhotoFixtures.brew(in: elsewhere)
        XCTAssertThrowsError(try store.addBrewPhoto(to: foreign, jpeg: jpeg, createdAt: BrewPhotoFixtures.start)) { error in
            XCTAssertEqual(error as? BrewPhotoError, .brewNotFound)
        }

        let removed = try BrewPhotoFixtures.brew(in: store)
        try store.markDeleted(removed)
        XCTAssertEqual(removed.syncState, .pendingDelete)
        XCTAssertThrowsError(try store.addBrewPhoto(to: removed, jpeg: jpeg, createdAt: BrewPhotoFixtures.start)) { error in
            XCTAssertEqual(error as? BrewPhotoError, .brewNotFound)
        }
        XCTAssertEqual(storedNames(), [])
        XCTAssertEqual(try photoCount(store), 0)
    }

    // MARK: - Delete one photo

    func testDeletingAPhotoDeletesItsRecordAndFileAndNothingElse() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        let kept = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        let deleted = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 2))
        let deletedID = deleted.localID
        let keptName = kept.fileName

        try store.deleteBrewPhoto(deleted)

        XCTAssertNil(try store.brewPhoto(localID: deletedID))
        XCTAssertEqual(storedNames(), [keptName])
        XCTAssertEqual(try store.brewPhotos(of: brew).map(\.fileName), [keptName])
        XCTAssertNotNil(try store.brew(localID: brew.localID), "the brew stays")
        XCTAssertEqual(brew.syncState, .synced)
        // Again: already gone, nothing changes.
        XCTAssertNoThrow(try store.deleteBrewPhoto(localID: deletedID))
        XCTAssertEqual(storedNames(), [keptName])
    }

    func testAFailedDeleteKeepsTheRecordAndTheFileAlsoAfterALaterSave() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let photo = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 1))
        let photoID = photo.localID
        let name = photo.fileName
        store.willSave = { throw SaveRefused() }

        XCTAssertThrowsError(try store.deleteBrewPhoto(photo))

        store.willSave = nil
        XCTAssertEqual(try store.brewPhoto(localID: photoID)?.fileName, name)
        XCTAssertEqual(storedNames(), [name])
        // The failed delete's file is not deleted by the next, unrelated save.
        try store.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
        XCTAssertEqual(storedNames(), [name])
        XCTAssertNoThrow(try store.brewPhotoFileURL(of: photo))
    }

    // MARK: - Missing files and names

    func testAPhotoWhoseFileIsMissingIsReportedAndCanStillBeDeleted() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let photo = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 1))
        try FileManager.default.removeItem(at: try store.brewPhotoFileURL(of: photo))

        XCTAssertThrowsError(try store.brewPhotoFileURL(of: photo)) { error in
            XCTAssertEqual(error as? BrewPhotoError, .fileMissing)
        }
        XCTAssertEqual(try store.brewPhotos(of: brew).count, 1, "the record is listed, so the user can delete it")

        try store.deleteBrewPhoto(photo)
        XCTAssertEqual(try photoCount(store), 0)
    }

    func testOnlyPhotoFileNamesBecomePathsInsideTheFolder() throws {
        let valid = "\(UUID().uuidString).jpg"
        XCTAssertTrue(BrewPhotoFileStore.isPhotoFileName(valid))
        for name in ["../\(valid)", "\(valid)/..", "/\(valid)", valid.lowercased(), "photo.jpg", "\(UUID().uuidString).jpeg", "\(UUID().uuidString).jpg.partial", ".\(UUID().uuidString).partial", ""] {
            XCTAssertFalse(BrewPhotoFileStore.isPhotoFileName(name), name)
            XCTAssertNil(files.url(of: name), name)
        }
        // A record with a name that is not a photo file name reads as missing, and deleting it
        // touches nothing outside the folder.
        let outside = root.appending(path: "outside.jpg", directoryHint: .notDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data([0xFF, 0xD8]).write(to: outside)
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let bad = StoredBrewPhoto(brewLocalID: brew.localID, fileName: "../../outside.jpg", createdAt: BrewPhotoFixtures.start)
        store.context.insert(bad)
        try store.save()

        XCTAssertThrowsError(try store.brewPhotoFileURL(of: bad)) { error in
            XCTAssertEqual(error as? BrewPhotoError, .fileMissing)
        }
        try store.deleteBrewPhoto(bad)
        XCTAssertTrue(BrewPhotoFixtures.exists(outside))
    }

    func testEachAccountHasItsOwnFolderNamedByItsAccountID() throws {
        let mine = folders.files(for: account).directory
        let theirs = folders.files(for: other).directory
        XCTAssertNotEqual(mine, theirs)
        XCTAssertEqual(mine.lastPathComponent, account.rawValue)
        XCTAssertEqual(mine.deletingLastPathComponent().standardizedFileURL.pathComponents, folders.root.standardizedFileURL.pathComponents)
        XCTAssertEqual(BrewPhotoFolders.standard.root.lastPathComponent, "BrewPhotos")
        XCTAssertEqual(
            BrewPhotoFolders.standard.root.deletingLastPathComponent().standardizedFileURL.pathComponents,
            LabelPhotoFolders.standard.root.deletingLastPathComponent().standardizedFileURL.pathComponents,
            "next to LabelPhotos, in Application Support"
        )

        let stores = root.appending(path: "Accounts", directoryHint: .isDirectory)
        let opened = try AccountStore.open(for: account, in: stores, brewPhotos: folders)
        XCTAssertEqual(opened.brewPhotoFiles?.directory, mine)
        // A store account whose id is not an `AccountID` gets no folder, so no id can name a path.
        let odd = try AccountStore.open(for: StoreAccountID(stableID: "../not-an-account"), in: stores, brewPhotos: folders)
        XCTAssertNil(odd.brewPhotoFiles)
    }

    // MARK: - Removing a brew removes its photos

    /// A brew of `store` with two photos, and another brew with one that must stay.
    private func brewsWithPhotos(_ store: AccountStore, brew: StoredBrew) throws -> (names: [String], keptName: String) {
        let jpeg = try BrewPhotoFixtures.photo()
        let first = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        let second = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 2))
        let bystander = try BrewPhotoFixtures.brew(in: store, entry: brew.shelfEntry, serverID: id(77), minute: 9)
        let kept = try store.addBrewPhoto(to: bystander, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 3))
        return ([first.fileName, second.fileName], kept.fileName)
    }

    private func assertOnlyKept(_ keptName: String, in store: AccountStore, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(storedNames(), [keptName], "only the other brew's file is left", file: file, line: line)
        XCTAssertEqual(try store.allBrewPhotos().map(\.fileName), [keptName], "only the other brew's record is left", file: file, line: line)
    }

    func testTheUsersDeleteOfABrewTheServerNeverHadDeletesItsPhotos() throws {
        let store = try makeStore()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try BrewPhotoFixtures.brew(in: store, entry: entry, serverID: nil)
        let brewID = brew.localID
        let photos = try brewsWithPhotos(store, brew: brew)
        XCTAssertEqual(storedNames().count, 3)

        try store.markDeleted(brew)

        XCTAssertNil(try store.brew(localID: brewID), "removed at once")
        try assertOnlyKept(photos.keptName, in: store)
    }

    func testTheUsersDeleteOfASyncedBrewDeletesItsPhotosAtOnce() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let photos = try brewsWithPhotos(store, brew: brew)

        try store.markDeleted(brew)

        XCTAssertEqual(brew.syncState, .pendingDelete, "kept, hidden, until the server answers the delete")
        try assertOnlyKept(photos.keptName, in: store)
    }

    func testAFailedDeleteOfABrewKeepsItsPhotos() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let photos = try brewsWithPhotos(store, brew: brew)
        store.willSave = { throw SaveRefused() }

        XCTAssertThrowsError(try store.markDeleted(brew))

        store.willSave = nil
        XCTAssertEqual(brew.syncState, .synced)
        XCTAssertEqual(Set(try store.brewPhotos(of: brew).map(\.fileName)), Set(photos.names))
        XCTAssertEqual(storedNames(), (photos.names + [photos.keptName]).sorted())
    }

    func testTheEngineRemovingABrewDeletedOnAnotherDeviceDeletesItsPhotos() async throws {
        let store = try makeStore()
        let server = try FakeSyncServer()
        let bean = API.Bean(
            beanId: id(901), vocabularyVersion: Vocabulary.version, verified: true, barcode: nil,
            openFoodFactsMatch: false, openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(), operatorAttributes: API.BeanAttributes()
        )
        var entryValues = try StoreFixtures.shelfEntryInput()
        entryValues.beanId = id(901)
        server.backend.seed(bean: bean)
        server.backend.seed(shelfEntry: id(902), entryValues)
        let localBean = StoredBean(bean)
        try store.addBean(localBean, syncState: .synced)
        let entry = StoredShelfEntry(entryValues, serverID: id(902))
        try store.addShelfEntry(entry, bean: localBean, syncState: .synced)
        // Deleted on another device (the server does not have it), edited here.
        let brew = try BrewPhotoFixtures.brew(in: store, entry: entry, serverID: id(703))
        let brewID = brew.localID
        let photos = try brewsWithPhotos(store, brew: brew)
        brew.waterG = 320
        try store.markUpdated(brew)
        let engine = SyncEngine(store: store, client: server.client(), now: { BrewPhotoFixtures.start }, jitter: { 1 }, sleep: { _ in })

        let result = await engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(server.log, ["PUT /brews/\(id(703))", "GET /brews/\(id(703))"])
        XCTAssertNil(try store.brew(localID: brewID))
        try assertOnlyKept(photos.keptName, in: store)
    }

    func testAPullThatDropsABrewDeletedOnAnotherDeviceDeletesItsPhotos() async throws {
        let store = try makeStore()
        let server = try FakeSyncServer()
        let bean = API.Bean(
            beanId: id(901), vocabularyVersion: Vocabulary.version, verified: true, barcode: nil,
            openFoodFactsMatch: false, openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(), operatorAttributes: API.BeanAttributes()
        )
        var entryValues = try StoreFixtures.shelfEntryInput()
        entryValues.beanId = id(901)
        server.backend.seed(bean: bean)
        server.backend.seed(shelfEntry: id(902), entryValues)
        let localBean = StoredBean(bean)
        try store.addBean(localBean, syncState: .synced)
        let entry = StoredShelfEntry(entryValues, serverID: id(902))
        try store.addShelfEntry(entry, bean: localBean, syncState: .synced)
        let brew = try BrewPhotoFixtures.brew(in: store, entry: entry, serverID: id(10))
        let brewID = brew.localID
        let photos = try brewsWithPhotos(store, brew: brew)
        // The server has the other brew, not this one any more.
        let kept = try XCTUnwrap(try store.brew(serverID: id(77)))
        server.backend.seed(brew: id(77), try kept.apiInput())

        let result = await Puller(store: store, client: server.client()).pull()

        guard case .completed(let report) = result else {
            return XCTFail("the pull did not complete: \(result)")
        }
        XCTAssertEqual(report.removed, 1)
        XCTAssertNil(try store.brew(localID: brewID))
        XCTAssertNotNil(try store.brew(serverID: id(77)))
        try assertOnlyKept(photos.keptName, in: store)
        XCTAssertFalse(server.log.isEmpty)
    }

    func testDiscardingARejectedBrewCreateDeletesTheBrewAndItsPhotos() async throws {
        let store = try makeStore()
        let server = try FakeSyncServer()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        server.backend.setOverride { request in
            request.method == "POST" && request.path == "/brews" ? StubResponse(status: 400) : nil
        }
        let brew = try BrewPhotoFixtures.brew(in: store, entry: entry, serverID: nil)
        let brewID = brew.localID
        let engine = SyncEngine(store: store, client: server.client(), now: { BrewPhotoFixtures.start }, jitter: { 1 }, sleep: { _ in })
        let drained = await engine.drain()
        XCTAssertEqual(drained, .idle)
        XCTAssertEqual(brew.syncIssue, .rejected)
        let photos = try brewsWithPhotos(store, brew: brew)
        let issue = try XCTUnwrap(try store.syncIssues().first { item in item.localID == brewID })
        XCTAssertTrue(issue.allowsDiscard)

        try store.discard(issue)

        XCTAssertNil(try store.brew(localID: brewID))
        try assertOnlyKept(photos.keptName, in: store)
        XCTAssertEqual(server.log.filter { line in line == "POST /brews" }.count, 1)
    }

    // MARK: - Sweep

    func testTheSweepDeletesTheRecordsOfRemovedBrewsWithTheirFiles() throws {
        let store = try makeStore()
        let live = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        let kept = try store.addBrewPhoto(to: live, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        // A record whose brew is gone (an app ended between two saves of an older build, a
        // brew removed by a path that missed it), and one of a brew the user removed.
        let goneName = try files.write(jpeg)
        store.context.insert(StoredBrewPhoto(brewLocalID: UUID(), fileName: goneName, createdAt: BrewPhotoFixtures.at(minute: 2)))
        let removed = try BrewPhotoFixtures.brew(in: store, entry: live.shelfEntry, serverID: id(40), minute: 3)
        try store.markDeleted(removed)
        let removedName = try files.write(jpeg)
        store.context.insert(StoredBrewPhoto(brewLocalID: removed.localID, fileName: removedName, createdAt: BrewPhotoFixtures.at(minute: 3)))
        try store.save()
        XCTAssertEqual(storedNames().count, 3)

        let sweep = store.sweepBrewPhotos()

        XCTAssertEqual(sweep, BrewPhotoSweep(recordsRemoved: 2, filesRemoved: 0))
        XCTAssertEqual(try store.allBrewPhotos().map(\.localID), [kept.localID])
        XCTAssertEqual(storedNames(), [kept.fileName])
        XCTAssertEqual(store.sweepBrewPhotos(), BrewPhotoSweep(), "a second sweep finds nothing")
    }

    func testTheSweepDeletesFilesNoRecordListsAndKeepsListedOnes() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        let kept = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        // A file whose record never reached the store, a temporary file of a write that was cut
        // short, and anything else in the folder.
        _ = try files.write(jpeg)
        try jpeg.data.write(to: files.directory.appending(path: ".\(UUID().uuidString)\(BrewPhotoFileStore.temporarySuffix)", directoryHint: .notDirectory))
        try Data("x".utf8).write(to: files.directory.appending(path: "stray.txt", directoryHint: .notDirectory))
        XCTAssertEqual(storedNames().count, 4)

        let sweep = store.sweepBrewPhotos()

        XCTAssertEqual(sweep, BrewPhotoSweep(recordsRemoved: 0, filesRemoved: 3))
        XCTAssertEqual(storedNames(), [kept.fileName])
        XCTAssertNoThrow(try store.brewPhotoFileURL(of: kept))
    }

    func testTheSweepOfAStoreWithoutPhotosOrFolderChangesNothing() throws {
        XCTAssertEqual(try AccountStore.inMemory().sweepBrewPhotos(), BrewPhotoSweep())
        let store = try makeStore()
        _ = try BrewPhotoFixtures.brew(in: store)
        XCTAssertEqual(store.sweepBrewPhotos(), BrewPhotoSweep())
        XCTAssertFalse(BrewPhotoFixtures.exists(files.directory), "the sweep creates no folder")
    }

    /// A host whose engine waits and whose stores come from `makeStore`.
    private func makeHost(makeStore: @escaping @MainActor @Sendable (AccountID) throws -> AccountStore) throws -> SyncHost {
        let server = try StubServer { _ in StubResponse(status: 500) }
        servers.append(server)
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        return SyncHost(
            makeStore: makeStore,
            makeEngine: { _, store in SyncEngine(store: store, client: client, sleep: { _ in try await Task.sleep(for: .seconds(3600)) }) },
            labelPhotos: LabelPhotoFolders(root: root.appending(path: "LabelPhotos", directoryHint: .isDirectory))
        )
    }

    func testOpeningTheStoreSweepsItsPhotos() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let jpeg = try BrewPhotoFixtures.photo()
        let kept = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))
        let orphan = try files.write(jpeg)
        store.context.insert(StoredBrewPhoto(brewLocalID: UUID(), fileName: try files.write(jpeg), createdAt: BrewPhotoFixtures.at(minute: 2)))
        try store.save()
        XCTAssertEqual(storedNames().count, 3)
        let host = try makeHost { _ in store }

        host.switchTo(account)

        XCTAssertEqual(storedNames(), [kept.fileName])
        XCTAssertFalse(storedNames().contains(orphan))
        XCTAssertEqual(try store.allBrewPhotos().map(\.localID), [kept.localID])
        host.switchTo(nil)
    }

    func testSigningOutAndAnotherAccountsSignInKeepThePhotosWithTheStore() throws {
        let stores = root.appending(path: "Accounts", directoryHint: .isDirectory)
        let folders = self.folders
        let host = try makeHost { account in try AccountStore.open(for: account, in: stores, brewPhotos: folders) }
        host.switchTo(account)
        var name = ""
        do {
            let store = try XCTUnwrap(host.store)
            let brew = try BrewPhotoFixtures.brew(in: store)
            name = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 1)).fileName
        }

        host.switchTo(nil)
        XCTAssertEqual(storedNames(), [name], "a sign-out keeps the photos, as it keeps the store")
        host.switchTo(other)
        XCTAssertEqual(storedNames(), [name], "another account's sign-in does not touch them")
        host.switchTo(account)

        let reopened = try XCTUnwrap(host.store)
        XCTAssertEqual(try reopened.allBrewPhotos().map(\.fileName), [name])
        XCTAssertEqual(storedNames(), [name])
        host.switchTo(nil)
    }

    // MARK: - Metadata and size

    func testTheStoredFileCarriesNoEXIFGPSOrTIFFAndIsUpright() async throws {
        let input = try LabelPhotoEncoderTests.jpegWithMetadata(try LabelPhotoEncoderTests.quadrantImage(width: 400, height: 200), orientation: 6)
        let inputProperties = try LabelPhotoEncoderTests.properties(of: input)
        XCTAssertNotNil(inputProperties[kCGImagePropertyExifDictionary as String], "the fixture has EXIF")
        XCTAssertNotNil(inputProperties[kCGImagePropertyGPSDictionary as String], "the fixture has GPS")
        XCTAssertNotNil(inputProperties[kCGImagePropertyTIFFDictionary as String], "the fixture has TIFF")
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)

        let jpeg = try await BrewPhotoEncoder.encodeInBackground(input)
        let photo = try store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: BrewPhotoFixtures.at(minute: 1))

        let stored = try Data(contentsOf: try store.brewPhotoFileURL(of: photo))
        try LabelPhotoEncoderTests.assertNoMetadata(in: stored)
        // Orientation 6 is applied to the pixels: 400 × 200 stored is 200 × 400 upright.
        let decoded = try LabelPhotoEncoderTests.decode(stored)
        XCTAssertEqual(decoded.width, 200)
        XCTAssertEqual(decoded.height, 400)
    }

    func testTheLocalLimitsAreSmallerThanTheUploadLimitsAndApply() throws {
        let local = BrewPhotoLimits.encoding
        let upload = LabelPhotoEncoder.Limits.upload
        XCTAssertLessThan(local.maxPixelSize, upload.maxPixelSize)
        XCTAssertLessThan(local.maxBytes, upload.maxBytes)
        XCTAssertEqual(local.maxPixelSize, 2048)
        XCTAssertEqual(local.maxBytes, 2 * 1024 * 1024)

        let photo = try BrewPhotoEncoder.encode(try LabelPhotoEncoderTests.quadrantImage(width: 4032, height: 3024), orientation: .up)

        XCTAssertEqual(photo.pixelWidth, 2048)
        XCTAssertEqual(photo.pixelHeight, 1536)
        XCTAssertLessThanOrEqual(photo.data.count, local.maxBytes)
        XCTAssertThrowsError(try BrewPhotoEncoder.encode(Data("not an image".utf8))) { error in
            XCTAssertEqual(error as? LabelPhotoEncodingError, .unreadableImage)
        }
    }
}
