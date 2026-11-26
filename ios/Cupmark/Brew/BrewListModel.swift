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
    /// Whether a recipe with exactly the brew's parameters is on the device (M2-T27).
    let isRecipe: Bool

    init(_ brew: StoredBrew, recipes: Set<API.BrewParameters> = []) {
        id = brew.localID
        brewedAt = brew.brewedAt
        method = brew.method
        isRated = brew.rating != nil
        issue = brew.syncIssue
        // A recipe kept from the brew leaves out what the method does not allow (M2-T26).
        isRecipe = (try? brew.apiParameters()).map { parameters in
            recipes.contains(parameters) || recipes.contains(parameters.conformingToMethodRules())
        } ?? false
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
    /// True when the last "Save as Recipe" failed; nothing was changed (M2-T27).
    private(set) var recipeSaveFailed = false

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
            let recipes = Set(try store.recipes().compactMap { recipe in try? recipe.apiParameters() })
            rows = entry.liveBrewsNewestFirst.map { brew in BrewListRow(brew, recipes: recipes) }
            entryMissing = false
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    /// Keeps the brew's parameters as a recipe (M2-T27, `AccountStore.saveRecipe`), offline
    /// through the outbox. A recipe with the same parameters is kept as it is. A brew with an
    /// id the bundled vocabulary does not know cannot be kept and changes nothing.
    func saveAsRecipe(_ brewID: UUID) {
        do {
            if let brew = try store.brew(localID: brewID), brew.syncState != .pendingDelete {
                try store.saveRecipe(try brew.apiParameters())
            }
            recipeSaveFailed = false
        } catch {
            recipeSaveFailed = true
        }
        reload()
    }
}
