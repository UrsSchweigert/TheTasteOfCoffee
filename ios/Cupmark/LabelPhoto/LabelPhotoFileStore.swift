import Foundation

/// The encoded label photos waiting for upload (M2-T24), one JPEG file each, in
/// `Application Support/LabelPhotos`. The files are excluded from backups and readable only
/// once the device has been unlocked after a restart.
///
/// A file is deleted as soon as its photo is done with: after the 204 of completion (by
/// `LabelPhotoUploader`), or when the photo is rejected, refused or removed (by
/// `LabelPhotoUploadModel`). Uploads need the network in this task and nothing is queued, so a
/// file left behind (the app was closed during an upload) is removed by `removeStale` a day
/// later. M2-T25 queues uploads in the outbox and will keep the files the outbox still names.
struct LabelPhotoFileStore: Sendable {
    /// Files older than this are removed by `removeStale`.
    static let staleAge: TimeInterval = 24 * 60 * 60

    let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/LabelPhotos`.
    static func standard() -> LabelPhotoFileStore {
        LabelPhotoFileStore(directory: URL.applicationSupportDirectory.appending(path: "LabelPhotos", directoryHint: .isDirectory))
    }

    /// Writes `jpeg` to a new file with a random name and returns its URL.
    func write(_ jpeg: Data) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        let url = directory.appending(path: "\(UUID().uuidString).jpg", directoryHint: .notDirectory)
        try jpeg.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
