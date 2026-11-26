import SwiftUI

/// Pushes the settings screen.
struct SettingsRoute: Hashable {}

/// Settings (M2-T30): Export, and the removal of other accounts' data on this device. Later
/// tasks add the consent toggle (M2-T29) and account deletion (M2-T31).
struct SettingsScreen: View {
    let account: AccountID
    let store: AccountStore
    @Environment(\.apiClient) private var apiClient
    @Environment(SyncHost.self) private var sync: SyncHost?
    @State private var localData: LocalDataModel
    @State private var isConfirmingRemoval = false

    init(account: AccountID, store: AccountStore) {
        self.account = account
        self.store = store
        _localData = State(initialValue: LocalDataModel(account: account))
    }

    var body: some View {
        List {
            Section {
                NavigationLink {
                    exportDestination
                } label: {
                    Label {
                        Text(L10n.exportTitle)
                    } icon: {
                        Image(systemName: "square.and.arrow.up")
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("settings-export")
            }
            Section {
                Button(role: .destructive) {
                    isConfirmingRemoval = true
                } label: {
                    Label {
                        Text(L10n.localDataRemove)
                    } icon: {
                        Image(systemName: "trash")
                            .accessibilityHidden(true)
                    }
                }
                .disabled(localData.otherAccountCount == 0)
                .accessibilityIdentifier("settings-remove-local-data")
                switch localData.result {
                case .untouched:
                    EmptyView()
                case .removed:
                    Text(L10n.localDataRemoved)
                case .failed:
                    Text(L10n.localDataFailed)
                }
            } header: {
                Text(L10n.localDataHeader)
            } footer: {
                Text(localData.otherAccountCount == 0 ? L10n.localDataNone : L10n.localDataFooter)
            }
        }
        .navigationTitle(Text(L10n.settingsTitle))
        .confirmationDialog(L10n.localDataConfirmTitle, isPresented: $isConfirmingRemoval, titleVisibility: .visible) {
            Button(role: .destructive) {
                localData.removeOtherAccounts()
            } label: {
                Text(L10n.localDataRemoveConfirm)
            }
        } message: {
            Text(L10n.localDataConfirmMessage)
        }
        .onAppear {
            localData.reload()
        }
    }

    @ViewBuilder
    private var exportDestination: some View {
        if let apiClient, let engine = sync?.engine {
            ExportScreen(model: ExportModel(source: apiClient, outbox: .live(engine: engine, store: store)))
        } else {
            NotConfiguredView()
        }
    }
}
