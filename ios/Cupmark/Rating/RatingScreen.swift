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
/// - Photos: a "Photos" section for the saved brew (`BrewPhotosSection`, M2-T42b), on the
///   device only.
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
    @State private var photos: BrewPhotosModel
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
        _photos = State(initialValue: BrewPhotosModel(brew: localID, store: store))
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
                .surfaceRow()
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
            // Photos stay on the device and belong to the saved brew, so they can be added and
            // deleted even when the rating is read-only (M2-T42b).
            BrewPhotosSection(model: photos)
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
                .surfaceRow()
            }
        }
        .formBackground()
        .brewPhotoPresentations(photos)
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
                    Text(brewedAt, format: DisplayDate.dayAndTime)
                } label: {
                    Text(L10n.ratingBrewedAt)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text(L10n.ratingBrewHeader)
                .secondaryText()
        }
        .surfaceRow()
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
                .secondaryText()
        }
        .surfaceRow()
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
                    spokenValueText: model.spokenScoreText(for: criterion, locale: locale),
                    markers: model.markers(for: criterion),
                    markerIdentifier: "rating-marker-\(criterion.rawValue)",
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
                .secondaryText()
        } footer: {
            Text(L10n.ratingScoresFooter)
                .secondaryText()
        }
        .surfaceRow()
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
                .secondaryText()
        } footer: {
            Text(L10n.ratingIntensityFooter)
                .secondaryText()
        }
        .surfaceRow()
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
                            .secondaryText()
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .tint(Theme.accent)
                .accessibilityHint(Text(L10n.ratingNoteRemoveHint))
                .accessibilityIdentifier("rating-picked-note")
            }
        } header: {
            Text(L10n.ratingNotesHeader)
                .secondaryText()
        } footer: {
            Text(L10n.ratingNotesFooter)
                .secondaryText()
        }
        .surfaceRow()
    }

    private var buyAgainSection: some View {
        Section {
            BuyAgainPicker(selection: $model.draft.buyAgain)
                .accessibilityIdentifier("rating-buy-again")
        } footer: {
            Text(L10n.brewOfflineNote)
                .secondaryText()
        }
        .surfaceRow()
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
/// vocabulary's scale and step. VoiceOver reads the label and the score on its scale
/// ("Aroma, 7.5 of 10", M2-T33), adjusts by one step with swipes up and down (the slider's
/// adjustable action), and gives the question as the hint. At accessibility text sizes the
/// label and the score stack.
struct RatingScoreRow: View {
    let title: String
    let question: String?
    let valueText: String?
    /// VoiceOver's value, "7.5 of 10"; `valueText` when nil.
    var spokenValueText: String? = nil
    /// The average markers (M2-T48), nil until the score is set and while there is nothing
    /// to show. They never change the slider's value or behaviour.
    var markers: SliderMarkers? = nil
    /// The accessibility identifier of the marker's label.
    var markerIdentifier = "rating-marker"
    @Binding var value: Double
    /// Called when the slider is touched, before it moves.
    let onBegin: @MainActor () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale

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
                        .accentText()
                } else {
                    Text(L10n.lookupPickNotSet)
                        .secondaryText()
                }
            }
            .accessibilityHidden(true)
            if let question {
                Text(verbatim: question)
                    .font(.subheadline)
                    .secondaryText()
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
            .tint(Theme.accent)
            .opacity(valueText == nil ? 0.5 : 1)
            // The marker is drawn over the bottom edge of the slider and takes no touch, so
            // the slider keeps its value, its adjustable action and its hit area.
            .overlay(alignment: .bottom) {
                if let markers {
                    SliderMarkerTrack(markers: markers)
                        .offset(y: 7)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(.bottom, markers == nil ? 0 : 8)
            .accessibilityLabel(Text(verbatim: title))
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(Text(verbatim: question ?? title))
            if let markers {
                markerLabels(markers)
            }
        }
        .padding(.vertical, 4)
    }

    /// The numbers of the markers, under the slider at every text size so they never push the
    /// score off the row. Each is its own accessibility element, "Your average for this
    /// coffee, 7.5 of 10", present only while the marker is (after the score is set).
    @ViewBuilder
    private func markerLabels(_ markers: SliderMarkers) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let own = markers.own {
                let mean = own.formatted(StatisticsRules.meanStyle().locale(locale))
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DiamondShape()
                        .fill(Theme.averageMarker)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(verbatim: L10n.ratingMarkerOwn(mean))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Theme.averageMarker)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: L10n.ratingMarkerOwnSpoken(
                    AccessibilityValue.ofScale(mean, maximum: RatingDraft.scale.maximum, locale: locale)
                )))
                .accessibilityIdentifier(markerIdentifier)
            }
            if let community = markers.community {
                let text = L10n.coffeeAveragesCommunity(
                    mean: community.mean.formatted(StatisticsRules.meanStyle().locale(locale)),
                    raters: community.raters.formatted(.number.locale(locale))
                )
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle()
                        .stroke(Theme.averageMarker, lineWidth: 2)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(verbatim: text)
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Theme.averageMarker)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: text))
                .accessibilityIdentifier("\(markerIdentifier)-community")
            }
        }
    }

    private var accessibilityValue: Text {
        if let text = spokenValueText ?? valueText {
            return Text(verbatim: text)
        }
        return Text(L10n.lookupPickNotSet)
    }
}

/// A diamond, the shape of the user's average marker (a circle is the thumb's).
struct DiamondShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        path.closeSubpath()
        return path
    }
}

/// The markers on a slider's scale: a diamond at the user's average and, while there is one,
/// a ring at the community's. Drawn with shapes in `Theme.averageMarker`, under the track so
/// it does not hide the thumb; the numbers are in the labels under the slider. The thumb of
/// a system slider is inset from the ends of the track, so the positions are too.
struct SliderMarkerTrack: View {
    let markers: SliderMarkers
    /// Half the width of the system slider's thumb, in points.
    private static let inset: CGFloat = 14

    var body: some View {
        GeometryReader { proxy in
            let width = max(0, proxy.size.width - 2 * Self.inset)
            ZStack(alignment: .topLeading) {
                if let own = markers.own {
                    DiamondShape()
                        .fill(Theme.averageMarker)
                        .frame(width: 10, height: 10)
                        .position(x: Self.inset + width * SliderMarkers.fraction(of: own), y: 5)
                }
                if let community = markers.community {
                    Circle()
                        .stroke(Theme.averageMarker, lineWidth: 2)
                        .frame(width: 10, height: 10)
                        .position(x: Self.inset + width * SliderMarkers.fraction(of: community.mean), y: 5)
                }
            }
        }
        .frame(height: 10)
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
                                .minimumTapTarget()
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
                                .minimumTapTarget()
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
