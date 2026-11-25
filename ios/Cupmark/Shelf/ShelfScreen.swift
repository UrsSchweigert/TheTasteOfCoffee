import Combine
import SwiftUI

/// Pushes a stored shelf entry's screen.
struct ShelfEntryRoute: Hashable {
    let localID: UUID
}

/// The signed-in root (M2-T18): the shelf of `account`'s local store, once `SyncHost` has
/// opened it. A store that cannot be opened shows an error instead of an empty shelf.
struct ShelfRoot: View {
    let account: AccountID
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(SyncHost.self) private var sync: SyncHost?

    var body: some View {
        if let sync {
            // `account` is observed; the store is set in the same step as it (SyncHost.switchTo).
            if sync.account == account {
                if let store = sync.store {
                    ShelfScreen(store: store, vocabulary: vocabulary, language: language)
                        .id(ObjectIdentifier(store))
                } else {
                    ContentUnavailableView {
                        Label {
                            Text(L10n.shelfStoreErrorTitle)
                        } icon: {
                            Image(systemName: "externaldrive.badge.exclamationmark")
                                .accessibilityHidden(true)
                        }
                    } description: {
                        Text(L10n.shelfStoreErrorMessage)
                    }
                }
            } else {
                ProgressView()
                    .accessibilityLabel(Text(L10n.shelfLoading))
            }
        } else {
            NotConfiguredView()
        }
    }
}

/// The shelf list (docs/04 F1 step 5), read from the local store, so it works offline. Each
/// row shows the bean, the roast date, days since roast and the brew count, and opens the
/// entry. "Scan a bag" starts the scan flow, which ends here after a shelf entry is saved.
/// A row at the top leads to the sync issues while there are any.
struct ShelfScreen: View {
    let store: AccountStore
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @State private var model: ShelfModel
    @State private var isScanning = false
    @Environment(\.apiClient) private var apiClient
    @Environment(\.scenePhase) private var scenePhase

    init(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.store = store
        self.vocabulary = vocabulary
        self.language = language
        _model = State(initialValue: ShelfModel(store: store))
    }

    var body: some View {
        List {
            if model.issueCount > 0 {
                Section {
                    NavigationLink {
                        SyncIssuesScreen(store: store, vocabulary: vocabulary, language: language)
                    } label: {
                        LabeledContent {
                            Text(model.issueCount, format: .number)
                        } label: {
                            Label {
                                Text(L10n.syncIssuesTitle)
                            } icon: {
                                Image(systemName: "exclamationmark.icloud")
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .accessibilityIdentifier("shelf-sync-issues")
                }
            }
            Section {
                Button {
                    isScanning = true
                } label: {
                    Label {
                        Text(L10n.rootScanBag)
                    } icon: {
                        Image(systemName: "barcode.viewfinder")
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("shelf-scan")
            }
            Section {
                if model.loadFailed {
                    Text(L10n.shelfStoreErrorTitle)
                        .foregroundStyle(.secondary)
                } else if model.rows.isEmpty {
                    Text(L10n.shelfEmpty)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.rows) { row in
                        NavigationLink(value: ShelfEntryRoute(localID: row.id)) {
                            ShelfRowView(row: row, vocabulary: vocabulary, language: language)
                        }
                        .accessibilityIdentifier("shelf-entry-row")
                    }
                }
            } header: {
                Text(L10n.shelfHeader)
            }
        }
        .navigationDestination(for: ShelfEntryRoute.self) { route in
            ShelfEntryEditorScreen(store: store, mode: .edit(route.localID), vocabulary: vocabulary, language: language)
        }
        .navigationDestination(isPresented: $isScanning) {
            if let apiClient {
                ScanFlowView(
                    client: apiClient,
                    vocabulary: vocabulary,
                    language: language,
                    shelf: ShelfAddContext(store: store, onSaved: { _ in
                        // Back to the shelf, where the new entry is listed.
                        isScanning = false
                    })
                )
            } else {
                NotConfiguredView()
            }
        }
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: store)) { _ in
            model.reload()
        }
        .onChange(of: scenePhase) { _, phase in
            // Days since roast move on with the calendar day.
            if phase == .active {
                model.reload()
            }
        }
    }
}
