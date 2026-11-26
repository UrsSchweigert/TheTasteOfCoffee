import Foundation
import os

/// The label photo folders of every account on the device (M2-T24): one folder per account,
/// `Application Support/LabelPhotos/<account id>/`, like the one store per account (M2-T15).
///
/// `SyncHost` keeps them in step with the sign-in: when an account's store is closed (sign-out,
/// an ended session, another account) its folder is deleted, and when an account is signed in
/// (also at app start) every other account's folder is deleted and the account's own stale
/// files are removed. Nothing is queued in this task (M2-T25 will queue uploads), so a photo
/// that has not been uploaded by then is not needed any more.
struct LabelPhotoFolders: Sendable {
    let root: URL

    init(root: URL) {
        self.root = root
    }

    /// `Application Support/LabelPhotos`.
    static let standard = LabelPhotoFolders(
        root: URL.applicationSupportDirectory.appending(path: "LabelPhotos", directoryHint: .isDirectory)
    )

    /// The store of `account`. An account id is 64 hex digits, a safe folder name.
    func store(for account: AccountID) -> LabelPhotoFileStore {
        LabelPhotoFileStore(directory: root.appending(path: account.rawValue, directoryHint: .isDirectory))
    }

    /// Deletes the folder of `account` and every photo in it.
    func removeFolder(of account: AccountID) {
        try? FileManager.default.removeItem(at: store(for: account).directory)
    }

    /// `account` is signed in: deletes every other account's folder (and anything else under
    /// the root), and the files of `account` older than `LabelPhotoFileStore.staleAge`.
    func signedIn(as account: AccountID, now: Date = Date()) {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for entry in entries where entry.lastPathComponent != account.rawValue {
            try? FileManager.default.removeItem(at: entry)
        }
        store(for: account).removeStale(now: now)
    }
}

/// The encoded label photos of one account waiting for upload (M2-T24), one JPEG file each,
/// in the account's folder of `LabelPhotoFolders`. The files are excluded from backups and
/// readable only while the device is unlocked (`.completeFileProtection`).
///
/// A file is deleted as soon as its photo is done with: after the 204 of completion (by
/// `LabelPhotoUploader`); when the photo is rejected, refused or removed, and when the
/// saved-bean screen goes away (by `LabelPhotoUploadModel`); with the whole folder when the
/// account is signed out (`LabelPhotoFolders`). A file left behind by an app that was ended
/// is removed at the next sign-in or app start once it is older than `staleAge`.
struct LabelPhotoFileStore: Sendable {
    /// Files older than this are removed by `removeStale`.
    static let staleAge: TimeInterval = 24 * 60 * 60

    private static let logger = Logger(subsystem: "Cupmark", category: "LabelPhoto")

    let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    /// Writes `jpeg` to a new file with a random name and returns its URL. Up to 8 MiB: call
    /// it off the main actor.
    func write(_ jpeg: Data) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try folder.setResourceValues(values)
        } catch {
            // A fixed message only: no path, no account id.
            LabelPhotoFileStore.logger.error("Could not exclude the label photo folder from backups.")
        }
        let url = directory.appending(path: "\(UUID().uuidString).jpg", directoryHint: .notDirectory)
        try jpeg.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// Whether `url` is a file of this store.
    func contains(_ url: URL) -> Bool {
        url.isFileURL
            && url.deletingLastPathComponent().standardizedFileURL.pathComponents
            == directory.standardizedFileURL.pathComponents
    }

    /// Deletes `url` if it is a file of this store. Never touches anything else.
    func delete(_ url: URL) {
        guard contains(url) else {
            return
        }
        try? FileManager.default.removeItem(at: url)
    }

    /// The files in the store.
    func files() -> [URL] {
        let urls = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        )
        return urls ?? []
    }

    /// Deletes every file last written more than `staleAge` before `now`.
    func removeStale(now: Date = Date()) {
        for url in files() {
            let written = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let written, now.timeIntervalSince(written) > LabelPhotoFileStore.staleAge {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }
}

/// The account the label photos of a bean entry belong to: its id, its file store and the
/// session's check that it is still the one signed in (ADR 0025). Nil on a bean entry while
/// nobody is signed in, and then no photo is uploaded.
struct LabelPhotoAccount: Sendable {
    let account: AccountID
    let files: LabelPhotoFileStore
    let isSignedIn: @Sendable (AccountID) async -> Bool

    init(account: AccountID, files: LabelPhotoFileStore, isSignedIn: @escaping @Sendable (AccountID) async -> Bool) {
        self.account = account
        self.files = files
        self.isSignedIn = isSignedIn
    }

    /// The live account: its folder of `LabelPhotoFolders.standard`, checked with `session`.
    static func live(account: AccountID, session: AuthSession) -> LabelPhotoAccount {
        LabelPhotoAccount(account: account, files: LabelPhotoFolders.standard.store(for: account)) { candidate in
            await session.isSignedIn(as: candidate)
        }
    }
}
