import Foundation
import Observation

/// One recipe in a list (M2-T27). A recipe has no name (invariant 1): it is shown by its
/// method, dose, ratio, temperature and grind (`BrewSummary`).
struct RecipeRow: Identifiable, Equatable, Sendable {
    /// The recipe's local id.
    let id: UUID
    let summary: BrewSummary
    let issue: SyncIssue?

    init(_ recipe: StoredRecipe) {
        id = recipe.localID
        summary = BrewSummary(BrewDraft(recipe))
        issue = recipe.syncIssue
    }
}

/// The repeats offered for a shelf entry (M2-T27, docs/04 F2): "Repeat Last Brew" and the
/// recipes, newest first, read from the local store so they work offline. One tap on either
/// opens a new brew for the entry, prefilled (`route(_:)`, `BrewSheet`). Recipes are removed
/// here too, through the outbox. `reload()` reads the store again; the screens call it after
/// every save of the store (`AccountStore.didSaveNotification`).
@MainActor
@Observable
final class BrewStartModel {
    /// How many recipes the shelf entry's screen lists itself; "All Recipes" shows the rest.
    static let inlineRecipeLimit = 3

    let shelfEntryLocalID: UUID
    let store: AccountStore
    /// What "Repeat Last Brew" copies, nil while the device has no brew (or the entry is gone).
    private(set) var lastBrew: BrewSummary?
    private(set) var recipes: [RecipeRow] = []
    /// True when the last read of the store failed.
    private(set) var loadFailed = false
    /// True when the last removal failed; nothing was changed.
    private(set) var deleteFailed = false

    init(shelfEntry localID: UUID, store: AccountStore) {
        shelfEntryLocalID = localID
        self.store = store
    }

    /// The recipes the entry's screen lists itself.
    var inlineRecipes: [RecipeRow] {
        Array(recipes.prefix(BrewStartModel.inlineRecipeLimit))
    }

    /// Whether there are more recipes than the entry's screen lists.
    var hasMoreRecipes: Bool {
        recipes.count > BrewStartModel.inlineRecipeLimit
    }

    /// The brew sheet's route for a new brew of the entry from `start`.
    func route(_ start: BrewStart) -> BrewRoute {
        BrewRoute(shelfEntryLocalID: shelfEntryLocalID, start: start)
    }

    func reload() {
        do {
            if let entry = try store.shelfEntry(localID: shelfEntryLocalID), entry.syncState != .pendingDelete {
                lastBrew = try store.lastBrewToRepeat(for: entry).map { brew in BrewSummary(BrewDraft(brew)) }
            } else {
                lastBrew = nil
            }
            recipes = try store.recipes().map { recipe in RecipeRow(recipe) }
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    /// Removes the recipe on the device and queues its delete (`AccountStore.deleteRecipe`).
    /// A recipe that is already gone is left as it is.
    func delete(_ recipeID: UUID) {
        do {
            if let recipe = try store.liveRecipe(localID: recipeID) {
                try store.deleteRecipe(recipe)
            }
            deleteFailed = false
        } catch {
            deleteFailed = true
        }
        reload()
    }
}
