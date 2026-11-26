import Combine
import SwiftUI

/// Opens the brew form for a shelf entry (M2-T19), empty or as a repeat (M2-T27).
struct BrewRoute: Identifiable, Hashable {
    /// The shelf entry's local id.
    let shelfEntryLocalID: UUID
    /// What the new brew starts from.
    var start: BrewStart = .blank

    var id: BrewRoute { self }
}

/// The brew form of a shelf entry (M2-T19, docs/04 F2), shown in a sheet.
///
/// - Method: a pick list, required. Dose, water or yield, temperature and normalised grind:
///   steppers whose bounds and steps come from `Vocabulary.Ranges` through `BrewNumberField`.
///   Temperature is a temperature in °C or `cold`, never both. Water type and milk: pick lists.
///   Nothing is typed (invariant 1), and everything but the method is optional.
/// - Only the fields the method allows are shown (M2-T26, the generated rules of vocabulary
///   v3 through `BrewFormModel.shows(_:)`); picking another method clears the others. The
///   grinder is a pick list with an A to Z index and the grinders of recent brews; the grind
///   setting is a stepper on the grinder's own scale and is hidden for a grinder without one.
/// - Brew time: the brew timer (M2-T21, `BrewTimerRow`); Stop fills `brew_time_s`.
/// - The ratio and days since roast follow the values as they change.
/// - Save writes through `BrewFormModel` to `AccountStore`, which queues the create in the
///   outbox, so it works offline. In `BrewSheet` the rating of the new brew follows (M2-T20).
/// - A repeat (M2-T27) opens prefilled and says what it was copied from; a toggle keeps the
///   values as a recipe, or replaces the recipe the form was started from.
struct BrewFormScreen: View {
    @State private var model: BrewFormModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Called after a save with the brew's local id, just before the sheet closes.
    let onSaved: @MainActor (UUID) -> Void
    /// Whether the screen closes itself after a save. `BrewSheet` keeps it open and shows the
    /// rating in its place instead (M2-T20).
    let dismissesOnSave: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    init(
        store: AccountStore,
        shelfEntry localID: UUID,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        dismissesOnSave: Bool = true,
        onSaved: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        self.init(
            model: BrewFormModel(shelfEntry: localID, store: store),
            vocabulary: vocabulary,
            language: language,
            dismissesOnSave: dismissesOnSave,
            onSaved: onSaved
        )
    }

    /// The form of `model`, which `BrewSheet`'s flow holds (M2-T27).
    init(
        model: BrewFormModel,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        dismissesOnSave: Bool = true,
        onSaved: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        _model = State(initialValue: model)
        self.vocabulary = vocabulary
        self.language = language
        self.dismissesOnSave = dismissesOnSave
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            beanSection
            methodSection
            amountsSection
            if model.shows(.brewTimeS) {
                timerSection
            }
            waterSection
            grindAndMilkSection
            recipeSection
            if let failure = model.failure {
                Section {
                    Label {
                        Text(BrewFormScreen.message(for: failure))
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("brew-error")
                }
            }
        }
        .navigationTitle(Text(L10n.brewTitle))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    dismiss()
                } label: {
                    Text(L10n.brewCancel)
                }
                .accessibilityIdentifier("brew-cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    save()
                } label: {
                    Text(L10n.brewSave)
                }
                .disabled(!model.canSave)
                .accessibilityIdentifier("brew-save")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            // A pull may have removed the entry or changed its roast date meanwhile.
            model.refresh()
        }
    }

    // MARK: - Sections

    private var beanSection: some View {
        Section {
            if let note = startNote {
                Label {
                    Text(note)
                } icon: {
                    Image(systemName: "arrow.clockwise")
                        .accessibilityHidden(true)
                }
                .accessibilityIdentifier("brew-started-from")
            }
            BeanSummaryView(summary: model.bean, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("brew-bean")
            if let days = model.daysSinceRoast {
                LabeledContent {
                    Text(days, format: .number)
                } label: {
                    Text(L10n.shelfDaysSinceRoast)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("brew-days-since-roast")
            }
        } header: {
            Text(L10n.brewBeanHeader)
        }
    }

    private var methodSection: some View {
        Section {
            Picker(selection: $model.draft.method) {
                Text(L10n.brewMethodChoose)
                    .tag(Optional<Vocabulary.Method>.none)
                ForEach(Vocabulary.Method.allCases) { method in
                    Text(verbatim: VocabularyLabels.label(for: method, in: vocabulary, language: language))
                        .tag(Optional<Vocabulary.Method>.some(method))
                }
            } label: {
                Text(L10n.brewMethod)
            }
            .accessibilityIdentifier("brew-method")
        } footer: {
            Text(L10n.brewMethodFooter)
        }
    }

    private var amountsSection: some View {
        Section {
            if model.shows(.doseDg) {
                stepperRow(.dose, title: L10n.brewDose, clearLabel: L10n.brewDoseClear, identifier: "brew-dose")
            }
            if model.shows(.waterG) {
                stepperRow(.water, title: L10n.brewWater, clearLabel: L10n.brewWaterClear, identifier: "brew-water")
            }
            if model.shows(.doseDg) && model.shows(.waterG) {
                ratioRow
            }
        } header: {
            Text(L10n.brewAmountsHeader)
        }
    }

    private var ratioRow: some View {
        Group {
            LabeledContent {
                if let ratio = model.ratioText(locale: locale) {
                    Text(verbatim: ratio)
                        .monospacedDigit()
                } else {
                    Text(L10n.brewRatioMissing)
                        .foregroundStyle(.secondary)
                }
            } label: {
                Text(L10n.brewRatio)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(L10n.brewRatioAccessibility))
            .accessibilityValue(ratioAccessibilityValue)
            .accessibilityIdentifier("brew-ratio")
        }
    }

    private var timerSection: some View {
        Section {
            BrewTimerRow(
                timer: model.timer,
                brewTimeS: model.draft.brewTimeS,
                onStart: { model.startTimer() },
                onStop: { model.stopTimer(locale: locale) },
                onReset: { model.resetTimer() }
            )
        } header: {
            Text(L10n.brewTimerHeader)
        } footer: {
            Text(L10n.brewTimerFooter)
        }
    }

    private var waterSection: some View {
        Section {
            // The choices are those of the method: a temperature in °C, `cold` (cold brew), both
            // or neither (moka pot, cezve). With nothing to choose, the picker is not shown.
            if model.offersTemperatureChoice {
                Picker(selection: $model.temperatureChoice) {
                    ForEach(model.temperatureChoices, id: \.self) { choice in
                        temperatureLabel(choice)
                            .tag(choice)
                    }
                } label: {
                    Text(L10n.brewTemperature)
                }
                .accessibilityIdentifier("brew-temperature-choice")
            }
            if model.shows(.waterTempC) && model.temperatureChoice == .celsius {
                stepperRow(.temperature, title: L10n.brewTemperatureValue, clearLabel: L10n.brewTemperatureClear, identifier: "brew-temperature")
            }
            if model.shows(.waterType) {
                OptionalVocabularyPicker(title: L10n.brewWaterType, selection: $model.draft.waterType, vocabulary: vocabulary, language: language)
                    .accessibilityIdentifier("brew-water-type")
            }
        } header: {
            Text(L10n.brewWaterHeader)
        }
    }

    private var grindAndMilkSection: some View {
        Section {
            if model.shows(.grinder) {
                grinderRow
            }
            if let range = model.grindSettingRange {
                grindSettingRow(range)
            }
            if model.shows(.grindNormalised) {
                stepperRow(.grind, title: L10n.brewGrind, clearLabel: L10n.brewGrindClear, identifier: "brew-grind")
            }
            if model.shows(.milk) {
                OptionalVocabularyPicker(title: L10n.brewMilk, selection: $model.draft.milk, vocabulary: vocabulary, language: language)
                    .accessibilityIdentifier("brew-milk")
            }
        } header: {
            Text(L10n.brewMoreHeader)
        } footer: {
            Text(L10n.brewOfflineNote)
        }
    }

    /// Keeps the values as a recipe on save (M2-T27): a new recipe, or the recipe the form was
    /// started from, replaced. A recipe has no name, so there is nothing else to set.
    private var recipeSection: some View {
        Section {
            Toggle(isOn: $model.keepsAsRecipe) {
                Text(model.replacesStartedRecipe ? L10n.brewRecipeUpdate : L10n.brewRecipeSave)
            }
            .disabled(model.savedBrewID != nil)
            .accessibilityIdentifier("brew-keep-recipe")
        } header: {
            Text(L10n.recipeHeader)
        } footer: {
            if model.valuesAreAnotherRecipe {
                // Keeping them keeps that recipe; two equal recipes are never made (ADR 0028).
                Text(L10n.brewRecipeAlreadyKept)
                    .accessibilityIdentifier("brew-recipe-already-kept")
            } else {
                Text(L10n.recipeFooter)
            }
        }
    }

    /// What a repeat was copied from, nil for an empty form.
    private var startNote: LocalizedStringKey? {
        switch model.startedFrom {
        case .blank:
            return nil
        case .lastBrew:
            return L10n.brewStartedFromLastBrew
        case .recipe:
            return L10n.brewStartedFromRecipe
        }
    }

    // MARK: - Rows

    /// The grinder: a pushed list with an A to Z index and "Recent", no search field. Includes
    /// `pre_ground` and the grinders without a scale; the labels are the contract's.
    private var grinderRow: some View {
        IndexedPickListRow(
            title: L10n.brewGrinder,
            selection: $model.grinder,
            vocabulary: vocabulary,
            language: language,
            sections: { [vocabulary, language] in
                PickListSections.alphabetical(Vocabulary.Grinder.self, locale: BeanEntryScreen.locale(for: language)) { grinder in
                    VocabularyLabels.label(for: grinder, in: vocabulary, language: language)
                }
            },
            recents: model.recentGrinders
        )
        .accessibilityIdentifier("brew-grinder")
    }

    /// The grind setting on the grinder's own scale (range and step from the vocabulary). Only
    /// shown for a grinder with a scale.
    private func grindSettingRow(_ range: VocabularyRange) -> some View {
        BrewStepperRow(
            title: L10n.brewGrindSetting,
            clearLabel: L10n.brewGrindSettingClear,
            valueText: model.grindSettingText(locale: locale),
            onIncrement: { model.incrementGrindSetting() },
            onDecrement: { model.decrementGrindSetting() },
            onClear: { model.clearGrindSetting() }
        )
        .accessibilityIdentifier("brew-grind-setting")
    }

    private func stepperRow(
        _ field: BrewNumberField,
        title: LocalizedStringKey,
        clearLabel: LocalizedStringKey,
        identifier: String
    ) -> some View {
        BrewStepperRow(
            title: title,
            clearLabel: clearLabel,
            valueText: model.valueText(of: field, locale: locale),
            onIncrement: { model.increment(field) },
            onDecrement: { model.decrement(field) },
            onClear: { model.clear(field) }
        )
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private func temperatureLabel(_ choice: BrewDraft.TemperatureChoice) -> some View {
        switch choice {
        case .notSet:
            Text(L10n.lookupPickNotSet)
        case .celsius:
            Text(L10n.brewTemperatureHeated)
        case .special(let special):
            Text(verbatim: VocabularyLabels.label(for: special, in: vocabulary, language: language))
        }
    }

    private var ratioAccessibilityValue: Text {
        if let number = model.ratioNumberText(locale: locale) {
            return Text(verbatim: number)
        }
        return Text(L10n.brewRatioMissing)
    }

    // MARK: - Actions

    private func save() {
        guard let localID = model.save() else {
            return
        }
        onSaved(localID)
        if dismissesOnSave {
            dismiss()
        }
    }

    static func message(for failure: BrewFormModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .notFound: L10n.brewNotFound
        case .saveFailed: L10n.brewSaveFailed
        case .startNotFound: L10n.brewStartNotFound
        }
    }
}

/// One numeric field of the brew form: a stepper with the value (or "Not set"), and a button
/// that clears a set value. The first tap on a field that is not set turns it on. VoiceOver
/// reads the title and the value and adjusts with swipes up and down. At accessibility text
/// sizes the title and the value stack.
struct BrewStepperRow: View {
    let title: LocalizedStringKey
    let clearLabel: LocalizedStringKey
    let valueText: String?
    let onIncrement: @MainActor () -> Void
    let onDecrement: @MainActor () -> Void
    let onClear: @MainActor () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 12) {
            Stepper {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(spacing: 8))
                layout {
                    Text(title)
                    if !dynamicTypeSize.isAccessibilitySize {
                        Spacer(minLength: 0)
                    }
                    if let valueText {
                        Text(verbatim: valueText)
                            .monospacedDigit()
                    } else {
                        Text(L10n.lookupPickNotSet)
                            .foregroundStyle(.secondary)
                    }
                }
            } onIncrement: {
                onIncrement()
            } onDecrement: {
                onDecrement()
            }
            .accessibilityLabel(Text(title))
            .accessibilityValue(accessibilityValue)
            if valueText != nil {
                Button {
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text(clearLabel))
            }
        }
    }

    private var accessibilityValue: Text {
        if let valueText {
            return Text(verbatim: valueText)
        }
        return Text(L10n.lookupPickNotSet)
    }
}
