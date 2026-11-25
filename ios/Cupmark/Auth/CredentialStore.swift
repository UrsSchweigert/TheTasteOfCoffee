import Foundation
import Security

/// What survives a restart: the refresh token and the account it belongs to. Access and id
/// tokens are never saved; they live in `AuthSession`'s memory only.
struct StoredCredential: Codable, Equatable, Sendable {
    var refreshToken: String
    var accountID: AccountID

    private enum CodingKeys: String, CodingKey {
        case refreshToken = "refresh_token"
        case accountID = "account_id"
    }
}

/// Where the credential is saved. The app uses `KeychainCredentialStore`; tests use a fake.
protocol CredentialStore: Sendable {
    /// The saved credential, or nil when there is none.
    func load() throws -> StoredCredential?
    /// Saves `credential`, replacing any saved one.
    func save(_ credential: StoredCredential) throws
    /// Removes the saved credential. Removing nothing is not an error.
    func delete() throws
}

/// One generic-password item in the Keychain, per stage.
///
/// - Service `app.cupmark.Cupmark.auth.<stage>`, account `refresh-token`, so dev and prod
///   sign-ins never overwrite each other.
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by a background sync after
///   the first unlock, never in a backup that restores to another device, never synced
///   through iCloud Keychain.
/// - The item's data is the JSON of `StoredCredential`.
/// - Keychain items outlive the app: after a reinstall the user is still signed in until the
///   refresh token expires (30 days, infra/src/identity.ts) or is revoked.
struct KeychainCredentialStore: CredentialStore {
    static let account = "refresh-token"

    let service: String

    init(service: String) {
        self.service = service
    }

    init(stage: Stage) {
        self.init(service: "app.cupmark.Cupmark.auth.\(stage.rawValue)")
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: KeychainCredentialStore.account,
        ]
    }

    func load() throws -> StoredCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw AuthError.keychain(status)
        }
        guard let data = result as? Data,
              let credential = try? JSONDecoder().decode(StoredCredential.self, from: data) else {
            // An item this app cannot read is useless; drop it so the user can sign in again.
            try delete()
            return nil
        }
        return credential
    }

    func save(_ credential: StoredCredential) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(credential)
        } catch {
            throw AuthError.invalidResponse
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw AuthError.keychain(updateStatus)
        }
        var item = baseQuery
        for (key, value) in attributes {
            item[key] = value
        }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw AuthError.keychain(addStatus)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AuthError.keychain(status)
        }
    }
}
