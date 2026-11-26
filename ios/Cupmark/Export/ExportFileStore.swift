import Foundation

/// The temporary file of an export (M2-T30, docs/05 Security, Export).
///
/// - The file is named `cupmark-export-<YYYY-MM-DD>.csv`, the day in the device calendar.
///   Every file sits in a folder of its own, a new random name under `root`, so two exports
///   never share a path and the file keeps exactly that name.
/// - `write(_:on:)` writes the bytes as they are. Nothing is parsed, re-encoded or trimmed.
/// - The file is readable only while the device is unlocked (`.completeFileProtection`).
/// - `remove(_:)` deletes the file and its folder. `removeAll()` deletes everything under
///   `root`, which clears a file an ended app left behind.
struct ExportFileStore: Sendable {
    static let namePrefix = "cupmark-export-"
    static let nameExtension = "csv"

    /// The folder that holds one subfolder per export.
    let root: URL

    init(root: URL = FileManager.default.temporaryDirectory.appending(path: "CupmarkExport", directoryHint: .isDirectory)) {
        self.root = root
    }

    /// `cupmark-export-YYYY-MM-DD.csv` for the day `date` falls on in `calendar`.
    static func fileName(for date: Date, calendar: Calendar = .current) -> String {
        let day = calendar.dateComponents([.year, .month, .day], from: date)
        let year = day.year ?? 0
        let month = day.month ?? 0
        let dayOfMonth = day.day ?? 0
        let stamp = String(format: "%04ld-%02ld-%02ld", year, month, dayOfMonth)
        return "\(namePrefix)\(stamp).\(nameExtension)"
    }

    /// Writes `data` unchanged to a new file and returns its URL.
    func write(_ data: Data, on date: Date, calendar: Calendar = .current) throws -> URL {
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: ExportFileStore.fileName(for: date, calendar: calendar), directoryHint: .notDirectory)
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        return url
    }

    /// Deletes the file at `url` and the folder `write(_:on:)` made for it. Only a file under
    /// `root` is touched.
    func remove(_ url: URL) {
        let folder = url.deletingLastPathComponent()
        guard folder.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else {
            return
        }
        try? FileManager.default.removeItem(at: folder)
    }

    /// Deletes every export file and folder under `root`.
    func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }
}
