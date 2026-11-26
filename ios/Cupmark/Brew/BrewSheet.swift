import SwiftUI

/// The sheet that logs a brew of a shelf entry and then offers to rate it (M2-T19, M2-T20).
///
/// It shows `BrewFormScreen` until the brew is saved, then `RatingScreen` for that brew in
/// its place, so the rating needs no extra tap and the saved form is not on the back stack.
/// The rating screen's "Later" closes the sheet; the brew stays unrated and can be rated from
/// the brew list.
struct BrewSheet: View {
    let store: AccountStore
    let route: BrewRoute
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// The brew once it was saved; the rating of it is then shown.
    @State private var savedBrewID: UUID?

    var body: some View {
        NavigationStack {
            if let savedBrewID {
                RatingScreen(store: store, brew: savedBrewID, mode: .afterBrew, vocabulary: vocabulary, language: language)
            } else {
                BrewFormScreen(
                    store: store,
                    shelfEntry: route.shelfEntryLocalID,
                    vocabulary: vocabulary,
                    language: language,
                    dismissesOnSave: false,
                    onSaved: { localID in
                        savedBrewID = localID
                    }
                )
            }
        }
    }
}
