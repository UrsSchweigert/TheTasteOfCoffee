import Foundation

/// Removes the local data of accounts other than the signed-in one (M2-T30, from the M2-T16
/// review).
///
/// After an account is deleted on another device, this device keeps that account's store,
/// outbox and queued label photos: nothing on the device can tell that the account can no
/// longer sign in. A 401 after the token refresh is not enough to say it, since an expired or
/// revoked session of a live account answers the same, and deleting a live account's unsent
/// changes would lose the user's data. So the user decides, in Settings.
///
/// - A store is one file per account under `storesDirectory`: `<64 hex digits>.store`, with the
///   `-wal` and `-shm` files SwiftData adds (`StoreLocation`). The name is the SHA-256 of the
///   account's id, so the signed-in account's file is found by hashing and every other file of
///   that shape belongs to another account. A file of another shape is never touched.
/// - Only stores that are not open are removed: the app opens the signed-in account's store
///   only.
/// - The label photo folders of the other accounts go with them (`LabelPhotoFolders`).
/// - Nothing is sent to the server, and the server's data is not touched.
struct LocalDataRemover: Sendable {
    let storesDirectory: URL
    let labelPhotos: LabelPhotoFolders

    init(storesDirectory: URL = StoreLocation.defaultDirectory, labelPhotos: LabelPhotoFolders = .standard) {
        self.storesDirectory = storesDirectory
        self.labelPhotos = labelPhotos
    }

    /// The file stems (hex digits) of the other accounts' stores, sorted.
    func otherStems(keeping account: AccountID) throws -> [String] {
        let own = try StoreLocation.fileStem(for: account)
        var stems = Set<String>()
        for entry in LocalDataRemover.entries(in: storesDirectory) {
            if let stem = LocalDataRemover.storeStem(of: entry.lastPathComponent), stem != own {
                stems.insert(stem)
            }
        }
        return stems.sorted()
    }

    /// How many other accounts have a store on the device.
    func otherAccountCount(keeping account: AccountID) throws -> Int {
        try otherStems(keeping: account).count
    }

    /// Deletes the stores of the other accounts (with their `-wal` and `-shm` files) and their
    /// label photo folders, and returns how many stores went. Every file is tried; the first
    /// failure is thrown at the end.
    @discardableResult
    func removeOtherAccounts(keeping account: AccountID) throws -> Int {
        let own = try StoreLocation.fileStem(for: account)
        var stems = Set<String>()
        var firstError: (any Error)?
        for entry in LocalDataRemover.entries(in: storesDirectory) {
            guard let stem = LocalDataRemover.storeStem(of: entry.lastPathComponent), stem != own else {
                continue
            }
            stems.insert(stem)
            do {
                try FileManager.default.removeItem(at: entry)
            } catch {
                firstError = firstError ?? error
            }
        }
        labelPhotos.removeFolders(exceptOf: account)
        if let firstError {
            throw firstError
        }
        return stems.count
    }

    /// `<64 lowercase hex digits>` when `name` is `<stem>.store`, `<stem>.store-wal` or
    /// `<stem>.store-shm`; nil for any other name.
    static func storeStem(of name: String) -> String? {
        let suffixes = [".\(StoreLocation.fileExtension)", ".\(StoreLocation.fileExtension)-wal", ".\(StoreLocation.fileExtension)-shm"]
        guard let suffix = suffixes.first(where: { name.hasSuffix($0) }) else {
            return nil
        }
        let stem = String(name.dropLast(suffix.count))
        guard AccountID(rawValue: stem) != nil else {
            return nil
        }
        return stem
    }

    private static func entries(in directory: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    }
}
