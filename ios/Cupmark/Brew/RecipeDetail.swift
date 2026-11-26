import Combine
import Observation
import SwiftUI

/// One saved recipe, for the screen the photo viewer links to (M2-T43b). There was no recipe
/// detail screen before (recipes are rows that start a brew), so this one shows the recipe's
/// values and offers "Brew from This Recipe" through the existing start path (`BrewSheet` with
/// `BrewStart.recipe`), for the bag the viewer came from.
///
/// A recipe has no name (invariant 1): it is shown by its method, dose, ratio, temperature and
/// grind (`BrewSummary`). `reload()` reads the store again; the screen calls it when it appears
/// and after every save of the store.
@MainActor
@Observable
final class RecipeDetailModel {
    let store: AccountStore
    let recipeID: UUID
    /// The bag a new brew would be for; nil offers no brew.
    let shelfEntryID: UUID?

    /// The recipe's values; nil when it is gone (removed here, or on another device and pulled).
    private(set) var summary: BrewSummary?
    /// The bag exists and is not removed on the device.
    private(set) var bagExists = false
    private(set) var hasLoaded = false
    private(set) var loadFailed = false

    init(store: AccountStore, recipe recipeID: UUID, shelfEntry shelfEntryID: UUID?) {
        self.store = store
        self.recipeID = recipeID
        self.shelfEntryID = shelfEntryID
    }

    var isGone: Bool { hasLoaded && !loadFailed && summary == nil }

    /// A brew from the recipe is offered when the recipe and the bag are both there.
    var canBrew: Bool { summary != nil && bagExists }

    /// The brew sheet's route for a new brew of the bag from the recipe.
    var brewRoute: BrewRoute? {
        guard canBrew, let shelfEntryID else {
            return nil
        }
        return BrewRoute(shelfEntryLocalID: shelfEntryID, start: .recipe(recipeID))
    }

    func reload() {
        do {
            summary = try store.liveRecipe(localID: recipeID).map { recipe in BrewSummary(BrewDraft(recipe)) }
            if let shelfEntryID, let entry = try store.shelfEntry(localID: shelfEntryID) {
                bagExists = entry.syncState != .pendingDelete
            } else {
                bagExists = false
            }
            loadFailed = false
        } catch {
            loadFailed = true
        }
        hasLoaded = true
    }
}

/// A saved recipe's values, with "Brew from This Recipe" (M2-T43b). Nothing is typed.
///
/// Taps from the photo viewer: the recipe link (1), then "Brew from This Recipe" (1) opens the
/// brew form prefilled.
struct RecipeDetailScreen: View {
    @State private var model: RecipeDetailModel
    @State private var brewing: BrewRoute?
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    init(store: AccountStore, recipe: UUID, shelfEntry: UUID?, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: RecipeDetailModel(store: store, recipe: recipe, shelfEntry: shelfEntry))
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        List {
            if let summary = model.summary {
                Section {
                    BrewSummaryView(title: nil, summary: summary, vocabulary: vocabulary, language: language)
                        .accessibilityIdentifier("recipe-detail-values")
                    if let route = model.brewRoute {
                        Button {
                            brewing = route
                        } label: {
                            Label {
                                Text(L10n.recipeDetailBrew)
                            } icon: {
                                Image(systemName: "cup.and.saucer")
                                    .accessibilityHidden(true)
                            }
                            .minimumTapTarget()
                        }
                        .accessibilityHint(Text(L10n.recipeDetailBrewHint))
                        .accessibilityIdentifier("recipe-detail-brew")
                    }
                }
                .surfaceRow()
            } else if model.loadFailed {
                Text(L10n.shelfStoreErrorTitle)
                    .secondaryText()
                    .surfaceRow()
            } else if model.isGone {
                Text(L10n.recipeDetailNotFound)
                    .secondaryText()
                    .surfaceRow()
                    .accessibilityIdentifier("recipe-detail-not-found")
            }
        }
        .listBackground()
        .navigationTitle(Text(L10n.recipeDetailTitle))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $brewing) { route in
            BrewSheet(store: model.store, route: route, vocabulary: vocabulary, language: language)
        }
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }
}
