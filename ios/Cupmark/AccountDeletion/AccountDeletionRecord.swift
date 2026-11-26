import Foundation
import Security

/// What survives a restart while an account is being deleted (M2-T31, ADR 0031).
///
/// It is saved before the first `DELETE /account` and removed only after the local data and
/// the sign-in are gone, so a deletion that was interrupted at any point (the app ended, the
/// phone restarted, the store already deleted) is resumed at the next start. It holds account
/// ids only: the local keys of `AccountID`, which never leave the device.
struct AccountDeletionRecord: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable {
        /// `DELETE /account` has not answered 204 yet. The user stays signed in, and nothing
        /// but `DELETE /account` is sent.
        case requested
        /// The server answered 204. The local data, the sign-in and this record are still to go;
        /// nothing more is sent to the API.
        case serverDeleted
    }

    var phase: Phase
    /// The account whose token `DELETE /account` is sent with: the signed-in account when the
    /// deletion started, or the account signed in with after the token could not be refreshed
    /// (ADR 0031).
    var account: AccountID
    /// Every account whose local data goes after the 204, in the order they joined; `account`
    /// is always one of them.
    var localAccounts: [AccountID]

    init(phase: Phase, account: AccountID, localAccounts: [AccountID]) {
        self.phase = phase
        self.account = account
        self.localAccounts = localAccounts.contains(account) ? localAccounts : localAccounts + [account]
    }

    private enum CodingKeys: String, CodingKey {
        case phase
        case account = "account_id"
        case localAccounts = "local_account_ids"
    }
}

/// Where the record of a running account deletion is kept. The app uses
/// `KeychainAccountDeletionStore`; tests use a fake.
protocol AccountDeletionStore: Sendable {
    /// The saved record, or nil when no deletion runs.
    func load() throws -> AccountDeletionRecord?
    /// Saves `record`, replacing any saved one.
    func save(_ record: AccountDeletionRecord) throws
    /// Removes the saved record. Removing nothing is not an error.
    func delete() throws
}

extension AccountDeletionStore {
    /// True while a deletion is recorded, and while the record cannot be read (before the
    /// first unlock): nothing is sent for any account then (`AuthSession.maySend(as:)`,
    /// `SyncHost`).
    var holdsSending: Bool {
        do {
            return try load() != nil
        } catch {
            return true
        }
    }
}

/// The record as one generic-password item in the Keychain, per stage.
///
/// - Service `app.cupmark.Cupmark.deletion.<stage>`, account `account-deletion`.
/// - The Keychain, not a file: it lives outside the account's store and outside Application
///   Support, so deleting them never deletes it, and like the saved sign-in (ADR 0024) it
///   survives a reinstall. A reinstalled app that is still signed in to an account whose
///   deletion was started therefore resumes the deletion instead of syncing.
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, like the sign-in: never in a backup
///   that restores to another device, never in iCloud Keychain.
/// - The item's data is the JSON of `AccountDeletionRecord`.
struct KeychainAccountDeletionStore: AccountDeletionStore {
    static let account = "account-deletion"

    let service: String

    init(service: String) {
        self.service = service
    }

    init(stage: Stage) {
        self.init(service: "app.cupmark.Cupmark.deletion.\(stage.rawValue)")
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: KeychainAccountDeletionStore.account,
        ]
    }

    func load() throws -> AccountDeletionRecord? {
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
              let record = try? JSONDecoder().decode(AccountDeletionRecord.self, from: data) else {
            // Only this app writes the item; one it cannot read would hold every sync for good,
            // so it is dropped, as an unreadable sign-in is (`KeychainCredentialStore`).
            try delete()
            return nil
        }
        return record
    }

    func save(_ record: AccountDeletionRecord) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(record)
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
