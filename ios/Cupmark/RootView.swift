import SwiftUI

/// Placeholder root screen (M0-T6): shows that the bundled vocabulary loads
/// and resolves labels in the device language. Read-only; no inputs yet.
/// Without a valid stage configuration (M2-T9) it shows only the "not configured" screen.
struct RootView: View {
    let state: VocabularyLoadState
    let stage: StageConfigLoadState
    /// Set by `CupmarkApp` when the stage is configured (M2-T14).
    @Environment(\.apiClient) private var apiClient
    /// The signed-in account, which the navigation stack is keyed by (M2-T18).
    @Environment(AuthModel.self) private var auth: AuthModel?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text(L10n.appTitle))
        }
        // A new stack on every account change and on sign-out, so no pushed screen (a shelf
        // entry, the scan flow) of the previous account stays on the path.
        .id(auth?.accountID)
    }

    @ViewBuilder
    private var content: some View {
        switch stage {
        case .configured:
            // Signed-in content only (M2-T11); the closure gets the local store's AccountID.
            AuthGate { account in
                signedInContent(account)
            }
        case .notConfigured:
            NotConfiguredView()
        }
    }

    /// The signed-in root (M2-T18): the shelf of the account's local store, with "Scan a bag"
    /// on it. Without a vocabulary, the error below.
    @ViewBuilder
    private func signedInContent(_ account: AccountID) -> some View {
        if case .loaded(let store, let language) = state {
            ShelfRoot(account: account, vocabulary: store, language: language)
        } else {
            vocabularyContent
        }
    }

    @ViewBuilder
    private var vocabularyContent: some View {
        switch state {
        case .loaded(let store, let language):
            List {
                Section {
                    // The scan leads to the lookup (M2-T14). M2-T22 connects onPickListEntry
                    // to the pick-list entry; until then it is a placeholder.
                    NavigationLink {
                        if let apiClient {
                            ScanFlowView(client: apiClient, vocabulary: store, language: language, onPickListEntry: {})
                        } else {
                            NotConfiguredView()
                        }
                    } label: {
                        Label {
                            Text(L10n.rootScanBag)
                        } icon: {
                            Image(systemName: "barcode.viewfinder")
                                .accessibilityHidden(true)
                        }
                    }
                }
                .surfaceRow()
                Section {
                    ForEach(Vocabulary.Method.allCases) { method in
                        // Vocabulary labels come from contracts/i18n, not the String Catalog.
                        Text(verbatim: (try? store.label(for: method, language: language)) ?? method.rawValue)
                    }
                } header: {
                    Text(L10n.rootMethodsHeader)
                        .secondaryText()
                }
                .surfaceRow()
            }
            .listBackground()
        case .failed:
            ContentUnavailableView {
                Label {
                    Text(L10n.rootVocabularyErrorTitle)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
            } description: {
                Text(L10n.rootVocabularyErrorMessage)
            }
            .screenBackground()
        }
    }
}
