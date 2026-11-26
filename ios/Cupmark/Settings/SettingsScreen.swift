import SwiftUI

/// Pushes Settings from the shelf (a value route, so the screen and its model are made only
/// when it opens).
struct SettingsRoute: Hashable {}

/// Settings (M2-T29), one tap from the shelf. Each topic is its own section, built by its own
/// function: Privacy (the consent) now; Export (M2-T30) and account deletion (M2-T31) add a
/// section each, with their own model, below it. No control takes typed text.
struct SettingsScreen: View {
    let store: AccountStore
    @State private var model: SettingsModel

    init(store: AccountStore) {
        self.store = store
        _model = State(initialValue: SettingsModel(store: store))
    }

    var body: some View {
        List {
            privacySection
        }
        .navigationTitle(Text(L10n.settingsTitle))
        .accessibilityIdentifier("settings")
        .onAppear {
            model.reload()
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
}
