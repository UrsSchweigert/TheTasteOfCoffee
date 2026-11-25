import SwiftUI

/// F1 step 4 on screen (M2-T22): the pick lists for origin, species, process, variety and
/// roast level, all optional, and Save. After the save it shows the catalogue bean.
///
/// - Origin and variety are long lists: pushed `IndexedPickList`s with an A to Z index, the
///   origins grouped by country (ADR 0011). Species and process are short pushed lists.
///   Roast level is a segmented control.
/// - Every list offers "Not set" and the vocabulary's own `other` and `unknown` entries where
///   the list has them. No roaster list (ADR 0006) and no search field (invariant 1).
/// - The save runs in an unstructured task, so leaving the screen does not cancel a request the
///   server may already act on.
struct BeanEntryScreen: View {
    @Bindable var model: BeanEntryModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        content
            .navigationTitle(Text(L10n.beanEntryTitle))
            .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var content: some View {
        if case .saved(let bean) = model.state {
            BeanDetailView(bean: bean, vocabulary: vocabulary, language: language, loadImage: loadImage)
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
            } footer: {
                Text(L10n.beanEntryPicksFooter)
            }
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
                        Image(systemName: failure == .rejected ? "exclamationmark.triangle" : "icloud.slash")
                            .accessibilityHidden(true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("bean-entry-error")
                }
            }
        }
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
        .buttonStyle(.borderedProminent)
        .disabled(!model.canSave)
        .accessibilityIdentifier("bean-entry-save")
        .padding()
        .background(.regularMaterial)
    }

    private var saveTitle: LocalizedStringKey {
        switch model.state {
        case .saving: L10n.lookupSaving
        case .failed(.retryable): L10n.lookupRetry
        case .editing, .saved, .failed(.rejected): L10n.beanEntrySave
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
        case .retryable: L10n.beanEntryFailedTitle
        }
    }

    static func message(for failure: BeanEntryModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .rejected: L10n.beanEntryRejectedMessage
        case .retryable: L10n.beanEntryFailedMessage
        }
    }
}
