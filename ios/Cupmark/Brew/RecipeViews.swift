import Combine
import SwiftUI

/// The repeats of a shelf entry's screen (M2-T27): "Repeat Last Brew" and the newest recipes,
/// each one tap from a new brew of the entry, prefilled, with the timer ready. Swiping a recipe
/// removes it (offline, through the outbox). "All Recipes" lists the rest.
struct BrewStartSection: View {
    let model: BrewStartModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Opens the brew sheet with the route.
    let onStart: @MainActor (BrewRoute) -> Void

    var body: some View {
        Section {
            if let lastBrew = model.lastBrew {
                Button {
                    onStart(model.route(.lastBrew))
                } label: {
                    BrewSummaryView(title: L10n.brewRepeatLast, summary: lastBrew, vocabulary: vocabulary, language: language)
                }
                .accessibilityHint(Text(L10n.brewRepeatHint))
                .accessibilityIdentifier("brew-repeat-last")
            }
            ForEach(model.inlineRecipes) { row in
                RecipeButton(row: row, model: model, vocabulary: vocabulary, language: language, onStart: onStart)
            }
            .onDelete { offsets in
                let rows = model.inlineRecipes
                for index in offsets where rows.indices.contains(index) {
                    model.delete(rows[index].id)
                }
            }
            if model.hasMoreRecipes {
                NavigationLink {
                    RecipeListScreen(model: model, vocabulary: vocabulary, language: language)
                } label: {
                    LabeledContent {
                        Text(model.recipes.count, format: .number)
                    } label: {
                        Text(L10n.recipeListTitle)
                    }
                }
                .accessibilityIdentifier("recipe-list")
            }
            if model.deleteFailed {
                Text(L10n.recipeDeleteFailed)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(L10n.brewRepeatHeader)
        } footer: {
            if model.lastBrew == nil && model.recipes.isEmpty {
                Text(L10n.recipeEmpty)
            } else {
                Text(L10n.brewRepeatFooter)
            }
        }
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }
}

/// Every recipe, newest first (M2-T27). A tap opens a new brew of the shelf entry from it;
/// swiping removes it.
struct RecipeListScreen: View {
    let model: BrewStartModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @State private var brewing: BrewRoute?

    /// Written out because the private state above would otherwise limit the memberwise one
    /// (the UI tests open this screen on its own, M2-T33).
    init(model: BrewStartModel, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.model = model
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        List {
            if model.loadFailed {
                Text(L10n.shelfStoreErrorTitle)
                    .foregroundStyle(.secondary)
            } else if model.recipes.isEmpty {
                Text(L10n.recipeEmpty)
                    .foregroundStyle(.secondary)
            } else {
                Section {
                    ForEach(model.recipes) { row in
                        RecipeButton(row: row, model: model, vocabulary: vocabulary, language: language) { route in
                            brewing = route
                        }
                    }
                    .onDelete { offsets in
                        let rows = model.recipes
                        for index in offsets where rows.indices.contains(index) {
                            model.delete(rows[index].id)
                        }
                    }
                } footer: {
                    if model.deleteFailed {
                        Text(L10n.recipeDeleteFailed)
                    } else {
                        Text(L10n.brewRepeatFooter)
                    }
                }
            }
        }
        .navigationTitle(Text(L10n.recipeListTitle))
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

/// One recipe as a button that starts a brew from it. A recipe without a known method (one
/// picked with a newer vocabulary) still opens, and the method is picked in the form.
private struct RecipeButton: View {
    let row: RecipeRow
    let model: BrewStartModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let onStart: @MainActor (BrewRoute) -> Void

    var body: some View {
        Button {
            onStart(model.route(.recipe(row.id)))
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                BrewSummaryView(title: nil, summary: row.summary, vocabulary: vocabulary, language: language)
                if row.issue != nil {
                    Label {
                        Text(L10n.shelfRowIssue)
                    } icon: {
                        Image(systemName: "exclamationmark.icloud")
                            .accessibilityHidden(true)
                    }
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
            }
            .accessibilityElement(children: .combine)
        }
        .accessibilityHint(Text(L10n.brewRepeatHint))
        .accessibilityIdentifier("recipe-row")
    }
}

/// A brew's parameters in two lines: the method (with a title above it, if given), then the
/// dose, ratio, temperature and grind that are set. Text styles only, so it follows Dynamic
/// Type; VoiceOver reads it as one element.
struct BrewSummaryView: View {
    let title: LocalizedStringKey?
    let summary: BrewSummary
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let title {
                Text(title)
                    .font(.headline)
            }
            methodText
                .font(title == nil ? .headline : .subheadline)
            let line = summary.detailLine(locale: locale) { special in
                VocabularyLabels.label(for: special, in: vocabulary, language: language)
            }
            if !line.isEmpty {
                Text(verbatim: line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var methodText: some View {
        if let method = summary.method {
            Text(verbatim: VocabularyLabels.label(for: method, in: vocabulary, language: language))
        } else {
            Text(L10n.recipeUnknownMethod)
        }
    }
}
