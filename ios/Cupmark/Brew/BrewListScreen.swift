import Combine
import SwiftUI

/// The brews of one shelf entry (M2-T20), newest first, read from the local store. Each row
/// shows when it was brewed, the method and whether it is rated, and opens its rating, so a
/// brew can be rated later (docs/04 F3). Reached from the shelf entry's screen.
struct BrewListScreen: View {
    @State private var model: BrewListModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    init(store: AccountStore, shelfEntry localID: UUID, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: BrewListModel(shelfEntry: localID, store: store))
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        List {
            if model.loadFailed {
                Text(L10n.shelfStoreErrorTitle)
                    .secondaryText()
                    .surfaceRow()
            } else if model.entryMissing {
                Text(L10n.brewNotFound)
                    .secondaryText()
                    .surfaceRow()
                    .accessibilityIdentifier("brew-list-not-found")
            } else if model.rows.isEmpty {
                Text(L10n.brewListEmpty)
                    .secondaryText()
                    .surfaceRow()
                    .accessibilityIdentifier("brew-list-empty")
            } else {
                ForEach(model.rows) { row in
                    // A value link: the rating screen and its model are made only when it opens.
                    NavigationLink(value: BrewRatingRoute(brewLocalID: row.id)) {
                        BrewListRowView(row: row, vocabulary: vocabulary, language: language)
                    }
                    .accessibilityIdentifier("brew-list-row")
                    .surfaceRow()
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        // Keeps the brew's parameters as a recipe (M2-T27); VoiceOver lists it
                        // as an action.
                        if !row.isRecipe {
                            Button {
                                model.saveAsRecipe(row.id)
                            } label: {
                                Label {
                                    Text(L10n.brewListSaveAsRecipe)
                                } icon: {
                                    Image(systemName: "bookmark")
                                }
                            }
                            .tint(Theme.swipeAction)
                            .accessibilityIdentifier("brew-list-save-recipe")
                        }
                    }
                }
                if model.recipeSaveFailed {
                    Text(L10n.brewListRecipeSaveFailed)
                        .secondaryText()
                        .surfaceRow()
                }
            }
        }
        .listBackground()
        // No destination is registered here (M2-T40): this view is itself pushed, and a
        // destination declared inside a pushed view can be lost when the stack rebuilds it.
        // `BrewRatingRoute` is registered at the stack root, by `brewNavigationDestinations`.
        .navigationTitle(Text(L10n.brewListTitle))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }
}

/// One brew in the list: the time it was brewed, the method, rated or not, and a sync issue.
struct BrewListRowView: View {
    let row: BrewListRow
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.brewedAt, format: DisplayDate.dayAndTime)
                .font(.headline)
            if let method = row.method {
                Text(verbatim: VocabularyLabels.label(for: method, in: vocabulary, language: language))
                    .font(.subheadline)
            }
            Label {
                Text(row.isRated ? L10n.brewListRated : L10n.brewListNotRated)
            } icon: {
                Image(systemName: row.isRated ? "star.fill" : "star")
                    .accessibilityHidden(true)
            }
            .font(.subheadline)
            .foregroundStyle(row.isRated ? Theme.accent : Theme.textSecondary)
            if row.isRecipe {
                Label {
                    Text(L10n.brewListIsRecipe)
                } icon: {
                    Image(systemName: "bookmark.fill")
                        .accessibilityHidden(true)
                }
                .font(.subheadline)
                .secondaryText()
            }
            if row.issue != nil {
                Label {
                    Text(L10n.shelfRowIssue)
                } icon: {
                    Image(systemName: "exclamationmark.icloud")
                        .foregroundStyle(Theme.errorText)
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .secondaryText()
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
