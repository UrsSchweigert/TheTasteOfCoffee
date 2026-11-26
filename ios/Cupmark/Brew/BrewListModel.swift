import Foundation
import Observation

/// One brew in the brew list of a shelf entry (M2-T20).
struct BrewListRow: Identifiable, Equatable, Sendable {
    /// The brew's local id.
    let id: UUID
    let brewedAt: Date
    /// Nil for a method the bundled vocabulary does not know.
    let method: Vocabulary.Method?
    let isRated: Bool
    let issue: SyncIssue?

    init(_ brew: StoredBrew) {
        id = brew.localID
        brewedAt = brew.brewedAt
        method = brew.method
        isRated = brew.rating != nil
        issue = brew.syncIssue
    }
}

/// The brews of one shelf entry, newest first, read from the local store so it works
/// offline (M2-T20). Each opens its rating. `reload()` reads the store again; the screen
/// calls it after every save of the store (`AccountStore.didSaveNotification`).
@MainActor
@Observable
final class BrewListModel {
    let shelfEntryLocalID: UUID
    let store: AccountStore
    private(set) var rows: [BrewListRow] = []
    /// The entry is gone (removed here, or on another device and pulled).
    private(set) var entryMissing = false
    /// True when the last read of the store failed.
    private(set) var loadFailed = false

    init(shelfEntry localID: UUID, store: AccountStore) {
        shelfEntryLocalID = localID
        self.store = store
    }

    func reload() {
        do {
            guard let entry = try store.shelfEntry(localID: shelfEntryLocalID), entry.syncState != .pendingDelete else {
                rows = []
                entryMissing = true
                loadFailed = false
                return
            }
            rows = entry.liveBrewsNewestFirst.map { brew in BrewListRow(brew) }
            entryMissing = false
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}
