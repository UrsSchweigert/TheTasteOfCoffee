import CryptoKit
import Foundation

/// The account a local store belongs to (ADR 0020: the store is keyed by account).
///
/// `stableID` is the id token's `sub`: opaque, stable for the life of the account, never
/// shown and never logged. Sign-in (M2-T11) adapts its account value with one line, for
/// example `extension AccountID: StoreAccount { var stableID: String { rawValue } }`.
/// A later offline account (ADR 0020) only needs another stable id that cannot collide
/// with a `sub`.
protocol StoreAccount: Sendable {
    var stableID: String { get }
}

/// A plain `StoreAccount`, for tests and for callers that hold the id as a string.
struct StoreAccountID: StoreAccount, Hashable {
    let stableID: String
}

/// Where an account's store lives on the device.
///
/// One SQLite file per account, named from the SHA-256 of `stableID` in lower-case hex,
/// so the raw `sub` never appears in a path. Different accounts always get different files,
/// which is what keeps one account from ever reading another's data.
enum StoreLocation {
    /// The extension of a store file. SwiftData adds `-wal` and `-shm` files next to it.
    static let fileExtension = "store"

    /// `Library/Application Support/Accounts`, where the store files live.
    static var defaultDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "Accounts", directoryHint: .isDirectory)
    }

    /// The lower-case hex SHA-256 of the account's stable id. Throws for an empty id, so
    /// no two accounts without an id could ever share a file.
    static func fileStem(for account: some StoreAccount) throws -> String {
        guard !account.stableID.isEmpty else {
            throw LocalStoreError.emptyAccountID
        }
        let digest = SHA256.hash(data: Data(account.stableID.utf8))
        return digest.map { byte in hexByte(byte) }.joined()
    }

    /// `<hex sha-256>.store`.
    static func fileName(for account: some StoreAccount) throws -> String {
        "\(try fileStem(for: account)).\(fileExtension)"
    }

    /// The store file of `account` in `directory`.
    static func fileURL(for account: some StoreAccount, in directory: URL = defaultDirectory) throws -> URL {
        directory.appending(path: try fileName(for: account), directoryHint: .notDirectory)
    }

    private static let hexDigits = Array("0123456789abcdef")

    private static func hexByte(_ byte: UInt8) -> String {
        String([hexDigits[Int(byte >> 4)], hexDigits[Int(byte & 0x0f)]])
    }
}
