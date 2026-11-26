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
    /// The shelf entry whose brew form is open (M2-T19).
    @State private var brewing: BrewRoute?
    /// The Open Food Facts hits of pending beans waiting for the user (M2-T25).
    @State private var pendingBeans: PendingBeansModel
    @State private var isConfirmingBeans = false
    /// Whether the questions were offered since the app was last opened; they are asked once
    /// each time the app comes to the foreground, not on every return to the shelf.
    @State private var askedForConfirmation = false
    /// Whether the shelf itself is on screen: false while a screen is pushed over it (an entry,
    /// the scan flow, the sync issues), whatever that screen presents. With no sheet of its own
    /// up, this is the gate for the questions.
    @State private var isOnScreen = false
    @Environment(\.apiClient) private var apiClient
    @Environment(\.scenePhase) private var scenePhase

    init(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.store = store
        self.vocabulary = vocabulary
        self.language = language
        _model = State(initialValue: ShelfModel(store: store))
        _pendingBeans = State(initialValue: PendingBeansModel(store: store))
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
            if model.questionCount > 0 {
                Section {
                    Button {
                        isConfirmingBeans = true
                    } label: {
                        LabeledContent {
                            Text(model.questionCount, format: .number)
                        } label: {
                            Label {
                                Text(L10n.pendingBeansRow)
                            } icon: {
                                Image(systemName: "questionmark.circle")
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .accessibilityIdentifier("shelf-pending-beans")
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
                // Personal statistics (M2-T28), read from this store, offline. A value route,
                // so the screen and its model are made only when it opens.
                NavigationLink(value: StatisticsRoute()) {
                    Label {
                        Text(L10n.statisticsTitle)
                    } icon: {
                        Image(systemName: "chart.bar")
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("shelf-statistics")
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
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            // Logs a brew of this bag (M2-T19); VoiceOver lists it as an action.
                            Button {
                                brewing = BrewRoute(shelfEntryLocalID: row.id)
                            } label: {
                                Label {
                                    Text(L10n.brewStart)
                                } icon: {
                                    Image(systemName: "cup.and.saucer")
                                }
                            }
                            .tint(.brown)
                            .accessibilityIdentifier("shelf-entry-brew")
                            // Repeats the last brew on this bag, prefilled (M2-T27).
                            if model.canRepeatLastBrew {
                                Button {
                                    brewing = BrewRoute(shelfEntryLocalID: row.id, start: .lastBrew)
                                } label: {
                                    Label {
                                        Text(L10n.brewRepeatLast)
                                    } icon: {
                                        Image(systemName: "arrow.clockwise")
                                    }
                                }
                                .tint(.indigo)
                                .accessibilityIdentifier("shelf-entry-repeat")
                            }
                        }
                    }
                }
            } header: {
                Text(L10n.shelfHeader)
            }
        }
        .sheet(item: $brewing) { route in
            // The brew form, then the rating of the new brew (M2-T20).
            BrewSheet(store: store, route: route, vocabulary: vocabulary, language: language)
        }
        .navigationDestination(for: ShelfEntryRoute.self) { route in
            ShelfEntryEditorScreen(store: store, mode: .edit(route.localID), vocabulary: vocabulary, language: language)
        }
        .navigationDestination(for: StatisticsRoute.self) { _ in
            StatisticsScreen(store: store, vocabulary: vocabulary, language: language)
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
        .sheet(isPresented: $isConfirmingBeans, onDismiss: {
            model.reload()
        }) {
            NavigationStack {
                PendingBeansScreen(model: pendingBeans, vocabulary: vocabulary, language: language)
            }
        }
        .onAppear {
            isOnScreen = true
            model.reload()
            askForConfirmationIfDue()
        }
        .onDisappear {
            isOnScreen = false
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: store)) { _ in
            model.reload()
        }
        .onChange(of: scenePhase) { _, phase in
            // Days since roast move on with the calendar day.
            if phase == .active {
                model.reload()
                askForConfirmationIfDue()
            } else if phase == .background {
                // The next opening asks again.
                askedForConfirmation = false
            }
        }
    }

    /// Opens the confirmation of pending beans' Open Food Facts hits once per opening of the
    /// app, if there are any (M2-T25).
    private func askForConfirmationIfDue() {
        // Only on the bare shelf: not over its own brew sheet, and not while any pushed screen
        // (and whatever sheet that screen shows) covers it.
        guard isOnScreen, !askedForConfirmation, !isConfirmingBeans, brewing == nil, !isScanning else {
            return
        }
        pendingBeans.reload()
        if pendingBeans.current != nil {
            askedForConfirmation = true
            isConfirmingBeans = true
        }
    }
}
