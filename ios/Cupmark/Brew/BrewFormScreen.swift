import Combine
import SwiftUI

/// Opens the brew form for a shelf entry (M2-T19).
struct BrewRoute: Identifiable, Hashable {
    /// The shelf entry's local id.
    let shelfEntryLocalID: UUID

    var id: UUID { shelfEntryLocalID }
}

/// The brew form of a shelf entry (M2-T19, docs/04 F2), shown in a sheet.
///
/// - Method: a pick list, required. Dose, water or yield, temperature and normalised grind:
///   steppers whose bounds and steps come from `Vocabulary.Ranges` through `BrewNumberField`.
///   Temperature is a temperature in °C or `cold`, never both. Water type and milk: pick lists.
///   Nothing is typed (invariant 1), and everything but the method is optional.
/// - The ratio and days since roast follow the values as they change.
/// - Save writes through `BrewFormModel` to `AccountStore`, which queues the create in the
///   outbox, so it works offline.
struct BrewFormScreen: View {
    @State private var model: BrewFormModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Called after a save with the brew's local id, just before the sheet closes.
    let onSaved: @MainActor (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    init(
        store: AccountStore,
        shelfEntry localID: UUID,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        onSaved: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        _model = State(initialValue: BrewFormModel(shelfEntry: localID, store: store))
        self.vocabulary = vocabulary
        self.language = language
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            beanSection
            methodSection
            amountsSection
            waterSection
            grindAndMilkSection
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
            stepperRow(.dose, title: L10n.brewDose, clearLabel: L10n.brewDoseClear, identifier: "brew-dose")
            stepperRow(.water, title: L10n.brewWater, clearLabel: L10n.brewWaterClear, identifier: "brew-water")
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
        } header: {
            Text(L10n.brewAmountsHeader)
        }
    }

    private var waterSection: some View {
        Section {
            Picker(selection: $model.temperatureChoice) {
                ForEach(BrewDraft.TemperatureChoice.all, id: \.self) { choice in
                    temperatureLabel(choice)
                        .tag(choice)
                }
            } label: {
                Text(L10n.brewTemperature)
            }
            .accessibilityIdentifier("brew-temperature-choice")
            if model.temperatureChoice == .celsius {
                stepperRow(.temperature, title: L10n.brewTemperatureValue, clearLabel: L10n.brewTemperatureClear, identifier: "brew-temperature")
            }
            OptionalVocabularyPicker(title: L10n.brewWaterType, selection: $model.draft.waterType, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("brew-water-type")
        } header: {
            Text(L10n.brewWaterHeader)
        }
    }

    private var grindAndMilkSection: some View {
        Section {
            stepperRow(.grind, title: L10n.brewGrind, clearLabel: L10n.brewGrindClear, identifier: "brew-grind")
            OptionalVocabularyPicker(title: L10n.brewMilk, selection: $model.draft.milk, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("brew-milk")
        } header: {
            Text(L10n.brewMoreHeader)
        } footer: {
            Text(L10n.brewOfflineNote)
        }
    }

    // MARK: - Rows

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
        dismiss()
    }

    static func message(for failure: BrewFormModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .notFound: L10n.brewNotFound
        case .saveFailed: L10n.brewSaveFailed
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
