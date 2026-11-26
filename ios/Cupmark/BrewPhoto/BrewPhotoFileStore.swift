import Foundation
import os

/// The brew photo folders of every account on the device (M2-T42, ADR 0033): one folder per
/// account, `Application Support/BrewPhotos/<account id>/`, next to `LabelPhotos` and like the
/// one store per account (ADR 0020).
///
/// Brew photos never leave the device: nothing here is uploaded. A folder lives as long as its
/// account's store:
///
/// - A sign-out keeps it, as it keeps the store (ADR 0020), and another account's sign-in does
///   not touch it.
/// - The store's sweep (`AccountStore.sweepBrewPhotos()`, at every store open) deletes the
///   files no record lists.
/// - Account deletion (ADR 0031, point 6) deletes the folder of each listed account after the
///   204 (`AccountLocalData`), and "Remove Data of Other Accounts" (M2-T30) the folders of the
///   other accounts (`LocalDataRemover`).
///
/// The folder name is the `AccountID` itself, 64 lowercase hex digits (checked by
/// `AccountID(rawValue:)`), so no account id can name a path outside the root.
///
/// Unlike the label photos, the folders are not excluded from backups: a brew photo is the
/// user's own data with no other copy, so an iCloud or computer backup of the device keeps it.
struct BrewPhotoFolders: Sendable {
    let root: URL

    init(root: URL) {
        self.root = root
    }

    /// `Application Support/BrewPhotos`.
    static let standard = BrewPhotoFolders(
        root: URL.applicationSupportDirectory.appending(path: "BrewPhotos", directoryHint: .isDirectory)
    )

    /// The photo files of `account`.
    func files(for account: AccountID) -> BrewPhotoFileStore {
        BrewPhotoFileStore(directory: root.appending(path: account.rawValue, directoryHint: .isDirectory))
    }

    /// Deletes the folder of `account` and every file in it. A folder that is not there is not
    /// an error, so this is safe to repeat.
    func removeFolder(of account: AccountID) throws {
        let folder = files(for: account).directory
        guard FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)) else {
            return
        }
        try FileManager.default.removeItem(at: folder)
    }

    /// Deletes everything under the root but the folder of `account` (M2-T30, "Remove Data of
    /// Other Accounts", which also deletes those accounts' stores). Every entry is tried; the
    /// first failure is thrown at the end.
    func removeFolders(exceptOf account: AccountID) throws {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        var firstError: (any Error)?
        for entry in entries where entry.lastPathComponent != account.rawValue {
            do {
                try FileManager.default.removeItem(at: entry)
            } catch {
                firstError = firstError ?? error
            }
        }
        if let firstError {
            throw firstError
        }
    }
}

/// The brew photo files of one account (M2-T42, ADR 0033): one JPEG per `StoredBrewPhoto`,
/// named `<UUID>.jpg`, in the account's folder of `BrewPhotoFolders`.
///
/// - A file is written to a hidden temporary file in the same folder and then moved to its
///   name, so a file with a photo name is always complete. The files are readable only while
///   the device is unlocked (`.completeFileProtection`), like the label photos, and are not
///   excluded from backups.
/// - Only names of the form `<UUID>.jpg` are ever turned into a path (`url(of:)`), so a stored
///   name cannot reach outside the folder.
/// - No file timestamp, disk space or other required-reason API is used (ADR 0033).
///
/// Pure file work, no state: safe off the main actor. The store writes a photo of at most
/// `BrewPhotoLimits.encoding.maxBytes` on its own actor.
struct BrewPhotoFileStore: Sendable {
    static let fileExtension = "jpg"
    /// The ending of a temporary file, which a sweep deletes if an ended app left one.
    static let temporarySuffix = ".partial"

    private static let logger = Logger(subsystem: "Cupmark", category: "BrewPhoto")

    let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    /// Whether `name` is the name of a photo file: an upper-case UUID and `.jpg`, as `write`
    /// makes them. Nothing else is a photo file, so nothing else is read or deleted by name.
    static func isPhotoFileName(_ name: String) -> Bool {
        let suffix = ".\(fileExtension)"
        guard name.hasSuffix(suffix) else {
            return false
        }
        let stem = String(name.dropLast(suffix.count))
        return UUID(uuidString: stem)?.uuidString == stem
    }

    /// The file of the photo named `name`, nil when `name` is not a photo file name.
    func url(of name: String) -> URL? {
        guard BrewPhotoFileStore.isPhotoFileName(name) else {
            return nil
        }
        return directory.appending(path: name, directoryHint: .notDirectory)
    }

    /// Whether the photo file `name` is there.
    func fileExists(_ name: String) -> Bool {
        guard let url = url(of: name) else {
            return false
        }
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path(percentEncoded: false), isDirectory: &isDirectory) && !isDirectory.boolValue
    }

    /// Writes `photo` to a new file and returns its name. The bytes go to a temporary file in
    /// the same folder first, which is then moved to the new name; on failure the temporary
    /// file is removed and nothing is left.
    func write(_ photo: EncodedBrewPhoto) throws -> String {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = "\(UUID().uuidString).\(BrewPhotoFileStore.fileExtension)"
        let temporary = directory.appending(
            path: ".\(UUID().uuidString)\(BrewPhotoFileStore.temporarySuffix)",
            directoryHint: .notDirectory
        )
        let target = directory.appending(path: name, directoryHint: .notDirectory)
        do {
            try photo.data.write(to: temporary, options: [.withoutOverwriting, .completeFileProtection])
            try FileManager.default.moveItem(at: temporary, to: target)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            // A fixed message only: no path, no account id.
            BrewPhotoFileStore.logger.error("A brew photo file could not be written.")
            throw error
        }
        return name
    }

    /// Deletes the photo file `name`. A name that is not a photo file name, or a file that is
    /// already gone, changes nothing.
    func remove(_ name: String) {
        guard let url = url(of: name) else {
            return
        }
        try? FileManager.default.removeItem(at: url)
    }

    /// The names of everything in the folder, hidden temporary files included.
    func entryNames() -> [String] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return urls.map(\.lastPathComponent)
    }

    /// Deletes everything in the folder whose name is not in `names`: files no record lists
    /// and temporary files an ended app left. Returns how many entries went.
    @discardableResult
    func removeEntries(except names: Set<String>) -> Int {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        var removed = 0
        for url in urls where !names.contains(url.lastPathComponent) {
            do {
                try FileManager.default.removeItem(at: url)
                removed += 1
            } catch {
                BrewPhotoFileStore.logger.error("A brew photo file no record lists could not be deleted.")
            }
        }
        return removed
    }
}
