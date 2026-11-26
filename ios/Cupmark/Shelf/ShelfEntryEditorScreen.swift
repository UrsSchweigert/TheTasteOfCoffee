import Combine
import SwiftUI

/// Adds a bag to the shelf, or shows and edits one (M2-T18, docs/04 F1 step 5).
///
/// - Purchase date: a date picker, today by default. Roast date: optional, behind a toggle.
///   Bag size and price band: pick lists from the bundled vocabulary. Nothing is typed.
/// - A stored entry also offers another bean and removal. Both are disabled while brews on
///   the device reference the entry, with the reason below them (D14, ADR 0012).
/// - Save and removal write through `ShelfEntryEditorModel` to `AccountStore`, which queues
///   them in the outbox, so they work offline.
struct ShelfEntryEditorScreen: View {
    @State private var model: ShelfEntryEditorModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Called after a save with the entry's local id, and after a removal with nil, just
    /// before the screen dismisses itself.
    let onFinished: @MainActor (UUID?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false
    /// The brew form of this entry, while open (M2-T19).
    @State private var brewing: BrewRoute?
    /// "Repeat Last Brew" and the recipes of a stored entry (M2-T27); nil while adding.
    @State private var repeats: BrewStartModel?

    init(
        store: AccountStore,
        mode: ShelfEntryEditorModel.Mode,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        onFinished: @escaping @MainActor (UUID?) -> Void = { _ in }
    ) {
        _model = State(initialValue: ShelfEntryEditorModel(mode: mode, store: store))
        if case .edit(let localID) = mode {
            _repeats = State(initialValue: BrewStartModel(shelfEntry: localID, store: store))
        }
        self.vocabulary = vocabulary
        self.language = language
        self.onFinished = onFinished
    }

    var body: some View {
        Form {
            if let route = brewRoute {
                Section {
                    Button {
                        brewing = route
                    } label: {
                        Label {
                            Text(L10n.brewStart)
                        } icon: {
                            Image(systemName: "cup.and.saucer")
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityIdentifier("shelf-entry-brew")
                    // The brews of this bag, to rate one later (M2-T20).
                    // A value link, resolved at the stack root (M2-T40).
                    NavigationLink(value: BrewListRoute(shelfEntryLocalID: route.shelfEntryLocalID)) {
                        Label {
                            Text(L10n.brewListTitle)
                        } icon: {
                            Image(systemName: "list.bullet")
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityIdentifier("shelf-entry-brews")
                }
                .surfaceRow()
                // One tap from a repeat of the last brew or a recipe (M2-T27).
                if let repeats {
                    BrewStartSection(model: repeats, vocabulary: vocabulary, language: language) { start in
                        brewing = start
                    }
                }
            }
            beanSection
            datesSection
            bagSection
            if let issue = model.issue {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(SyncIssueTexts.title(for: issue))
                            .font(.headline)
                        Text(SyncIssueTexts.message(for: issue))
                            .font(.footnote)
                    }
                    .accessibilityElement(children: .combine)
                }
                .surfaceRow()
            }
            if !model.isAdding {
                deleteSection
            }
            // Not while the screen closes after its own removal.
            if let failure = model.failure, !model.didDelete {
                Section {
                    Label {
                        Text(ShelfEntryEditorScreen.message(for: failure))
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("shelf-entry-error")
                }
                .surfaceRow()
            }
        }
        .formBackground()
        .navigationTitle(Text(model.isAdding ? L10n.shelfEntryAddTitle : L10n.shelfEntryEditTitle))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if model.isAdding {
                    Button {
                        dismiss()
                    } label: {
                        Text(L10n.shelfEntryCancel)
                    }
                    .accessibilityIdentifier("shelf-entry-cancel")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    save()
                } label: {
                    Text(L10n.shelfEntrySave)
                }
                .disabled(!model.canSave)
                .accessibilityIdentifier("shelf-entry-save")
            }
        }
        .confirmationDialog(L10n.shelfEntryDeleteConfirmTitle, isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(role: .destructive) {
                delete()
            } label: {
                Text(L10n.shelfEntryDelete)
            }
        }
        .sheet(item: $brewing) { route in
            // The brew form, then the rating of the new brew (M2-T20).
            BrewSheet(store: model.store, route: route, vocabulary: vocabulary, language: language)
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            // A pull or the engine may have added a brew or set a flag meanwhile.
            model.refresh()
        }
    }

    // MARK: - Sections

    private var beanSection: some View {
        Section {
            BeanSummaryView(summary: model.bean, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("shelf-entry-bean")
            if !model.isAdding {
                NavigationLink {
                    ShelfBeanChoiceList(model: model, vocabulary: vocabulary, language: language)
                } label: {
                    Text(L10n.shelfEntryChangeBean)
                }
                .disabled(!model.canChangeBean)
                .accessibilityIdentifier("shelf-entry-change-bean")
            }
        } header: {
            Text(L10n.shelfEntryBeanHeader)
                .secondaryText()
        } footer: {
            if model.lockReason != nil {
                Text(L10n.shelfEntryLockedReason)
                    .accessibilityIdentifier("shelf-entry-locked-reason")
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    private var datesSection: some View {
        Section {
            DatePicker(selection: purchaseDate, in: ...model.latestDate, displayedComponents: .date) {
                Text(L10n.shelfPurchaseDate)
            }
            .accessibilityIdentifier("shelf-entry-purchase-date")
            Toggle(isOn: hasRoastDate) {
                Text(L10n.shelfEntryRoastDateKnown)
            }
            .tint(Theme.accent)
            .accessibilityIdentifier("shelf-entry-roast-known")
            if model.hasRoastDate {
                DatePicker(selection: roastDate, in: ...model.latestDate, displayedComponents: .date) {
                    Text(L10n.shelfRoastDate)
                }
                .accessibilityIdentifier("shelf-entry-roast-date")
                if let days = model.daysSinceRoast {
                    LabeledContent {
                        Text(days, format: .number)
                    } label: {
                        Text(L10n.shelfDaysSinceRoast)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text(L10n.shelfEntryDatesHeader)
                .secondaryText()
        }
        .surfaceRow()
    }

    private var bagSection: some View {
        Section {
            OptionalVocabularyPicker(title: L10n.shelfEntryBagSize, selection: $model.draft.bagSize, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("shelf-entry-bag-size")
            OptionalVocabularyPicker(title: L10n.shelfEntryPriceBand, selection: $model.draft.priceBand, vocabulary: vocabulary, language: language)
                .accessibilityIdentifier("shelf-entry-price-band")
        } header: {
            Text(L10n.shelfEntryBagHeader)
                .secondaryText()
        } footer: {
            if model.isAdding {
                Text(L10n.shelfEntryOfflineNote)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Text(L10n.shelfEntryDelete)
            }
            .disabled(!model.canDelete)
            .accessibilityIdentifier("shelf-entry-delete")
        } footer: {
            if model.lockReason != nil {
                Text(L10n.shelfEntryLockedReason)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    // MARK: - Bindings and actions

    /// The brew form of a stored entry that still exists; nil while adding (M2-T19).
    private var brewRoute: BrewRoute? {
        guard case .edit(let localID) = model.mode, model.failure != .notFound, !model.didDelete else {
            return nil
        }
        return BrewRoute(shelfEntryLocalID: localID)
    }

    private var purchaseDate: Binding<Date> {
        Binding(
            get: { model.purchaseDateValue },
            set: { date in model.setPurchaseDate(date) }
        )
    }

    private var hasRoastDate: Binding<Bool> {
        Binding(
            get: { model.hasRoastDate },
            set: { isOn in model.setHasRoastDate(isOn) }
        )
    }

    private var roastDate: Binding<Date> {
        Binding(
            get: { model.roastDateValue },
            set: { date in model.setRoastDate(date) }
        )
    }

    private func save() {
        guard let localID = model.save() else {
            return
        }
        onFinished(localID)
        dismiss()
    }

    private func delete() {
        guard model.delete() else {
            return
        }
        onFinished(nil)
        dismiss()
    }

    static func message(for failure: ShelfEntryEditorModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .notFound: L10n.shelfEntryNotFound
        case .hasBrews: L10n.shelfEntryLockedReason
        case .saveFailed: L10n.shelfEntrySaveFailed
        }
    }
}

/// The beans on the device, to put a stored entry on another bean. Only reachable while the
/// entry has no brews (D14).
struct ShelfBeanChoiceList: View {
    let model: ShelfEntryEditorModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.dismiss) private var dismiss
    @State private var choices: [ShelfBeanChoice] = []

    var body: some View {
        List(choices) { choice in
            Button {
                model.chooseBean(choice)
                dismiss()
            } label: {
                HStack {
                    BeanSummaryView(summary: choice.summary, vocabulary: vocabulary, language: language)
                    Spacer()
                    if choice.id == model.beanLocalID {
                        Image(systemName: "checkmark")
                            .accentText()
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .tint(.primary)
            .accessibilityAddTraits(choice.id == model.beanLocalID ? .isSelected : [])
            .surfaceRow()
        }
        .listBackground()
        .navigationTitle(Text(L10n.shelfEntryChooseBeanTitle))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            choices = model.beanChoices()
        }
    }
}
