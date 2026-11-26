import SwiftUI

/// Pushes the brew list of a stored shelf entry (M2-T40).
struct BrewListRoute: Hashable {
    let shelfEntryLocalID: UUID
}

/// Pushes the rating of a brew from the brew list.
struct BrewRatingRoute: Hashable {
    let brewLocalID: UUID
}

/// Pushes a saved recipe (M2-T43b, from the brew photo viewer). `shelfEntryLocalID` is the bag a
/// brew from the recipe would be for; nil offers none.
struct BrewRecipeRoute: Hashable {
    let recipeLocalID: UUID
    let shelfEntryLocalID: UUID?
}

extension View {
    /// Registers the destinations of the brew routes. Call it on a view that stays at the root
    /// of its `NavigationStack` (the shelf), never inside a pushed screen: a
    /// `navigationDestination(for:)` declared in a pushed view can be lost when the stack
    /// rebuilds it, and SwiftUI then shows an empty screen with a warning triangle (M2-T40).
    func brewNavigationDestinations(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) -> some View {
        self
            .navigationDestination(for: BrewListRoute.self) { route in
                BrewListScreen(store: store, shelfEntry: route.shelfEntryLocalID, vocabulary: vocabulary, language: language)
            }
            .navigationDestination(for: BrewRatingRoute.self) { route in
                RatingScreen(store: store, brew: route.brewLocalID, mode: .later, vocabulary: vocabulary, language: language)
            }
            .navigationDestination(for: BrewRecipeRoute.self) { route in
                RecipeDetailScreen(
                    store: store,
                    recipe: route.recipeLocalID,
                    shelfEntry: route.shelfEntryLocalID,
                    vocabulary: vocabulary,
                    language: language
                )
            }
    }
}
