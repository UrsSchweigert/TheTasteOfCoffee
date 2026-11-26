import Foundation

/// The files an account leaves on the device, removed after `DELETE /account` answered 204
/// (M2-T31):
///
/// - the account's store, `<stem>.store` with SwiftData's `-wal` and `-shm` files
///   (`StoreLocation`), which holds its data and its outbox;
/// - the account's label photo folder, `LabelPhotos/<account id>/`, with the `Queued` photos of
///   its label photo queue (`LabelPhotoFolders`, from the M2-T24 and M2-T25 reviews);
/// - the account's brew photo folder, `BrewPhotos/<account id>/` (`BrewPhotoFolders`, M2-T42,
///   ADR 0033), which only the device ever had;
/// - the cached catalogue images and any export file, which are not the account's alone but
///   were loaded with its token.
///
/// Every step is safe to repeat: a file that is already gone is not an error, so a cleanup that
/// was interrupted is simply run again.
struct AccountLocalData: Sendable {
    let storesDirectory: URL
    let labelPhotos: LabelPhotoFolders
    let brewPhotos: BrewPhotoFolders
    let catalogueImages: URL?
    let exports: ExportFileStore

    init(
        storesDirectory: URL = StoreLocation.defaultDirectory,
        labelPhotos: LabelPhotoFolders = .standard,
        brewPhotos: BrewPhotoFolders = .standard,
        catalogueImages: URL? = CatalogueImageCache.standardDirectory,
        exports: ExportFileStore = ExportFileStore()
    ) {
        self.storesDirectory = storesDirectory
        self.labelPhotos = labelPhotos
        self.brewPhotos = brewPhotos
        self.catalogueImages = catalogueImages
        self.exports = exports
    }

    /// The suffixes of a store's files after `<stem>.store`.
    static let storeFileSuffixes = ["", "-wal", "-shm"]

    /// The store files of `account`, whether they exist or not.
    func storeFiles(of account: AccountID) throws -> [URL] {
        let name = try StoreLocation.fileName(for: account)
        return AccountLocalData.storeFileSuffixes.map { suffix in
            storesDirectory.appending(path: name + suffix, directoryHint: .notDirectory)
        }
    }

    /// Deletes the store files, the label photo folder and the brew photo folder of `account`.
    /// Every file is tried; the first failure is thrown at the end. Nothing else is touched:
    /// other accounts' stores and folders stay.
    func remove(_ account: AccountID) throws {
        var firstError: (any Error)?
        for url in try storeFiles(of: account) {
            do {
                try AccountLocalData.removeIfPresent(url)
            } catch {
                firstError = firstError ?? error
            }
        }
        do {
            try AccountLocalData.removeIfPresent(labelPhotos.store(for: account).directory)
        } catch {
            firstError = firstError ?? error
        }
        do {
            try brewPhotos.removeFolder(of: account)
        } catch {
            firstError = firstError ?? error
        }
        if let firstError {
            throw firstError
        }
    }

    /// Deletes the cached catalogue images and every export file. Failures are ignored: both
    /// are caches the system may also purge, and neither holds the account's own data.
    func removeCaches() {
        if let catalogueImages {
            try? FileManager.default.removeItem(at: catalogueImages)
        }
        exports.removeAll()
    }

    /// Removes `url`; a file or folder that is not there is not an error.
    private static func removeIfPresent(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else {
            return
        }
        try FileManager.default.removeItem(at: url)
    }
}
