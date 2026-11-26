import SwiftUI

extension BeanAttributeField {
    /// The field's name on screen.
    var title: LocalizedStringKey {
        switch self {
        case .origin: L10n.beanAttributeOrigin
        case .species: L10n.beanAttributeSpecies
        case .variety: L10n.beanAttributeVariety
        case .process: L10n.beanAttributeProcess
        case .roastLevel: L10n.beanAttributeRoastLevel
        }
    }
}

extension BeanAttributeSource {
    /// Where the value came from, on screen.
    var title: LocalizedStringKey {
        switch self {
        case .operatorSet: L10n.beanSourceOperator
        case .picked: L10n.beanSourcePicked
        }
    }
}

/// F1 step 2: a catalogue bean. Its verified state, its attributes (the operator's value wins
/// over a picked one) and, if present, its Open Food Facts name, brand and image with the
/// attribution. Read-only.
struct BeanDetailView: View {
    let bean: API.Bean
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let loadImage: CatalogueImageLoader
    /// The label photos of a bean the user just entered (M2-T24); nil elsewhere.
    var labelPhotos: LabelPhotoUploadSection? = nil

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Label {
                        Text(bean.verified ? L10n.beanVerified : L10n.beanUnverified)
                    } icon: {
                        Image(systemName: bean.verified ? "checkmark.seal.fill" : "questionmark.circle")
                            .accessibilityHidden(true)
                    }
                    .font(.headline)
                    Text(bean.verified ? L10n.beanVerifiedMessage : L10n.beanUnverifiedMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("bean-verified-state")
            }

            if let product = bean.openFoodFacts {
                OpenFoodFactsSection(product: product, loadImage: loadImage)
            }

            Section {
                let rows = bean.attributeRows
                if rows.isEmpty {
                    Text(L10n.beanAttributesEmpty)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(rows) { row in
                        LabeledContent {
                            VStack(alignment: .trailing) {
                                Text(verbatim: label(for: row))
                                Text(row.source.title)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .multilineTextAlignment(.trailing)
                        } label: {
                            Text(row.field.title)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } header: {
                Text(L10n.beanAttributesHeader)
            }

            if let labelPhotos {
                labelPhotos
            }
        }
        .accessibilityIdentifier("bean-detail")
    }

    /// The vocabulary label of the row's value; the id if the bundled labels lack it.
    private func label(for row: BeanAttributeRow) -> String {
        (try? vocabulary.label(namespace: row.field.namespace, id: row.valueID, language: language)) ?? row.valueID
    }
}
