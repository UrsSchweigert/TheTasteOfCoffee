import SwiftUI

/// Placeholder root screen (M0-T6): shows that the bundled vocabulary loads
/// and resolves labels in the device language. Read-only; no inputs yet.
struct RootView: View {
    let state: VocabularyLoadState

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text(L10n.appTitle))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loaded(let store, let language):
            List {
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
