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
/// Whether the folders and files are in the device backup is the user's choice (M2-T45,
/// `BrewPhotoBackupSetting`): excluded (`isExcludedFromBackup`) unless the user turned the
/// setting on. The flag is set on a new folder and its files, again at every store open and
/// whenever the setting changes (`applyBackupSetting`).
struct BrewPhotoFolders: Sendable {
    let root: URL
    let backup: BrewPhotoBackupSetting

    init(root: URL, backup: BrewPhotoBackupSetting = .standard) {
        self.root = root
        self.backup = backup
    }

    /// `Application Support/BrewPhotos`.
    static let standard = BrewPhotoFolders(
        root: URL.applicationSupportDirectory.appending(path: "BrewPhotos", directoryHint: .isDirectory)
    )

    /// The photo files of `account`.
    func files(for account: AccountID) -> BrewPhotoFileStore {
        let setting = backup
        return BrewPhotoFileStore(
            directory: root.appending(path: account.rawValue, directoryHint: .isDirectory),
            isIncludedInBackup: { setting.isIncluded }
        )
    }

    /// Sets the backup flag of every account's folder that is there, and of the files in them,
    /// to the current setting (the user changed it). A folder that does not exist yet follows
    /// the setting when it is created. Returns false if any folder or file could not be set.
    @discardableResult
    func applyBackupSettingToAllFolders() -> Bool {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        let setting = backup
        var allSet = true
        for entry in entries {
            let store = BrewPhotoFileStore(directory: entry, isIncludedInBackup: { setting.isIncluded })
            if !store.applyBackupSetting() {
                allSet = false
            }
        }
        return allSet
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
///   the device is unlocked (`.completeFileProtection`), like the label photos. Folder and
///   files are excluded from the device backup unless the user turned the setting on
///   (`isIncludedInBackup`, M2-T45); a new file takes the setting at the moment it is written.
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
    /// Whether the user wants the photos in the device backup (`BrewPhotoBackupSetting`). Off
    /// unless given.
    private let isIncludedInBackup: @Sendable () -> Bool

    init(directory: URL, isIncludedInBackup: @escaping @Sendable () -> Bool = { false }) {
        self.directory = directory
        self.isIncludedInBackup = isIncludedInBackup
    }

    /// Sets `isExcludedFromBackup` of `url`. Returns false if it could not be set.
    @discardableResult
    private static func setExcluded(_ excluded: Bool, at url: URL) -> Bool {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = excluded
        do {
            try target.setResourceValues(values)
            return true
        } catch {
            // A fixed message only: no path, no account id.
            logger.error("The backup flag of a brew photo item could not be set.")
            return false
        }
    }

    /// Whether `url` is excluded from the backup; nil when it cannot be read.
    static func isExcludedFromBackup(_ url: URL) -> Bool? {
        try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
    }

    /// Sets the backup flag of the folder and of everything in it (hidden temporary files
    /// included) to the current setting: excluded unless the user included the photos. A
    /// folder that is not there is left alone and counts as set (it follows the setting when
    /// it is created). Safe to repeat. Returns false if any item could not be set.
    @discardableResult
    func applyBackupSetting() -> Bool {
        guard FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)) else {
            return true
        }
        let excluded = !isIncludedInBackup()
        var allSet = BrewPhotoFileStore.setExcluded(excluded, at: directory)
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for url in urls where !BrewPhotoFileStore.setExcluded(excluded, at: url) {
            allSet = false
        }
        return allSet
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
        let folderExisted = FileManager.default.fileExists(atPath: directory.path(percentEncoded: false))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let excluded = !isIncludedInBackup()
        if !folderExisted {
            // A new folder starts with the setting (excluded unless the user included the photos).
            BrewPhotoFileStore.setExcluded(excluded, at: directory)
        }
        let name = "\(UUID().uuidString).\(BrewPhotoFileStore.fileExtension)"
        let temporary = directory.appending(
            path: ".\(UUID().uuidString)\(BrewPhotoFileStore.temporarySuffix)",
            directoryHint: .notDirectory
        )
        let target = directory.appending(path: name, directoryHint: .notDirectory)
        do {
            try photo.data.write(to: temporary, options: [.withoutOverwriting, .completeFileProtection])
            try FileManager.default.moveItem(at: temporary, to: target)
            // The file follows the setting, as the folder does. A flag that cannot be set is
            // logged and does not fail the photo.
            BrewPhotoFileStore.setExcluded(excluded, at: target)
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
