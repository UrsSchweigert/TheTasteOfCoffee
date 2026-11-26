import XCTest
@testable import Cupmark

/// The "remove data of other accounts" setting (M2-T30): another account's store, outbox and
/// queued label photos go; the signed-in account's and anything of another shape stay.
@MainActor
final class LocalDataRemoverTests: XCTestCase {
    private let own = AccountID(subject: AuthFixtures.subject)
    private let other = AccountID(subject: AuthFixtures.otherSubject)
    private let third = AccountID(subject: "a-third-account-on-this-device")
    private var stores = FileManager.default.temporaryDirectory.appending(path: "LocalDataTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    private var photos = LabelPhotoFixtures.temporaryDirectory()

    override func tearDown() {
        try? FileManager.default.removeItem(at: stores)
        try? FileManager.default.removeItem(at: photos)
        super.tearDown()
    }

    private var remover: LocalDataRemover {
        LocalDataRemover(storesDirectory: stores, labelPhotos: LabelPhotoFolders(root: photos))
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    /// `<stem>.store` plus `suffix`, in the stores folder.
    private func storeURL(_ account: AccountID, suffix: String = "") throws -> URL {
        stores.appending(path: try StoreLocation.fileName(for: account) + suffix, directoryHint: .notDirectory)
    }

    func testOnlyOtherAccountsStoresAndTheirSidecarFilesGo() throws {
        try FileManager.default.createDirectory(at: stores, withIntermediateDirectories: true)
        var ownFiles: [URL] = []
        var otherFiles: [URL] = []
        for suffix in ["", "-wal", "-shm"] {
            ownFiles.append(try storeURL(own, suffix: suffix))
            otherFiles.append(try storeURL(other, suffix: suffix))
            otherFiles.append(try storeURL(third, suffix: suffix))
        }
        let unrelated = stores.appending(path: "notes.txt", directoryHint: .notDirectory)
        let almostAStore = stores.appending(path: "short.store", directoryHint: .notDirectory)
        for url in ownFiles + otherFiles + [unrelated, almostAStore] {
            try Data("x".utf8).write(to: url)
        }

        XCTAssertEqual(try remover.otherAccountCount(keeping: own), 2)
        let removed = try remover.removeOtherAccounts(keeping: own)

        XCTAssertEqual(removed, 2)
        XCTAssertTrue(ownFiles.allSatisfy(exists))
        XCTAssertTrue(otherFiles.allSatisfy { !exists($0) })
        XCTAssertTrue(exists(unrelated))
        XCTAssertTrue(exists(almostAStore), "a file that is not a store file name is never touched")
        XCTAssertEqual(try remover.otherAccountCount(keeping: own), 0)
    }

    func testARealOtherStoreWithItsOutboxIsRemovedAndTheOwnStaysWhole() throws {
        let parameters = try StoreFixtures.parameters()
        do {
            let ownStore = try AccountStore.open(for: own, in: stores)
            try ownStore.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters)))
            let otherStore = try AccountStore.open(for: other, in: stores)
            try otherStore.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters)))
            XCTAssertEqual(try otherStore.outboxOperations().count, 1)
        }
        XCTAssertEqual(try remover.otherAccountCount(keeping: own), 1)

        try remover.removeOtherAccounts(keeping: own)

        XCTAssertFalse(exists(try StoreLocation.fileURL(for: other, in: stores)))
        let ownAgain = try AccountStore.open(for: own, in: stores)
        XCTAssertEqual(try ownAgain.recipes().count, 1)
        XCTAssertEqual(try ownAgain.outboxOperations().count, 1, "the signed-in account's unsent changes stay")
        // The other account, if it signs in again, starts with an empty store.
        let otherAgain = try AccountStore.open(for: other, in: stores)
        XCTAssertTrue(try otherAgain.recipes().isEmpty)
        XCTAssertTrue(try otherAgain.outboxOperations().isEmpty)
    }

    func testOtherAccountsLabelPhotosGoToo() throws {
        let folders = LabelPhotoFolders(root: photos)
        _ = try folders.store(for: own).write(LabelPhotoFixtures.jpeg)
        _ = try folders.queue(for: own).write(LabelPhotoFixtures.jpeg)
        let otherQueued = try folders.queue(for: other).write(LabelPhotoFixtures.jpeg)
        try FileManager.default.createDirectory(at: stores, withIntermediateDirectories: true)

        try remover.removeOtherAccounts(keeping: own)

        XCTAssertFalse(exists(otherQueued))
        XCTAssertFalse(exists(folders.store(for: other).directory))
        XCTAssertTrue(exists(folders.store(for: own).directory))
        XCTAssertTrue(exists(folders.queue(for: own).directory))
    }

    func testNothingToRemoveIsFine() throws {
        XCTAssertEqual(try remover.otherAccountCount(keeping: own), 0)
        XCTAssertEqual(try remover.removeOtherAccounts(keeping: own), 0)
    }

    func testTheStoreNameShapes() throws {
        let stem = try StoreLocation.fileStem(for: own)
        XCTAssertEqual(LocalDataRemover.storeStem(of: "\(stem).store"), stem)
        XCTAssertEqual(LocalDataRemover.storeStem(of: "\(stem).store-wal"), stem)
        XCTAssertEqual(LocalDataRemover.storeStem(of: "\(stem).store-shm"), stem)
        XCTAssertNil(LocalDataRemover.storeStem(of: "\(stem).sqlite"))
        XCTAssertNil(LocalDataRemover.storeStem(of: "\(stem.uppercased()).store"))
        XCTAssertNil(LocalDataRemover.storeStem(of: "\(stem.dropLast()).store"))
        XCTAssertNil(LocalDataRemover.storeStem(of: ".store"))
    }

    func testTheModelCountsAndRemoves() throws {
        try FileManager.default.createDirectory(at: stores, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: try storeURL(other))
        let model = LocalDataModel(account: own, remover: remover)

        model.reload()
        XCTAssertEqual(model.otherAccountCount, 1)
        XCTAssertEqual(model.result, .untouched)

        model.removeOtherAccounts()
        XCTAssertEqual(model.otherAccountCount, 0)
        XCTAssertEqual(model.result, .removed)
    }
}
