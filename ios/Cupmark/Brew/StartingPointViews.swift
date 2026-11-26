import Combine
import SwiftUI

// Starting points: the reference recipes in the recipe list (M2-T47, ADR 0034).
//
// The recipe list shows one row per method that has reference recipes; a method opens its
// recipes; a recipe shows its numbers and one action copies it into the user's own recipes.
// Every screen says the recipes are reference recipes from published sources, never community
// data and never ratings. Nothing is typed (invariant 1), nothing is read from the network.
//
// Taps from the recipe list: a method (1), a recipe (2), "Copy to My Recipes" (3). Copying
// does not change the repeat path: a copied recipe is an ordinary recipe, one tap from a brew.

/// The "Starting Points" section of the recipe list: one row per method, with the number of
/// reference recipes. Nothing at all when the set has no recipe (no section, no empty text).
struct StartingPointsSection: View {
    let set: ReferenceRecipeSet
    let store: AccountStore
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        let groups = set.groups
        if !groups.isEmpty {
            Section {
                ForEach(groups) { group in
                    let methodLabel = VocabularyLabels.label(for: group.method, in: vocabulary, language: language)
                    NavigationLink {
                        StartingPointGroupScreen(group: group, store: store, vocabulary: vocabulary, language: language)
                    } label: {
                        LabeledContent {
                            Text(group.recipes.count, format: .number)
                        } label: {
                            Text(verbatim: methodLabel)
                        }
                        .minimumTapTarget()
                    }
                    .accessibilityLabel(Text(verbatim: methodLabel))
                    .accessibilityValue(Text(verbatim: L10n.startingPointsGroupCount(group.recipes.count.formatted())))
                    .accessibilityHint(Text(L10n.startingPointsGroupHint))
                    .accessibilityIdentifier("starting-point-group")
                }
            } header: {
                Text(L10n.startingPointsTitle)
                    .secondaryText()
            } footer: {
                Text(L10n.startingPointsFooter)
                    .secondaryText()
            }
            .surfaceRow()
        }
    }
}

/// The reference recipes of one method.
struct StartingPointGroupScreen: View {
    let group: ReferenceRecipeGroup
    let store: AccountStore
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        List {
            Section {
                ForEach(group.recipes) { recipe in
                    NavigationLink {
                        StartingPointScreen(recipe: recipe, store: store, vocabulary: vocabulary, language: language)
                    } label: {
                        BrewSummaryView(title: nil, summary: recipe.summary, vocabulary: vocabulary, language: language)
                            .minimumTapTarget()
                    }
                    .accessibilityHint(Text(L10n.startingPointRowHint))
                    .accessibilityIdentifier("starting-point-row")
                }
            } footer: {
                Text(L10n.startingPointsFooter)
                    .secondaryText()
            }
            .surfaceRow()
        }
        .listBackground()
        .navigationTitle(Text(verbatim: VocabularyLabels.label(for: group.method, in: vocabulary, language: language)))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One reference recipe: its numbers, the inferred ones marked, and the copy into the user's
/// own recipes. VoiceOver reads each number as "label, value" (an estimated one as "value,
/// estimated"); the copy button is at least 44 points high and its state follows the store, so
/// a recipe that is already the user's shows "Already in your recipes" instead of the button.
struct StartingPointScreen: View {
    @State private var model: StartingPointModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.locale) private var locale

    init(recipe: ReferenceRecipe, store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: StartingPointModel(recipe: recipe, store: store))
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        let numbers = StartingPointNumbers.make(for: model.recipe, vocabulary: vocabulary, language: language, locale: locale)
        List {
            Section {
                ForEach(numbers) { number in
                    StartingPointNumberRow(number: number)
                }
            } header: {
                Text(verbatim: VocabularyLabels.label(for: model.recipe.method, in: vocabulary, language: language))
                    .secondaryText()
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n.startingPointFooter)
                    if numbers.contains(where: \.isInferred) {
                        Text(L10n.startingPointInferredFooter)
                    }
                }
                .secondaryText()
            }
            .surfaceRow()
            copySection
        }
        .listBackground()
        .navigationTitle(Text(L10n.startingPointTitle))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }

    private var copySection: some View {
        Section {
            if model.isKept {
                Label {
                    if model.justCopied {
                        Text(verbatim: L10n.startingPointCopied())
                    } else {
                        Text(L10n.startingPointKept)
                    }
                } icon: {
                    Image(systemName: "checkmark.circle")
                        .accessibilityHidden(true)
                }
                .minimumTapTarget()
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("starting-point-kept")
            } else {
                Button {
                    if model.copy() {
                        BrewTimerModel.postAnnouncement(L10n.startingPointCopied())
                    }
                } label: {
                    Label {
                        Text(L10n.startingPointCopy)
                    } icon: {
                        Image(systemName: "square.and.arrow.down")
                            .accessibilityHidden(true)
                    }
                    .minimumTapTarget()
                }
                .accessibilityHint(Text(L10n.startingPointCopyHint))
                .accessibilityIdentifier("starting-point-copy")
            }
            if model.copyFailed {
                Text(L10n.startingPointCopyFailed)
                    .foregroundStyle(Theme.errorText)
            }
            if model.loadFailed {
                Text(L10n.shelfStoreErrorTitle)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }
}

/// One number of a reference recipe: its name, its value, and "Estimated" below an inferred
/// value (text, not only colour). Stacks at the accessibility text sizes. VoiceOver reads it
/// as one element, "Brew Time, 2 minutes, 30 seconds".
private struct StartingPointNumberRow: View {
    let number: StartingPointNumber
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            Text(verbatim: number.title)
                .secondaryText()
            if !dynamicTypeSize.isAccessibilitySize {
                Spacer(minLength: 0)
            }
            VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 2) {
                Text(verbatim: number.value)
                    .monospacedDigit()
                    .multilineTextAlignment(.leading)
                if number.isInferred {
                    Text(verbatim: L10n.startingPointInferred())
                        .font(.footnote)
                        .secondaryText()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: number.title))
        .accessibilityValue(Text(verbatim: number.spokenValue))
        .accessibilityIdentifier("starting-point-\(number.field.rawValue)")
    }
}
