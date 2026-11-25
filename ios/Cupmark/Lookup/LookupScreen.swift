import SwiftUI

/// F1 steps 2 and 3 on screen (M2-T14): shows the state of a `LookupModel`. A known bean, an
/// Open Food Facts hit to confirm or reject, or a message with the pick-list entry.
/// `onPickListEntry` opens the pick-list entry (`ScanFlowView` pushes `BeanEntryScreen`, M2-T22).
/// With a `shelf`, a bean gets "Add to Shelf" (M2-T18). A 401 asks the user to sign in again.
struct LookupScreen: View {
    @Bindable var model: LookupModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let onPickListEntry: @MainActor () -> Void
    var shelf: ShelfAddContext? = nil

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
                .safeAreaInset(edge: .bottom) {
                    if let shelf {
                        AddToShelfBar(bean: bean, context: shelf, vocabulary: vocabulary, language: language)
                    }
                }
        case .signInRequired:
            SignInAgainView()
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
///
/// The pick-list entry (`BeanEntryScreen`, M2-T22) is pushed from either screen: from the
/// scanner's "Describe the bean instead" without a barcode, from the lookup's fallback or its
/// Reject with the scanned barcode. The scanner stops its camera while the entry covers it.
struct ScanFlowView: View {
    let client: APIClient
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Called after the pick-list entry was opened. This view pushes the entry itself, so the
    /// caller does not need to do anything here.
    var onPickListEntry: @MainActor () -> Void = {}
    /// Where a found, confirmed or created bean is put on the shelf (M2-T18); nil offers no
    /// "Add to Shelf".
    var shelf: ShelfAddContext? = nil
    @State private var lookup: LookupModel? = nil
    @State private var entry: BeanEntryModel? = nil

    var body: some View {
        flow
            .navigationDestination(isPresented: isShowingEntry) {
                if let entry {
                    BeanEntryScreen(model: entry, vocabulary: vocabulary, language: language, shelf: shelf)
                }
            }
    }

    @ViewBuilder
    private var flow: some View {
        if let lookup {
            LookupScreen(model: lookup, vocabulary: vocabulary, language: language, onPickListEntry: {
                openEntry(barcode: lookup.barcode)
            }, shelf: shelf)
        } else {
            ScannerScreen(
                onScanned: { barcode in
                    lookup = LookupModel(barcode: barcode, client: client)
                },
                onPickListEntry: {
                    openEntry(barcode: nil)
                }
            )
        }
    }

    /// Whether the entry is pushed. Going back clears it, so the next opening starts afresh.
    private var isShowingEntry: Binding<Bool> {
        Binding(
            get: { entry != nil },
            set: { isShown in
                if !isShown {
                    entry = nil
                }
            }
        )
    }

    private func openEntry(barcode: CanonicalBarcode?) {
        entry = BeanEntryModel(barcode: barcode, client: client)
        onPickListEntry()
    }
}
