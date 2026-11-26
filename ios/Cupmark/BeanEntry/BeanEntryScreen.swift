import SwiftUI

/// F1 step 4 on screen (M2-T22): the pick lists for origin, species, process, variety and
/// roast level, all optional, and Save. After the save it shows the catalogue bean.
///
/// - Origin and variety are long lists: pushed `IndexedPickList`s with an A to Z index, the
///   origins grouped by country (ADR 0011). Species and process are short pushed lists.
///   Roast level is a segmented control.
/// - Every list offers "Not set" and the vocabulary's own `other` and `unknown` entries where
///   the list has them. No roaster list (ADR 0006) and no search field (invariant 1).
/// - The label photo (M2-T23) follows the picks when the device has a camera
///   (`LabelPhotoSection`); it is kept in memory on the model until the bean is saved. For an
///   unverified bean the saved screen then shows `LabelPhotoUploadSection` (M2-T24): the
///   form's photo uploads at once, and up to 3 can be added.
/// - The save runs in an unstructured task, so leaving the screen does not cancel a request the
///   server may already act on.
struct BeanEntryScreen: View {
    @Bindable var model: BeanEntryModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Where the saved bean is put on the shelf (M2-T18); nil offers no "Add to Shelf".
    var shelf: ShelfAddContext? = nil
    /// Whether the label photo step is offered (M2-T23). Read on appear and on return to the
    /// foreground, since camera access may have been changed in Settings.
    let camera: any LabelPhotoCameraEnvironment

    @State private var cameraAvailability: LabelPhotoCameraAvailability = .unavailable
    @Environment(\.scenePhase) private var scenePhase

    /// Written out because the private state above would otherwise limit the memberwise one.
    init(
        model: BeanEntryModel,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        shelf: ShelfAddContext? = nil,
        camera: any LabelPhotoCameraEnvironment = LiveLabelPhotoCameraEnvironment()
    ) {
        self.model = model
        self.vocabulary = vocabulary
        self.language = language
        self.shelf = shelf
        self.camera = camera
    }

    var body: some View {
        content
            .navigationTitle(Text(L10n.beanEntryTitle))
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                cameraAvailability = camera.availability()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    cameraAvailability = camera.availability()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if case .saved(let bean) = model.state {
            BeanDetailView(
                bean: bean,
                vocabulary: vocabulary,
                language: language,
                loadImage: loadImage,
                labelPhotos: model.labelPhotoUploads.map { LabelPhotoUploadSection(model: $0, availability: cameraAvailability) }
            )
            .safeAreaInset(edge: .bottom) {
                if let shelf {
                    AddToShelfBar(bean: bean, context: shelf, vocabulary: vocabulary, language: language)
                }
            }
        } else if case .savedOffline(let beanID) = model.state {
            // Saved on the device while offline (M2-T25): the outbox creates it later.
            ContentUnavailableView {
                Label {
                    Text(L10n.beanEntrySavedOfflineTitle)
                } icon: {
                    Image(systemName: "clock.arrow.circlepath")
                        .accessibilityHidden(true)
                }
            } description: {
                VStack(spacing: 8) {
                    Text(L10n.beanEntrySavedOfflineMessage)
                    if model.picksNotKept {
                        Text(L10n.beanEntryPicksNotKept)
                    }
                }
            }
            .screenBackground()
            .accessibilityIdentifier("bean-entry-saved-offline")
            .safeAreaInset(edge: .bottom) {
                if let shelf {
                    AddToShelfBar(storedBean: beanID, context: shelf, vocabulary: vocabulary, language: language)
                }
            }
        } else if model.state == .failed(.signInRequired) {
            SignInAgainView()
        } else {
            form
        }
    }

    private var form: some View {
        Form {
            if let barcode = model.barcode {
                Section {
                    LabeledContent {
                        // Digits only, checked by CanonicalBarcode; not translatable text.
                        Text(verbatim: barcode.digits)
                            .monospacedDigit()
                    } label: {
                        Text(L10n.beanEntryBarcode)
                    }
                    .accessibilityElement(children: .combine)
                }
                .surfaceRow()
            }
            Section {
                IndexedPickListRow(
                    title: BeanAttributeField.origin.title,
                    selection: $model.picks.origin,
                    vocabulary: vocabulary,
                    language: language,
                    sections: { [vocabulary, language] in
                        PickListSections.origins(locale: BeanEntryScreen.locale(for: language)) { origin in
                            VocabularyLabels.label(for: origin, in: vocabulary, language: language)
                        }
                    }
                )
                .accessibilityIdentifier("bean-entry-origin")
                OptionalVocabularyPicker(
                    title: BeanAttributeField.species.title,
                    selection: $model.picks.species,
                    vocabulary: vocabulary,
                    language: language
                )
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("bean-entry-species")
                OptionalVocabularyPicker(
                    title: BeanAttributeField.process.title,
                    selection: $model.picks.process,
                    vocabulary: vocabulary,
                    language: language
                )
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("bean-entry-process")
                IndexedPickListRow(
                    title: BeanAttributeField.variety.title,
                    selection: $model.picks.variety,
                    vocabulary: vocabulary,
                    language: language,
                    sections: { [vocabulary, language] in
                        PickListSections.alphabetical(Vocabulary.Variety.self, locale: BeanEntryScreen.locale(for: language)) { variety in
                            VocabularyLabels.label(for: variety, in: vocabulary, language: language)
                        }
                    }
                )
                .accessibilityIdentifier("bean-entry-variety")
                RoastLevelPicker(selection: $model.picks.roastLevel, vocabulary: vocabulary, language: language)
            } header: {
                Text(L10n.beanEntryPicksHeader)
                    .secondaryText()
            } footer: {
                Text(L10n.beanEntryPicksFooter)
                    .secondaryText()
            }
            .surfaceRow()
            .disabled(!model.isEditable)

            LabelPhotoSection(draft: model.labelPhoto, availability: cameraAvailability)
                .disabled(!model.isEditable)

            if case .failed(let failure) = model.state {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(BeanEntryScreen.title(for: failure))
                                .font(.headline)
                            Text(BeanEntryScreen.message(for: failure))
                                .font(.footnote)
                        }
                    } icon: {
                        Image(systemName: failure == .rejected || failure == .noStore ? "exclamationmark.triangle" : "icloud.slash")
                            .accessibilityHidden(true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("bean-entry-error")
                }
                .surfaceRow()
            }
        }
        .formBackground()
        .safeAreaInset(edge: .bottom) {
            saveBar
        }
    }

    private var saveBar: some View {
        Button {
            Task {
                await model.save()
            }
        } label: {
            HStack {
                if model.state == .saving {
                    ProgressView()
                        .accessibilityHidden(true)
                }
                Text(saveTitle)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.prominent)
        .controlSize(.large)
        .disabled(!model.canSave)
        .accessibilityIdentifier("bean-entry-save")
        .padding()
        .background(.regularMaterial)
    }

    private var saveTitle: LocalizedStringKey {
        switch model.state {
        case .saving: L10n.lookupSaving
        case .failed(.retryable), .failed(.photoNotSaved): L10n.lookupRetry
        case .editing, .saved, .savedOffline, .failed(.rejected), .failed(.signInRequired), .failed(.noStore): L10n.beanEntrySave
        }
    }

    private var loadImage: CatalogueImageLoader {
        { [model] imageID in
            await model.image(imageID)
        }
    }

    /// The locale the labels of `language` are sorted in.
    static func locale(for language: VocabularyLanguage) -> Locale {
        Locale(identifier: language.rawValue)
    }

    static func title(for failure: BeanEntryModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .rejected: L10n.beanEntryRejectedTitle
        case .photoNotSaved: L10n.beanEntryPhotoNotSavedTitle
        case .noStore: L10n.beanEntryNoStoreTitle
        case .retryable: L10n.beanEntryFailedTitle
        case .signInRequired: L10n.signInAgainTitle
        }
    }

    static func message(for failure: BeanEntryModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .rejected: L10n.beanEntryRejectedMessage
        case .photoNotSaved: L10n.beanEntryPhotoNotSavedMessage
        case .noStore: L10n.beanEntryNoStoreMessage
        case .retryable: L10n.beanEntryFailedMessage
        case .signInRequired: L10n.signInAgainMessage
        }
    }
}
