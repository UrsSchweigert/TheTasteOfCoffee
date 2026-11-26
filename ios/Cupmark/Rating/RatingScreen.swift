import Combine
import SwiftUI

/// The rating of one brew (M2-T20, docs/04 F3).
///
/// - One slider per criterion, on the vocabulary's scale (`Vocabulary.Ranges.scale`, 1 to 10
///   in half steps), with the criterion's question from contracts/i18n. A criterion without a
///   score shows "Not set"; touching its slider sets it. Save is enabled only when every
///   criterion has a score.
/// - Intensity of each `intensity_dimensions` entry: optional, one of `intensity_levels`, as
///   a segmented control (a pushed list at accessibility text sizes).
/// - Flavour notes: optional, category then note, up to `flavour_notes.max_picks`; once that
///   many are picked the other notes are disabled.
/// - Buy again: optional, Yes or No as a segmented control with "Clear"; not set is not
///   sent.
/// - Nothing is typed (invariant 1). Every list comes from the generated vocabulary.
/// - Save writes through `RatingFormModel` to `AccountStore`, which queues it in the outbox,
///   so it works offline.
struct RatingScreen: View {
    /// Where the screen was opened from.
    enum Mode: Sendable {
        /// In the brew sheet, straight after the brew was saved: "Later" closes the sheet.
        case afterBrew
        /// Pushed from the brew list: the back button leaves it.
        case later
    }

    @State private var model: RatingFormModel
    let mode: Mode
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    /// `repeatedFrom` is the brew a repeat copied (M2-T27), whose rating is offered when the
    /// bag and the bean have none earlier.
    init(
        store: AccountStore,
        brew localID: UUID,
        mode: Mode,
        repeatedFrom: UUID? = nil,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage
    ) {
        _model = State(initialValue: RatingFormModel(brew: localID, store: store, repeatedFrom: repeatedFrom))
        self.mode = mode
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        Form {
            brewSection
            if model.isReadOnly {
                Section {
                    Label {
                        Text(L10n.ratingReadOnly)
                    } icon: {
                        Image(systemName: "lock")
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("rating-read-only")
                }
            }
            if model.offersLastRating {
                lastRatingSection
            }
            Group {
                scoresSection
                intensitySection
                flavourNotesSection
                buyAgainSection
            }
            // A rating made with a newer vocabulary is shown, not changed.
            .disabled(model.isReadOnly)
            if let failure = model.failure {
                Section {
                    Label {
                        Text(RatingScreen.message(for: failure))
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("rating-error")
                }
            }
        }
        .navigationTitle(Text(L10n.ratingTitle))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if mode == .afterBrew {
                    Button {
                        dismiss()
                    } label: {
                        Text(L10n.ratingLater)
                    }
                    .accessibilityIdentifier("rating-later")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    save()
                } label: {
                    Text(L10n.ratingSave)
                }
                .disabled(!model.canSave)
                .accessibilityIdentifier("rating-save")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            // A pull may have removed the brew meanwhile.
            model.refresh()
        }
    }

    // MARK: - Sections

    private var brewSection: some View {
        Section {
            BeanSummaryView(summary: model.bean, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("rating-bean")
            if let method = model.method {
                LabeledContent {
                    Text(verbatim: VocabularyLabels.label(for: method, in: vocabulary, language: language))
                } label: {
                    Text(L10n.brewMethod)
                }
                .accessibilityElement(children: .combine)
            }
            if let brewedAt = model.brewedAt {
                LabeledContent {
                    Text(brewedAt, format: .dateTime.day().month().year().hour().minute())
                } label: {
                    Text(L10n.ratingBrewedAt)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text(L10n.ratingBrewHeader)
        }
    }

    private var lastRatingSection: some View {
        Section {
            Button {
                model.useLastRating()
            } label: {
                Label {
                    Text(lastRatingTitle)
                } icon: {
                    Image(systemName: "arrow.uturn.backward")
                        .accessibilityHidden(true)
                }
            }
            .accessibilityIdentifier("rating-use-last")
        } footer: {
            Text(L10n.ratingUseLastFooter)
        }
    }

    /// The offer says where its rating comes from (ADR 0026, Addendum M2-T27).
    private var lastRatingTitle: LocalizedStringKey {
        switch model.lastRatingSource {
        case .sameBean:
            return L10n.ratingUseLastSameBean
        case .repeatedBrew:
            return L10n.ratingUseLastRepeatedBrew
        case .sameBag, .none:
            return L10n.ratingUseLast
        }
    }

    private var scoresSection: some View {
        Section {
            ForEach(Vocabulary.Criterion.allCases) { criterion in
                RatingScoreRow(
                    title: VocabularyLabels.label(for: criterion, in: vocabulary, language: language),
                    question: question(for: criterion),
                    valueText: model.scoreText(for: criterion, locale: locale),
                    value: scoreBinding(for: criterion),
                    onBegin: { model.beginSliding(criterion) }
                )
                .accessibilityIdentifier("rating-score-\(criterion.rawValue)")
            }
            if !model.draft.isComplete {
                LabeledContent {
                    Text(model.draft.missingCriteria.count, format: .number)
                } label: {
                    Text(L10n.ratingScoresMissing)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("rating-scores-missing")
            }
        } header: {
            Text(L10n.ratingScoresHeader)
        } footer: {
            Text(L10n.ratingScoresFooter)
        }
    }

    private var intensitySection: some View {
        Section {
            ForEach(Vocabulary.IntensityDimension.allCases) { dimension in
                IntensityPicker(
                    title: VocabularyLabels.label(for: dimension, in: vocabulary, language: language),
                    selection: intensityBinding(for: dimension),
                    vocabulary: vocabulary,
                    language: language
                )
                .accessibilityIdentifier("rating-intensity-\(dimension.rawValue)")
            }
        } header: {
            Text(L10n.ratingIntensityHeader)
        } footer: {
            Text(L10n.ratingIntensityFooter)
        }
    }

    private var flavourNotesSection: some View {
        Section {
            NavigationLink {
                FlavourCategoryList(model: model, vocabulary: vocabulary, language: language)
            } label: {
                LabeledContent {
                    Text(model.draft.flavourNotes.count, format: .number)
                } label: {
                    Text(L10n.ratingNotesChoose)
                }
            }
            .accessibilityIdentifier("rating-notes")
            ForEach(model.draft.flavourNotes) { note in
                Button {
                    model.toggle(note)
                } label: {
                    HStack {
                        Text(verbatim: VocabularyLabels.label(for: note, in: vocabulary, language: language))
                        Spacer()
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .tint(.primary)
                .accessibilityHint(Text(L10n.ratingNoteRemoveHint))
                .accessibilityIdentifier("rating-picked-note")
            }
        } header: {
            Text(L10n.ratingNotesHeader)
        } footer: {
            Text(L10n.ratingNotesFooter)
        }
    }

    private var buyAgainSection: some View {
        Section {
            BuyAgainPicker(selection: $model.draft.buyAgain)
                .accessibilityIdentifier("rating-buy-again")
        } footer: {
            Text(L10n.brewOfflineNote)
        }
    }

    // MARK: - Bindings and texts

    private func scoreBinding(for criterion: Vocabulary.Criterion) -> Binding<Double> {
        Binding(
            get: { model.sliderValue(for: criterion) },
            set: { value in model.setSliderValue(value, for: criterion) }
        )
    }

    private func intensityBinding(for dimension: Vocabulary.IntensityDimension) -> Binding<Vocabulary.IntensityLevel?> {
        Binding(
            get: { model.draft.intensity(for: dimension) },
            set: { level in model.draft.setIntensity(level, for: dimension) }
        )
    }

    /// The criterion's question from contracts/i18n, nil if the bundle lacks it.
    private func question(for criterion: Vocabulary.Criterion) -> String? {
        try? vocabulary.question(namespace: Vocabulary.Criterion.namespace, id: criterion.rawValue, language: language)
    }

    // MARK: - Actions

    private func save() {
        if model.save() {
            dismiss()
        }
    }

    static func message(for failure: RatingFormModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .notFound: L10n.ratingNotFound
        case .incomplete: L10n.ratingIncomplete
        case .saveFailed: L10n.brewSaveFailed
        }
    }
}

/// One criterion: its label, its score (or "Not set"), its question and a slider on the
/// vocabulary's scale and step. VoiceOver reads the label and the score, adjusts by one step
/// with swipes up and down, and gives the question as the hint. At accessibility text sizes
/// the label and the score stack.
struct RatingScoreRow: View {
    let title: String
    let question: String?
    let valueText: String?
    @Binding var value: Double
    /// Called when the slider is touched, before it moves.
    let onBegin: @MainActor () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var bounds: ClosedRange<Double> {
        RatingDraft.scale.minimum...RatingDraft.scale.maximum
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Text(verbatim: title)
                    .font(.headline)
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: 0)
                }
                if let valueText {
                    Text(verbatim: valueText)
                        .font(.headline)
                        .monospacedDigit()
                } else {
                    Text(L10n.lookupPickNotSet)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityHidden(true)
            if let question {
                Text(verbatim: question)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Slider(
                value: $value,
                in: bounds,
                step: RatingDraft.scale.multipleOf,
                label: {
                    Text(verbatim: title)
                },
                onEditingChanged: { editing in
                    if editing {
                        onBegin()
                    }
                }
            )
            .opacity(valueText == nil ? 0.5 : 1)
            .accessibilityLabel(Text(verbatim: title))
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(Text(verbatim: question ?? title))
        }
        .padding(.vertical, 4)
    }

    private var accessibilityValue: Text {
        if let valueText {
            return Text(verbatim: valueText)
        }
        return Text(L10n.lookupPickNotSet)
    }
}

/// The intensity of one dimension: a segmented control of the vocabulary's levels, nothing
/// selected until one is picked, and "Clear" to set it back. At accessibility text sizes the
/// segments would be cut off, so it becomes a pushed list with "Not set" instead.
struct IntensityPicker: View {
    let title: String
    @Binding var selection: Vocabulary.IntensityLevel?
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker(selection: $selection) {
                Text(L10n.lookupPickNotSet)
                    .tag(Optional<Vocabulary.IntensityLevel>.none)
                ForEach(Vocabulary.IntensityLevel.allCases) { level in
                    Text(verbatim: VocabularyLabels.label(for: level, in: vocabulary, language: language))
                        .tag(Optional<Vocabulary.IntensityLevel>.some(level))
                }
            } label: {
                Text(verbatim: title)
            }
            .pickerStyle(.navigationLink)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(verbatim: title)
                    Spacer()
                    if selection != nil {
                        Button {
                            selection = nil
                        } label: {
                            Text(L10n.beanEntryClear)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text(L10n.ratingIntensityClear))
                        .accessibilityValue(Text(verbatim: title))
                    }
                }
                Picker(selection: $selection) {
                    ForEach(Vocabulary.IntensityLevel.allCases) { level in
                        Text(verbatim: VocabularyLabels.label(for: level, in: vocabulary, language: language))
                            .tag(Optional<Vocabulary.IntensityLevel>.some(level))
                    }
                } label: {
                    Text(verbatim: title)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityLabel(Text(verbatim: title))
            }
            .padding(.vertical, 4)
        }
    }
}

/// Buy again (F3): not set, yes or no. A segmented Yes and No, nothing selected until one is
/// picked, and "Clear" to set it back to not set; a pushed list with "Not set" at
/// accessibility text sizes, like `IntensityPicker`. Not set is not sent.
struct BuyAgainPicker: View {
    @Binding var selection: Bool?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker(selection: $selection) {
                Text(L10n.lookupPickNotSet)
                    .tag(Optional<Bool>.none)
                Text(L10n.ratingBuyAgainYes)
                    .tag(Optional<Bool>.some(true))
                Text(L10n.ratingBuyAgainNo)
                    .tag(Optional<Bool>.some(false))
            } label: {
                Text(L10n.ratingBuyAgain)
            }
            .pickerStyle(.navigationLink)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(L10n.ratingBuyAgain)
                    Spacer()
                    if selection != nil {
                        Button {
                            selection = nil
                        } label: {
                            Text(L10n.beanEntryClear)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text(L10n.ratingBuyAgainClear))
                    }
                }
                Picker(selection: $selection) {
                    Text(L10n.ratingBuyAgainYes)
                        .tag(Optional<Bool>.some(true))
                    Text(L10n.ratingBuyAgainNo)
                        .tag(Optional<Bool>.some(false))
                } label: {
                    Text(L10n.ratingBuyAgain)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityLabel(Text(L10n.ratingBuyAgain))
            }
            .padding(.vertical, 4)
        }
    }
}
