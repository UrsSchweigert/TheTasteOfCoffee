import SwiftUI

/// The sheet that logs a brew of a shelf entry and then offers to rate it (M2-T19, M2-T20).
///
/// It shows `BrewFormScreen` until the brew is saved, then `RatingScreen` for that brew in
/// its place, so the rating needs no extra tap and the saved form is not on the back stack.
/// The rating screen's "Later" closes the sheet; the brew stays unrated and can be rated from
/// the brew list. A repeat (M2-T27, `BrewRoute.start`) opens the form prefilled with the last
/// brew or a recipe; `BrewFlowModel` holds the flow.
struct BrewSheet: View {
    let store: AccountStore
    let route: BrewRoute
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @State private var flow: BrewFlowModel

    init(store: AccountStore, route: BrewRoute, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.store = store
        self.route = route
        self.vocabulary = vocabulary
        self.language = language
        _flow = State(initialValue: BrewFlowModel(route: route, store: store))
    }

    var body: some View {
        NavigationStack {
            switch flow.phase {
            case .rating(let savedBrewID):
                RatingScreen(store: store, brew: savedBrewID, mode: .afterBrew, vocabulary: vocabulary, language: language)
            case .brewing:
                BrewFormScreen(
                    model: flow.form,
                    vocabulary: vocabulary,
                    language: language,
                    dismissesOnSave: false
                )
            }
        }
    }
}
