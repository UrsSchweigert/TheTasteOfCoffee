import SwiftData
import XCTest
@testable import Cupmark

/// One store per account, in a file named from a hash of the account's `sub` (ADR 0020).
final class StoreLocationTests: XCTestCase {
    private var directory: URL?

    override func tearDownWithError() throws {
        if let directory {
            try? FileManager.default.removeItem(at: directory)
        }
        directory = nil
        try super.tearDownWithError()
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "StoreLocationTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        directory = url
        return url
    }

    func testTheFileNameIsTheSHA256HexOfTheStableID() throws {
        // SHA-256 of "abc" (FIPS 180-2, appendix B.1).
        XCTAssertEqual(
            try StoreLocation.fileName(for: StoreAccountID(stableID: "abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.store"
        )
    }

    func testTheFileNameNeverHoldsTheSub() throws {
        let sub = "3f1c2a9e-7b4d-4c1e-9a55-0d6e2b8f4a17"
        let name = try StoreLocation.fileName(for: StoreAccountID(stableID: sub))
        XCTAssertFalse(name.contains(sub))
        XCTAssertFalse(name.contains("3f1c2a9e"))
        let stem = try StoreLocation.fileStem(for: StoreAccountID(stableID: sub))
        XCTAssertEqual(stem.count, 64)
        XCTAssertTrue(stem.allSatisfy { character in character.isHexDigit && !character.isUppercase })
        XCTAssertEqual(name, "\(stem).store")
    }

    func testEachAccountHasItsOwnFileAndTheSameAccountAlwaysTheSame() throws {
        let first = StoreAccountID(stableID: "11111111-1111-1111-1111-111111111111")
        let second = StoreAccountID(stableID: "22222222-2222-2222-2222-222222222222")
        XCTAssertNotEqual(try StoreLocation.fileName(for: first), try StoreLocation.fileName(for: second))
        XCTAssertEqual(try StoreLocation.fileName(for: first), try StoreLocation.fileName(for: StoreAccountID(stableID: first.stableID)))
    }

    func testAnAccountWithoutAnIDHasNoStore() {
        XCTAssertThrowsError(try StoreLocation.fileName(for: StoreAccountID(stableID: ""))) { error in
            XCTAssertEqual(error as? LocalStoreError, .emptyAccountID)
        }
        XCTAssertThrowsError(try AccountStore.open(for: StoreAccountID(stableID: ""), in: temporaryDirectory()))
    }

    func testStoresLiveInApplicationSupport() throws {
        let support = URL.applicationSupportDirectory.standardizedFileURL.path(percentEncoded: false)
        let url = try StoreLocation.fileURL(for: StoreAccountID(stableID: "abc"))
        XCTAssertTrue(url.standardizedFileURL.path(percentEncoded: false).hasPrefix(support))
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, StoreLocation.defaultDirectory.lastPathComponent)
        XCTAssertEqual(url.lastPathComponent, try StoreLocation.fileName(for: StoreAccountID(stableID: "abc")))
    }

    func testOneAccountNeverSeesAnothersData() throws {
        let folder = temporaryDirectory()
        let alice = StoreAccountID(stableID: "aaaaaaaa-0000-0000-0000-000000000001")
        let bob = StoreAccountID(stableID: "bbbbbbbb-0000-0000-0000-000000000002")
        let parameters = try StoreFixtures.parameters()

        do {
            let aliceStore = try AccountStore.open(for: alice, in: folder)
            try aliceStore.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters)))
            XCTAssertEqual(try aliceStore.recipes().count, 1)
        }

        let bobStore = try AccountStore.open(for: bob, in: folder)
        XCTAssertTrue(try bobStore.recipes().isEmpty)

        // Alice's data is still in her own file.
        let aliceAgain = try AccountStore.open(for: alice, in: folder)
        XCTAssertEqual(try aliceAgain.recipes().count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try StoreLocation.fileURL(for: alice, in: folder).path(percentEncoded: false)))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try StoreLocation.fileURL(for: bob, in: folder).path(percentEncoded: false)))
    }
}
