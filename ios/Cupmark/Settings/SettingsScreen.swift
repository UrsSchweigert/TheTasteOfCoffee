import SwiftUI

/// Pushes Settings from the shelf (a value route, so the screen and its model are made only
/// when it opens).
struct SettingsRoute: Hashable {}

/// Settings, one tap from the shelf. Each topic is its own section, built by its own
/// function: Privacy (the consent, M2-T29), Export (M2-T30), the removal of other accounts'
/// data on this device (M2-T30), and the account: Sign Out (M2-T51) and Delete Account (M2-T31). No control takes typed text.
/// Export and account deletion are pushed screens outside `Settings/`, which read what they
/// need from the environment, so no settings file touches the API client.
struct SettingsScreen: View {
    let account: AccountID?
    let store: AccountStore
    @Environment(SyncHost.self) private var sync: SyncHost?
    @State private var model: SettingsModel
    @State private var localData: LocalDataModel?
    @State private var isConfirmingRemoval = false
    @State private var isConfirmingSignOut = false
    /// For the sign-out row (M2-T51); nil in previews and the UI-test screen, which show no row.
    @Environment(AuthModel.self) private var auth: AuthModel?

    /// `account` is the signed-in account; without it the export and local data sections are
    /// left out and the consent still works. `backup` and `folders` are the device's brew photo
    /// backup setting and photo folders (M2-T45); the app uses the standard ones.
    init(
        account: AccountID? = nil,
        store: AccountStore,
        backup: BrewPhotoBackupSetting = .standard,
        folders: BrewPhotoFolders? = .standard
    ) {
        self.account = account
        self.store = store
        _model = State(initialValue: SettingsModel(store: store, backup: backup, folders: folders))
        _localData = State(initialValue: account.map { LocalDataModel(account: $0) })
    }

    var body: some View {
        List {
            privacySection
            brewPhotoBackupSection
            exportSection
            localDataSection
            accountSection
        }
        .listBackground()
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
            .tint(Theme.accent)
            .disabled(model.loadFailed)
            .accessibilityHint(Text(L10n.settingsConsentHint))
            .accessibilityIdentifier("settings-consent")
            if model.loadFailed {
                Text(L10n.settingsLoadFailed)
                    .secondaryText()
            }
            if model.saveFailed {
                Label {
                    Text(L10n.settingsConsentSaveFailed)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(Theme.errorText)
            }
        } header: {
            Text(L10n.settingsPrivacyHeader)
                .secondaryText()
        } footer: {
            Text(L10n.settingsConsentFooter)
                .secondaryText()
        }
        .surfaceRow()
    }

    /// Brew photos in the device backup (M2-T45, ADR 0033 addendum): per device, off by default,
    /// not synced. The footer says what the current state means.
    private var brewPhotoBackupSection: some View {
        let footer = model.brewPhotosInBackup ? L10n.settingsPhotoBackupFooterOn : L10n.settingsPhotoBackupFooterOff
        return Section {
            Toggle(isOn: Binding(
                get: { model.brewPhotosInBackup },
                set: { value in model.setBrewPhotosInBackup(value) }
            )) {
                Text(L10n.settingsPhotoBackupToggle)
            }
            .tint(Theme.accent)
            .minimumTapTarget()
            .accessibilityLabel(Text(L10n.settingsPhotoBackupToggle))
            .accessibilityHint(Text(footer))
            .accessibilityIdentifier("settings-photo-backup")
            if model.backupApplyFailed {
                Label {
                    Text(L10n.settingsPhotoBackupApplyFailed)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(Theme.errorText)
            }
        } header: {
            Text(L10n.settingsPhotosHeader)
                .secondaryText()
        } footer: {
            Text(footer)
                .secondaryText()
        }
        .surfaceRow()
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
        .surfaceRow()
    }

    /// The account (M2-T51, M2-T31): "Sign out" with its confirmation, then account deletion,
    /// which pushes the two confirmation steps (`AccountDeletionDestination`). The dialog sits on
    /// the sign-out button, which stays on screen until the sign-out replaces the whole stack.
    private var accountSection: some View {
        Section {
            if let auth {
                Button {
                    isConfirmingSignOut = true
                } label: {
                    Label {
                        Text(L10n.accountSignOut)
                    } icon: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .accessibilityHidden(true)
                    }
                }
                .minimumTapTarget()
                .accessibilityIdentifier("settings-sign-out")
                .confirmationDialog(L10n.accountSignOutConfirmTitle, isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
                    Button(role: .destructive) {
                        Task {
                            await auth.signOut()
                        }
                    } label: {
                        Text(L10n.accountSignOut)
                    }
                }
            }
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
                .secondaryText()
        }
        .surfaceRow()
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
                    .secondaryText()
            } footer: {
                Text(localData.otherAccountCount == 0 ? L10n.localDataNone : L10n.localDataFooter)
                    .secondaryText()
            }
            .surfaceRow()
        }
    }
}
