import Foundation
import XCTest
@testable import Cupmark

/// Brew photo fixtures (M2-T42): fixed dates, temporary folders and small encoded photos drawn
/// in code. No wall-clock date is used for anything a test compares.
enum BrewPhotoFixtures {
    /// The fixed moment the photos of the tests are added at.
    static let start = Date(timeIntervalSince1970: 1_795_000_000)

    /// `start` plus `minutes`.
    static func at(minute minutes: Int) -> Date {
        start.addingTimeInterval(TimeInterval(minutes * 60))
    }

    /// A new temporary directory (not created yet).
    static func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(
            path: "BrewPhotoTests-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
    }

    /// A small upright photo, encoded as the store takes it.
    static func photo() throws -> EncodedBrewPhoto {
        try BrewPhotoEncoder.encode(try LabelPhotoEncoderTests.quadrantImage(width: 64, height: 48), orientation: .up)
    }

    /// The names in `files`' folder, sorted; hidden temporary files included.
    static func names(in files: BrewPhotoFileStore) -> [String] {
        files.entryNames().sorted()
    }

    static func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    /// A synced bean and shelf entry and a brew on it in `store`: synced with a server id, or
    /// made on the device (`pendingCreate`) when `serverID` is nil.
    static func brew(in store: AccountStore, entry: StoredShelfEntry? = nil, serverID: String? = StoreFixtures.brewID, minute: Int = 0) throws -> StoredBrew {
        let shelfEntry = try entry ?? StoreFixtures.syncedShelfEntry(in: store)
        var values = try StoreFixtures.brewInput()
        values.brewedAt = try XCTUnwrap(API.Timestamp(millisecondsSince1970: values.brewedAt.millisecondsSince1970 + Int64(minute) * 60_000))
        let brew = try StoredBrew(values, serverID: serverID)
        try store.addBrew(brew, shelfEntry: shelfEntry, syncState: serverID == nil ? .pendingCreate : .synced)
        return brew
    }
}
