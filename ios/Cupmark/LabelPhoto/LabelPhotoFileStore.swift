import Foundation
import os

/// The label photo folders of every account on the device (M2-T24): one folder per account,
/// `Application Support/LabelPhotos/<account id>/`, like the one store per account (M2-T15).
///
/// Each folder holds the photos of the saved-bean screen (M2-T24) and, in its `Queued`
/// subfolder, the photos of the account's label photo queue (M2-T25, `QueuedLabelPhoto` in the
/// account's store). A queued photo belongs to the account's store, which stays on the device
/// after a sign-out (one store per account, ADR 0020 and 0025), so it stays with it:
///
/// - When an account's store is closed (sign-out, an ended session, another account),
///   `close(_:keepingQueued:)` deletes the screen's photos and every queued file the store does
///   not list. If the store could not be read, the queue folder is kept as it is.
/// - When an account is signed in (also at app start), `signedIn(as:)` deletes everything of
///   every other account but its queue folder (checked against that account's store when it
///   closed), and the account's own stale screen photos; `removeUnqueued(of:keeping:)` then
///   deletes the account's queued files its store does not list (left by an ended app).
/// - `removeFolder(of:)` deletes everything of an account, queue included.
struct LabelPhotoFolders: Sendable {
    /// The subfolder of an account's folder that holds its queued photos.
    static let queueFolderName = "Queued"

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

    /// The queue folder of `account` (M2-T25): the files of its `QueuedLabelPhoto`s.
    func queue(for account: AccountID) -> LabelPhotoFileStore {
        store(for: account).queued
    }

    /// Deletes the folder of `account` and every photo in it, queued ones included.
    func removeFolder(of account: AccountID) {
        try? FileManager.default.removeItem(at: store(for: account).directory)
    }

    /// The store of `account` was closed: deletes its screen photos and, when `names` is
    /// known, every queued file whose name its store does not list. Nil (the store could not
    /// be read) keeps the queue folder as it is. An emptied folder is removed.
    func close(_ account: AccountID, keepingQueued names: Set<String>?) {
        let folder = store(for: account).directory
        for entry in LabelPhotoFolders.contents(of: folder) where entry.lastPathComponent != LabelPhotoFolders.queueFolderName {
            try? FileManager.default.removeItem(at: entry)
        }
        if let names {
            queue(for: account).removeFiles(except: names)
        }
        LabelPhotoFolders.removeIfEmpty(queue(for: account).directory)
        LabelPhotoFolders.removeIfEmpty(folder)
    }

    /// `account` is signed in: deletes everything under the root but the account's own folder
    /// and the queue folders of other accounts, and the account's screen photos older than
    /// `LabelPhotoFileStore.staleAge`.
    func signedIn(as account: AccountID, now: Date = Date()) {
        for entry in LabelPhotoFolders.contents(of: root) where entry.lastPathComponent != account.rawValue {
            guard let other = AccountID(rawValue: entry.lastPathComponent), LabelPhotoFolders.isDirectory(entry) else {
                try? FileManager.default.removeItem(at: entry)
                continue
            }
            // Another account's queued photos stay with its store.
            for inner in LabelPhotoFolders.contents(of: entry) where inner.lastPathComponent != LabelPhotoFolders.queueFolderName {
                try? FileManager.default.removeItem(at: inner)
            }
            LabelPhotoFolders.removeIfEmpty(queue(for: other).directory)
            LabelPhotoFolders.removeIfEmpty(entry)
        }
        store(for: account).removeStale(now: now)
    }

    /// Deletes the queued files of `account` whose names its store does not list: files of
    /// photos whose record never reached the store (the app was ended in between).
    func removeUnqueued(of account: AccountID, keeping names: Set<String>) {
        queue(for: account).removeFiles(except: names)
    }

    private static func contents(of directory: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
    }

    private static func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
    }

    private static func removeIfEmpty(_ directory: URL) {
        let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        if let entries, entries.isEmpty {
            try? FileManager.default.removeItem(at: directory)
        }
    }
}

/// The encoded label photos of one account waiting for upload (M2-T24), one JPEG file each,
/// in the account's folder of `LabelPhotoFolders`. The files are excluded from backups and
/// readable only while the device is unlocked (`.completeFileProtection`).
///
/// A file is deleted as soon as its photo is done with: after the 204 of completion (by
/// `LabelPhotoUploader`); when the photo is rejected, refused or removed, and when the
/// saved-bean screen goes away (by `LabelPhotoUploadModel`); when the account is signed out
/// (`LabelPhotoFolders`). A file left behind by an app that was ended is removed at the next
/// sign-in or app start once it is older than `staleAge`. The account's queue folder
/// (`queued`, M2-T25) is a store of its own, whose files live as long as their queued photos.
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

    /// The queue folder inside this store's folder (M2-T25), a store of its own.
    var queued: LabelPhotoFileStore {
        LabelPhotoFileStore(directory: directory.appending(path: LabelPhotoFolders.queueFolderName, directoryHint: .isDirectory))
    }

    /// The files in the store; folders in it (the queue folder) are not files of it.
    func files() -> [URL] {
        let urls = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey]
        )
        return (urls ?? []).filter { url in
            (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
        }
    }

    /// Deletes every file whose name is not in `names`.
    func removeFiles(except names: Set<String>) {
        for url in files() where !names.contains(url.lastPathComponent) {
            try? FileManager.default.removeItem(at: url)
        }
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
