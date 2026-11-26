import Foundation
import os
import SwiftData

// Brew photos (M2-T42, ADR 0033): device-only photos of a brew. A record (`StoredBrewPhoto`)
// names its brew by the brew's `localID` and its JPEG by a file name in the account's brew photo
// folder (`BrewPhotoFileStore`). Nothing of it is synced: no outbox operation, no API type, no
// export.
//
// Files and records stay together:
// - Adding writes the file first, then saves the record in one write (`write { }`); when the
//   save fails, the file is deleted again.
// - Deleting a record (one photo, or every photo of a brew that leaves the device) stages its
//   file in `brewPhotoFilesToRemove`; `save()` deletes the file once the record is gone from
//   disk, and a failed write forgets it, since the record comes back (`discardUnsavedChanges()`).
// - An app ended between the two steps leaves at most a file without a record, which the sweep
//   at the next store open deletes (`sweepBrewPhotos()`), with the records whose brew is gone.

/// Why a brew photo could not be added or found.
enum BrewPhotoError: Error, Equatable, Sendable {
    /// The brew already has `BrewPhotoLimits.maxPerBrew` photos.
    case limitReached
    /// The brew is not in this store, or the user removed it.
    case brewNotFound
    /// The store has no brew photo folder (`AccountStore.brewPhotoFiles`).
    case noPhotoFolder
    /// The record's file is not there (or its name is not a photo file name).
    case fileMissing
}

/// What one sweep removed. Counts only.
struct BrewPhotoSweep: Equatable, Sendable {
    /// Records whose brew is gone from the device or removed by the user.
    var recordsRemoved = 0
    /// Files (and temporary files) in the account's folder that no record lists.
    var filesRemoved = 0
}

/// Fixed messages only: no ids, no names, no paths.
private let brewPhotoLogger = Logger(subsystem: "Cupmark", category: "BrewPhoto")

extension AccountStore {
    // MARK: - Add

    /// Adds `jpeg` (made by `BrewPhotoEncoder`, so it carries no metadata) to `brew`, newest.
    /// Writes the file, then the record in one write; when the save fails the file is deleted
    /// again and the error is thrown. Refused before anything is written when the brew is not
    /// in this store or was removed (`brewNotFound`), when it already holds
    /// `BrewPhotoLimits.maxPerBrew` photos (`limitReached`), or without a photo folder.
    ///
    /// The file is at most `BrewPhotoLimits.encoding.maxBytes` and is written on the caller's
    /// actor (the main actor in the app), to a temporary file that is then moved to its name.
    @discardableResult
    func addBrewPhoto(to brew: StoredBrew, jpeg: EncodedBrewPhoto, createdAt: Date = Date()) throws -> StoredBrewPhoto {
        guard let files = brewPhotoFiles else {
            throw BrewPhotoError.noPhotoFolder
        }
        let brewLocalID = brew.localID
        guard let stored = try self.brew(localID: brewLocalID), stored.syncState != .pendingDelete else {
            throw BrewPhotoError.brewNotFound
        }
        guard try brewPhotoRecords(ofBrewLocalID: brewLocalID).count < BrewPhotoLimits.maxPerBrew else {
            throw BrewPhotoError.limitReached
        }
        var writtenName: String?
        do {
            return try write { () throws -> StoredBrewPhoto in
                let name = try files.write(jpeg)
                writtenName = name
                let photo = StoredBrewPhoto(brewLocalID: brewLocalID, fileName: name, createdAt: createdAt)
                context.insert(photo)
                try save()
                return photo
            }
        } catch {
            if let writtenName {
                files.remove(writtenName)
            }
            throw error
        }
    }

    // MARK: - Read

    /// The photos of `brew`, newest first.
    func brewPhotos(of brew: StoredBrew) throws -> [StoredBrewPhoto] {
        try brewPhotoRecords(ofBrewLocalID: brew.localID)
    }

    /// Every brew photo of the account, newest first.
    func allBrewPhotos() throws -> [StoredBrewPhoto] {
        try context.fetch(FetchDescriptor<StoredBrewPhoto>(sortBy: AccountStore.newestBrewPhotoFirst))
    }

    /// The photo with this local id, nil when there is none.
    func brewPhoto(localID: UUID) throws -> StoredBrewPhoto? {
        var descriptor = FetchDescriptor<StoredBrewPhoto>(predicate: #Predicate<StoredBrewPhoto> { photo in photo.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The file of `photo`. A file that is not there is reported as `fileMissing` (and logged),
    /// never a crash; the record stays, so the user can delete it.
    func brewPhotoFileURL(of photo: StoredBrewPhoto) throws -> URL {
        guard let files = brewPhotoFiles else {
            throw BrewPhotoError.noPhotoFolder
        }
        let name = photo.fileName
        guard let url = files.url(of: name), files.fileExists(name) else {
            brewPhotoLogger.error("A brew photo's file is missing.")
            throw BrewPhotoError.fileMissing
        }
        return url
    }

    // MARK: - Delete

    /// Deletes `photo`: its record, then its file. The brew is not touched.
    func deleteBrewPhoto(_ photo: StoredBrewPhoto) throws {
        try deleteBrewPhoto(localID: photo.localID)
    }

    /// Deletes the photo with this local id, record and file. One that is already gone
    /// changes nothing.
    func deleteBrewPhoto(localID: UUID) throws {
        try write {
            guard let photo = try brewPhoto(localID: localID) else {
                return
            }
            stageRemoval(of: photo)
            try save()
        }
    }

    /// Deletes `item` from the context. A brew takes its photo records with it, and their files
    /// go after the save (M2-T42). The sync engine, the pull and a discarded sync issue remove
    /// items through here; the user's delete (`markDeleted`) calls `removeBrewPhotos` itself,
    /// since it may keep the brew as `pendingDelete`. Does not save.
    func deleteFromDevice<Model: PersistentModel>(_ item: Model) throws {
        if let brew = item as? StoredBrew {
            try removeBrewPhotos(ofBrewLocalID: brew.localID)
        }
        context.delete(item)
    }

    /// Deletes the photo records of the brew with `brewLocalID` from the context; their files
    /// go after the save. Does not save.
    func removeBrewPhotos(ofBrewLocalID brewLocalID: UUID) throws {
        for photo in try brewPhotoRecords(ofBrewLocalID: brewLocalID) {
            stageRemoval(of: photo)
        }
    }

    /// Deletes the files of the photo records the last save deleted. Called by `save()` only,
    /// after a successful save. A name that a record still lists (should not happen: every
    /// name is a new UUID) is kept, and so is every name when the records cannot be read; the
    /// next sweep deletes what is left.
    func removeBrewPhotoFilesOfSavedDeletes() {
        guard !brewPhotoFilesToRemove.isEmpty else {
            return
        }
        let names = brewPhotoFilesToRemove
        brewPhotoFilesToRemove.removeAll()
        guard let files = brewPhotoFiles else {
            return
        }
        let listed: Set<String>
        do {
            listed = Set(try context.fetch(FetchDescriptor<StoredBrewPhoto>()).map(\.fileName))
        } catch {
            brewPhotoLogger.error("The brew photos could not be read after a save; their files are left to the sweep.")
            return
        }
        for name in names where !listed.contains(name) {
            files.remove(name)
        }
    }

    // MARK: - Sweep

    /// Deletes what an earlier run left behind (at every store open, `SyncHost`): first the
    /// records whose brew is gone from the device or was removed by the user, with their files;
    /// then every file in the account's folder that no record lists, temporary files included.
    /// If the records cannot be read, no file is deleted. Never throws: a failed sweep is
    /// logged and tried again at the next open.
    @discardableResult
    func sweepBrewPhotos() -> BrewPhotoSweep {
        var sweep = BrewPhotoSweep()
        do {
            try write {
                let removed = SyncState.pendingDelete.rawValue
                let liveBrews = try context.fetch(FetchDescriptor<StoredBrew>(
                    predicate: #Predicate<StoredBrew> { brew in brew.syncStateRaw != removed }
                ))
                let liveIDs = Set(liveBrews.map(\.localID))
                for photo in try context.fetch(FetchDescriptor<StoredBrewPhoto>()) where !liveIDs.contains(photo.brewLocalID) {
                    stageRemoval(of: photo)
                    sweep.recordsRemoved += 1
                }
                if sweep.recordsRemoved > 0 {
                    try save()
                }
            }
        } catch {
            brewPhotoLogger.error("The brew photo sweep could not remove the photos of removed brews.")
            return BrewPhotoSweep()
        }
        guard let files = brewPhotoFiles else {
            return sweep
        }
        let listed: Set<String>
        do {
            listed = Set(try context.fetch(FetchDescriptor<StoredBrewPhoto>()).map(\.fileName))
        } catch {
            brewPhotoLogger.error("The brew photo sweep could not read the records; no file was deleted.")
            return sweep
        }
        sweep.filesRemoved = files.removeEntries(except: listed)
        return sweep
    }

    // MARK: - Helpers

    private static var newestBrewPhotoFirst: [SortDescriptor<StoredBrewPhoto>] {
        [
            SortDescriptor(\StoredBrewPhoto.createdAt, order: .reverse),
            SortDescriptor(\StoredBrewPhoto.fileName, order: .reverse),
        ]
    }

    private func brewPhotoRecords(ofBrewLocalID brewLocalID: UUID) throws -> [StoredBrewPhoto] {
        try context.fetch(FetchDescriptor<StoredBrewPhoto>(
            predicate: #Predicate<StoredBrewPhoto> { photo in photo.brewLocalID == brewLocalID },
            sortBy: AccountStore.newestBrewPhotoFirst
        ))
    }

    /// Deletes `photo`'s record from the context and stages its file for `save()`.
    private func stageRemoval(of photo: StoredBrewPhoto) {
        brewPhotoFilesToRemove.insert(photo.fileName)
        context.delete(photo)
    }
}
