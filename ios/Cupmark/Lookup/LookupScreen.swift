import SwiftUI

/// F1 steps 2 and 3 on screen (M2-T14): shows the state of a `LookupModel`. A known bean, an
/// Open Food Facts hit to confirm or reject, or a message with the pick-list entry.
/// `onPickListEntry` opens the pick-list entry (connected in M2-T22).
struct LookupScreen: View {
    @Bindable var model: LookupModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let onPickListEntry: @MainActor () -> Void

    var body: some View {
        content
            .navigationTitle(Text(L10n.lookupTitle))
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                // Not `.task`: leaving the screen must not cancel a lookup or a confirmation
                // the server may already be acting on. The model ignores a second start.
                guard model.state == .idle else {
                    return
                }
                Task {
                    await model.lookUp()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle, .lookingUp:
            ProgressView {
                Text(L10n.lookupLookingUp)
            }
        case .bean(let bean):
            BeanDetailView(bean: bean, vocabulary: vocabulary, language: language, loadImage: loadImage)
        case .openFoodFacts(let product), .confirming(let product):
            // One branch for both, so the form keeps its identity (scroll position, image)
            // while the confirmation is sent.
            confirmView(product, isSaving: model.state == .confirming(product))
        case .pickList(let reason):
            LookupFallbackView(
                reason: reason,
                onRetry: {
                    Task {
                        await model.lookUp()
                    }
                },
                onPickListEntry: onPickListEntry
            )
        }
    }

    private func confirmView(_ product: API.OpenFoodFactsProduct, isSaving: Bool) -> some View {
        OpenFoodFactsConfirmView(
            product: product,
            isSaving: isSaving,
            picks: $model.picks,
            vocabulary: vocabulary,
            language: language,
            loadImage: loadImage,
            onConfirm: {
                Task {
                    await model.confirm()
                }
            },
            onReject: {
                model.reject()
                onPickListEntry()
            }
        )
    }

    private var loadImage: CatalogueImageLoader {
        { [model] imageID in
            await model.image(imageID)
        }
    }
}

/// No bean for the barcode: why, and the pick-list entry. "Try again" where a later answer
/// may differ (503, no network, another failure).
struct LookupFallbackView: View {
    let reason: LookupModel.PickListReason
    let onRetry: @MainActor () -> Void
    let onPickListEntry: @MainActor () -> Void

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(LookupFallbackView.title(for: reason))
            } icon: {
                Image(systemName: LookupFallbackView.symbol(for: reason))
                    .accessibilityHidden(true)
            }
        } description: {
            Text(LookupFallbackView.message(for: reason))
        } actions: {
            Button {
                onPickListEntry()
            } label: {
                Label {
                    Text(L10n.scannerPickListEntry)
                } icon: {
                    Image(systemName: "list.bullet")
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("lookup-pick-list")
            if reason.allowsRetry {
                Button {
                    onRetry()
                } label: {
                    Label {
                        Text(L10n.lookupRetry)
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("lookup-retry")
            }
        }
    }

    static func title(for reason: LookupModel.PickListReason) -> LocalizedStringKey {
        switch reason {
        case .rejected: L10n.lookupRejectedTitle
        case .noProduct: L10n.lookupNoProductTitle
        case .limitReached: L10n.lookupLimitTitle
        case .unavailable: L10n.lookupUnavailableTitle
        case .failed: L10n.lookupFailedTitle
        }
    }

    static func message(for reason: LookupModel.PickListReason) -> LocalizedStringKey {
        switch reason {
        case .rejected: L10n.lookupRejectedMessage
        case .noProduct: L10n.lookupNoProductMessage
        case .limitReached: L10n.lookupLimitMessage
        case .unavailable: L10n.lookupUnavailableMessage
        case .failed: L10n.lookupFailedMessage
        }
    }

    static func symbol(for reason: LookupModel.PickListReason) -> String {
        switch reason {
        case .rejected: "hand.raised"
        case .noProduct: "questionmark.square.dashed"
        case .limitReached: "hourglass"
        case .unavailable: "icloud.slash"
        case .failed: "exclamationmark.triangle"
        }
    }
}

/// The "Scan a bag" flow: the scanner until the first valid barcode, then the lookup for it,
/// in place, so no extra tap is needed between scan and bean.
struct ScanFlowView: View {
    let client: APIClient
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let onPickListEntry: @MainActor () -> Void
    @State private var lookup: LookupModel? = nil

    var body: some View {
        if let lookup {
            LookupScreen(model: lookup, vocabulary: vocabulary, language: language, onPickListEntry: onPickListEntry)
        } else {
            ScannerScreen(
                onScanned: { barcode in
                    lookup = LookupModel(barcode: barcode, client: client)
                },
                onPickListEntry: onPickListEntry
            )
        }
    }
}
