import Foundation

/// Catalogue images (`GET /catalogue_images/{image_id}`) on disk, in the Caches directory,
/// one file per `image_id`. An image never changes under its id (ADR 0011), so an entry never
/// goes stale. The total size is bounded: past `byteLimit`, the least recently used files are
/// removed. The system may also purge the Caches directory at any time; a miss loads again.
actor CatalogueImageCache {
    /// 50 MiB, a few hundred catalogue images.
    static let defaultByteLimit = 50 * 1024 * 1024

    let directory: URL
    let byteLimit: Int

    init(directory: URL, byteLimit: Int = CatalogueImageCache.defaultByteLimit) {
        self.directory = directory
        self.byteLimit = byteLimit
    }

    /// The cache in `Library/Caches/CatalogueImages`, or nil if the system has no Caches directory.
    static func standard() -> CatalogueImageCache? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        return CatalogueImageCache(directory: caches.appending(path: "CatalogueImages", directoryHint: .isDirectory))
    }

    /// The stored bytes, or nil on a miss. A hit counts as a use for the size bound.
    func data(for imageID: ResourceID) -> Data? {
        let url = fileURL(for: imageID)
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path(percentEncoded: false))
        return data
    }

    /// Stores `data` under `imageID`, then trims the cache to `byteLimit`. Failures are ignored:
    /// the cache is an optimisation, and a miss loads the image again.
    func store(_ data: Data, for imageID: ResourceID) {
        guard data.count <= byteLimit else {
            return
        }
        let url = fileURL(for: imageID)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            return
        }
        trim(keeping: url)
    }

    /// Removes every stored image, for example on sign-out.
    func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// The file of `imageID`. A ULID is upper-case letters and digits only, so it is a safe file name.
    func fileURL(for imageID: ResourceID) -> URL {
        directory.appending(path: "\(imageID.rawValue).jpg", directoryHint: .notDirectory)
    }

    /// Removes the least recently used files until the total is at most `byteLimit`. Never
    /// removes `kept`, the file just written.
    private func trim(keeping kept: URL) {
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) else {
            return
        }
        var files: [(url: URL, size: Int, used: Date)] = urls.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: keys) else {
                return nil
            }
            return (url: url, size: values.fileSize ?? 0, used: values.contentModificationDate ?? .distantPast)
        }
        var total = files.reduce(0) { sum, file in sum + file.size }
        guard total > byteLimit else {
            return
        }
        files.sort { lhs, rhs in lhs.used < rhs.used }
        for file in files where total > byteLimit && file.url.lastPathComponent != kept.lastPathComponent {
            try? FileManager.default.removeItem(at: file.url)
            total -= file.size
        }
    }
}
