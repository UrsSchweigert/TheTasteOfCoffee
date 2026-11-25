import Security
import XCTest
@testable import Cupmark

/// `KeychainCredentialStore` against the real Keychain of the test host app (M2-T11). Each
/// test uses its own service and removes its item. If the simulator gives this unsigned build
/// no Keychain (`errSecMissingEntitlement` and the like), the round trips are skipped; the
/// session logic is covered with `FakeCredentialStore` in `AuthSessionTests`.
final class KeychainCredentialStoreTests: XCTestCase {
    private let store = KeychainCredentialStore(service: "app.cupmark.Cupmark.auth.test-\(UUID().uuidString)")

    private let credential = StoredCredential(refreshToken: "refresh-1", accountID: AccountID(subject: AuthFixtures.subject))

    override func tearDown() {
        try? store.delete()
        super.tearDown()
    }

    /// Statuses that mean "no Keychain for this process", not a bug in the store.
    private static let unavailable: Set<OSStatus> = [errSecMissingEntitlement, errSecNotAvailable, errSecInteractionNotAllowed]

    private func skippingIfUnavailable<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch AuthError.keychain(let status) where KeychainCredentialStoreTests.unavailable.contains(status) {
            throw KeychainCredentialStoreTests.skip(status)
        }
    }

    /// The skip, with a reason that says plainly in the CI log that the real Keychain test
    /// did not run, and why.
    private static func skip(_ status: OSStatus) -> XCTSkip {
        let name: String
        switch status {
        case errSecMissingEntitlement: name = "errSecMissingEntitlement"
        case errSecNotAvailable: name = "errSecNotAvailable"
        case errSecInteractionNotAllowed: name = "errSecInteractionNotAllowed"
        default: name = "unknown"
        }
        return XCTSkip("NOT RUN: real Keychain round trip skipped, SecItem returned OSStatus \(status) (\(name)); this test process has no Keychain access (unsigned simulator build). The session logic is still covered with FakeCredentialStore in AuthSessionTests.")
    }

    func testEachStageHasItsOwnService() {
        XCTAssertEqual(KeychainCredentialStore(stage: .dev).service, "app.cupmark.Cupmark.auth.dev")
        XCTAssertEqual(KeychainCredentialStore(stage: .prod).service, "app.cupmark.Cupmark.auth.prod")
        XCTAssertEqual(KeychainCredentialStore.account, "refresh-token")
    }

    func testKeychainRoundTrip() throws {
        // Outside an assertion, so an XCTSkip skips instead of failing the assertion.
        let initial = try skippingIfUnavailable { try store.load() }
        XCTAssertNil(initial)
        try skippingIfUnavailable { try store.save(credential) }
        XCTAssertEqual(try store.load(), credential)

        var replaced = credential
        replaced.refreshToken = "refresh-2"
        try store.save(replaced)
        XCTAssertEqual(try store.load(), replaced, "a second save replaces the item")

        try store.delete()
        XCTAssertNil(try store.load())
        XCTAssertNoThrow(try store.delete(), "deleting nothing is not an error")
    }

    func testTheItemIsOnlyAccessibleOnThisDeviceAfterFirstUnlock() throws {
        try skippingIfUnavailable { try store.save(credential) }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: KeychainCredentialStore.account,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let attributes = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testAnUnreadableItemIsDropped() throws {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: KeychainCredentialStore.account,
            kSecValueData as String: Data("not json".utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        if KeychainCredentialStoreTests.unavailable.contains(status) {
            throw KeychainCredentialStoreTests.skip(status)
        }
        XCTAssertEqual(status, errSecSuccess)
        XCTAssertNil(try store.load())
        XCTAssertNil(try store.load(), "the item was removed")
    }
}
