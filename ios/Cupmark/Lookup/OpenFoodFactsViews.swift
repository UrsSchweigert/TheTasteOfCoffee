import SwiftUI
import UIKit

/// Loads a catalogue image by its server id (`LookupModel.image(_:)`).
typealias CatalogueImageLoader = @MainActor (API.Id) async -> Data?

/// A catalogue image, loaded through our API with the token (`GET /catalogue_images/{image_id}`),
/// never from Open Food Facts (ADR 0011). Shows nothing if it cannot be loaded.
struct CatalogueImageView: View {
    let imageID: API.Id
    let load: CatalogueImageLoader
    @State private var image: UIImage? = nil
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .accessibilityLabel(Text(L10n.openFoodFactsImageAccessibility))
            } else if !failed {
                ProgressView()
                    .accessibilityLabel(Text(L10n.openFoodFactsImageLoading))
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: imageID) {
            guard image == nil else {
                return
            }
            if let data = await load(imageID), let decoded = UIImage(data: data) {
                image = decoded
            } else {
                failed = true
            }
        }
    }
}

/// The Open Food Facts name, brand and image of a product, with the ODbL attribution.
/// Name and brand are untrusted text from Open Food Facts: shown with `Text(verbatim:)`, so
/// they are never read as a localisation key or as Markdown (ADR 0005).
struct OpenFoodFactsSection: View {
    let product: API.OpenFoodFactsProduct
    let loadImage: CatalogueImageLoader

    var body: some View {
        Section {
            if let imageID = product.imageId {
                CatalogueImageView(imageID: imageID, load: loadImage)
            }
            if let name = product.name {
                LabeledContent {
                    Text(verbatim: name)
                        .multilineTextAlignment(.trailing)
                } label: {
                    Text(L10n.openFoodFactsName)
                }
            }
            if let brand = product.brand {
                LabeledContent {
                    Text(verbatim: brand)
                        .multilineTextAlignment(.trailing)
                } label: {
                    Text(L10n.openFoodFactsBrand)
                }
            }
        } header: {
            Text(L10n.openFoodFactsHeader)
        } footer: {
            Text(L10n.openFoodFactsAttribution)
        }
    }
}

/// An optional pick from one vocabulary list, labelled from contracts/i18n. "Not set" is nil.
/// Only for short lists; long lists (origins, varieties) get the A to Z pick list of M2-T22.
struct OptionalVocabularyPicker<Item: VocabularyItem>: View {
    let title: LocalizedStringKey
    @Binding var selection: Item?
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        Picker(selection: $selection) {
            Text(L10n.lookupPickNotSet)
                .tag(Optional<Item>.none)
            ForEach(Item.allCases) { item in
                Text(verbatim: label(for: item))
                    .tag(Optional<Item>.some(item))
            }
        } label: {
            Text(title)
        }
    }

    private func label(for item: Item) -> String {
        (try? vocabulary.label(for: item, language: language)) ?? item.rawValue
    }
}

/// F1 step 3: an Open Food Facts hit for confirmation. Confirm stores it as an unverified
/// bean, with the optional picks; Reject leads to the pick-list entry.
struct OpenFoodFactsConfirmView: View {
    let product: API.OpenFoodFactsProduct
    let isSaving: Bool
    @Binding var picks: API.BeanAttributes
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let loadImage: CatalogueImageLoader
    let onConfirm: @MainActor () -> Void
    let onReject: @MainActor () -> Void

    var body: some View {
        Form {
            Section {
                Text(L10n.lookupConfirmMessage)
            } header: {
                Text(L10n.lookupConfirmTitle)
            }
            OpenFoodFactsSection(product: product, loadImage: loadImage)
            Section {
                OptionalVocabularyPicker(title: BeanAttributeField.species.title, selection: $picks.species, vocabulary: vocabulary, language: language)
                OptionalVocabularyPicker(title: BeanAttributeField.process.title, selection: $picks.process, vocabulary: vocabulary, language: language)
                OptionalVocabularyPicker(title: BeanAttributeField.roastLevel.title, selection: $picks.roastLevel, vocabulary: vocabulary, language: language)
            } header: {
                Text(L10n.lookupPicksHeader)
            }
            .disabled(isSaving)
        }
        .safeAreaInset(edge: .bottom) {
            actions
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            Button {
                onConfirm()
            } label: {
                HStack {
                    if isSaving {
                        ProgressView()
                            .accessibilityHidden(true)
                    }
                    Text(isSaving ? L10n.lookupSaving : L10n.lookupConfirm)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("lookup-confirm")
            Button {
                onReject()
            } label: {
                Text(L10n.lookupReject)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("lookup-reject")
        }
        .disabled(isSaving)
        .padding()
        .background(.regularMaterial)
    }
}
