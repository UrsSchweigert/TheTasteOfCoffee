import SwiftUI

/// Placeholder root screen (M0-T6): shows that the bundled vocabulary loads
/// and resolves labels in the device language. Read-only; no inputs yet.
/// Without a valid stage configuration (M2-T9) it shows only the "not configured" screen.
struct RootView: View {
    let state: VocabularyLoadState
    let stage: StageConfigLoadState

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text(L10n.appTitle))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch stage {
        case .configured:
            vocabularyContent
        case .notConfigured:
            NotConfiguredView()
        }
    }

    @ViewBuilder
    private var vocabularyContent: some View {
        switch state {
        case .loaded(let store, let language):
            List {
                Section {
                    // M2-T14 connects onScanned to the lookup, M2-T22 onPickListEntry to the
                    // pick-list entry. Until then both are placeholders.
                    NavigationLink {
                        ScannerScreen(onScanned: { _ in }, onPickListEntry: {})
                    } label: {
                        Label {
                            Text(L10n.rootScanBag)
                        } icon: {
                            Image(systemName: "barcode.viewfinder")
                                .accessibilityHidden(true)
                        }
                    }
                }
                Section {
                    ForEach(Vocabulary.Method.allCases) { method in
                        // Vocabulary labels come from contracts/i18n, not the String Catalog.
                        Text(verbatim: (try? store.label(for: method, language: language)) ?? method.rawValue)
                    }
                } header: {
                    Text(L10n.rootMethodsHeader)
                }
            }
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
        }
    }
}
