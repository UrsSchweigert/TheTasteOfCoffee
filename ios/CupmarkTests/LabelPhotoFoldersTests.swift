import XCTest
@testable import Cupmark

private struct NoStore: Error {}

/// `LabelPhotoFolders` (M2-T24): one folder per account, deleted when the account's session
/// ends, and only the signed-in account's folder kept at a sign-in; and `SyncHost` applying
/// that on every account change.
@MainActor
final class LabelPhotoFoldersTests: XCTestCase {
    private let root = LabelPhotoFixtures.temporaryDirectory()
    private var folders: LabelPhotoFolders { LabelPhotoFolders(root: root) }
    private let account = LabelPhotoFixtures.account
    private let other = LabelPhotoFixtures.otherAccount

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    /// A host without a store, so no engine runs; only the account changes matter here.
    private func makeHost() throws -> SyncHost {
        let server = try StubServer { _ in StubResponse(status: 500) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        return SyncHost(
            makeStore: { _ in throw NoStore() },
            makeEngine: { _, store in SyncEngine(store: store, client: client, sleep: { _ in }) },
            labelPhotos: folders
        )
    }

    private func write(for account: AccountID) throws -> URL {
        try folders.store(for: account).write(LabelPhotoFixtures.jpeg)
    }

    func testEachAccountHasItsOwnFolder() {
        let mine = folders.store(for: account).directory
        let theirs = folders.store(for: other).directory

        XCTAssertNotEqual(mine, theirs)
        XCTAssertEqual(mine.lastPathComponent, account.rawValue)
        XCTAssertEqual(mine.deletingLastPathComponent().standardizedFileURL.pathComponents, root.standardizedFileURL.pathComponents)
    }

    func testRemovingAnAccountsFolderLeavesTheOthers() throws {
        let mine = try write(for: account)
        let theirs = try write(for: other)

        folders.removeFolder(of: account)

        XCTAssertFalse(LabelPhotoFixtures.fileExists(mine))
        XCTAssertTrue(LabelPhotoFixtures.fileExists(theirs))
    }

    func testASignInKeepsOnlyTheAccountsFreshFiles() throws {
        let fresh = try write(for: account)
        let stale = try write(for: account)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-LabelPhotoFileStore.staleAge - 60)],
            ofItemAtPath: stale.path(percentEncoded: false)
        )
        let theirs = try write(for: other)

        folders.signedIn(as: account)

        XCTAssertTrue(LabelPhotoFixtures.fileExists(fresh))
        XCTAssertFalse(LabelPhotoFixtures.fileExists(stale))
        XCTAssertFalse(LabelPhotoFixtures.fileExists(theirs))
    }

    func testSignOutRemovesTheAccountsFolderAndNoOther() throws {
        let host = try makeHost()
        host.switchTo(account)
        let mine = try write(for: account)
        let theirs = try write(for: other)

        host.switchTo(nil)

        XCTAssertFalse(LabelPhotoFixtures.fileExists(mine))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folders.store(for: account).directory.path(percentEncoded: false)))
        XCTAssertTrue(LabelPhotoFixtures.fileExists(theirs))
    }

    func testSwitchingAccountsRemovesThePreviousAccountsFolder() throws {
        let host = try makeHost()
        host.switchTo(account)
        let mine = try write(for: account)

        host.switchTo(other)
        let theirs = try write(for: other)

        XCTAssertFalse(LabelPhotoFixtures.fileExists(mine))
        XCTAssertTrue(LabelPhotoFixtures.fileExists(theirs))
    }

    func testAppStartRemovesFoldersLeftByAnotherAccount() throws {
        // The app was ended before the last sign-out reached the host.
        let leftOver = try write(for: other)
        let mine = try write(for: account)
        let host = try makeHost()

        host.switchTo(account)

        XCTAssertFalse(LabelPhotoFixtures.fileExists(leftOver))
        XCTAssertTrue(LabelPhotoFixtures.fileExists(mine))
    }
}
