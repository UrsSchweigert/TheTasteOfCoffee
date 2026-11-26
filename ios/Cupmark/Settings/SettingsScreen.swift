import SwiftUI

/// Pushes Settings from the shelf (a value route, so the screen and its model are made only
/// when it opens).
struct SettingsRoute: Hashable {}

/// Settings, one tap from the shelf. Each topic is its own section, built by its own
/// function: Privacy (the consent, M2-T29), Export (M2-T30), the removal of other accounts'
/// data on this device (M2-T30), and Delete Account (M2-T31). No control takes typed text.
/// Export and account deletion are pushed screens outside `Settings/`, which read what they
/// need from the environment, so no settings file touches the API client.
struct SettingsScreen: View {
    let account: AccountID?
    let store: AccountStore
    @Environment(SyncHost.self) private var sync: SyncHost?
    @State private var model: SettingsModel
    @State private var localData: LocalDataModel?
    @State private var isConfirmingRemoval = false

    /// `account` is the signed-in account; without it the export and local data sections are
    /// left out and the consent still works.
    init(account: AccountID? = nil, store: AccountStore) {
        self.account = account
        self.store = store
        _model = State(initialValue: SettingsModel(store: store))
        _localData = State(initialValue: account.map { LocalDataModel(account: $0) })
    }

    var body: some View {
        List {
            privacySection
            exportSection
            localDataSection
            deleteAccountSection
        }
        .navigationTitle(Text(L10n.settingsTitle))
        .accessibilityIdentifier("settings")
        .confirmationDialog(L10n.localDataConfirmTitle, isPresented: $isConfirmingRemoval, titleVisibility: .visible) {
            Button(role: .destructive) {
                localData?.removeOtherAccounts()
            } label: {
                Text(L10n.localDataRemoveConfirm)
            }
        } message: {
            Text(L10n.localDataConfirmMessage)
        }
        .onAppear {
            model.reload()
            localData?.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: store)) { _ in
            // A pull may bring the consent chosen on another device.
            model.reload()
        }
    }

    // MARK: - Sections

    /// The consent (D1, ADR 0017): opt-in, and turning it off keeps every personal feature.
    private var privacySection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { model.contributesToAggregates },
                set: { value in model.setContributesToAggregates(value) }
            )) {
                Text(L10n.settingsConsentToggle)
            }
            .disabled(model.loadFailed)
            .accessibilityHint(Text(L10n.settingsConsentHint))
            .accessibilityIdentifier("settings-consent")
            if model.loadFailed {
                Text(L10n.settingsLoadFailed)
                    .foregroundStyle(.secondary)
            }
            if model.saveFailed {
                Label {
                    Text(L10n.settingsConsentSaveFailed)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.red)
            }
        } header: {
            Text(L10n.settingsPrivacyHeader)
        } footer: {
            Text(L10n.settingsConsentFooter)
        }
    }

    /// CSV export (M2-T30).
    private var exportSection: some View {
        Section {
            NavigationLink {
                ExportDestination(store: store)
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
    }

    /// Account deletion (M2-T31): pushes the two confirmation steps (`AccountDeletionDestination`).
    private var deleteAccountSection: some View {
        Section {
            NavigationLink {
                AccountDeletionDestination()
            } label: {
                Label {
                    Text(L10n.accountDeletionTitle)
                } icon: {
                    Image(systemName: "person.crop.circle.badge.xmark")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.red)
            }
            .accessibilityIdentifier("settings-delete-account")
        } footer: {
            Text(L10n.accountDeletionSettingsFooter)
        }
    }

    /// Removal of other accounts' data on this device (M2-T30).
    @ViewBuilder
    private var localDataSection: some View {
        if let localData {
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
    }
}
