import SwiftUI

/// Settings, then Delete Account (M2-T31). Kept out of `Settings/`, like `ExportDestination`: it
/// reads the app's `AccountDeletionModel` from the environment, which holds the API client, so
/// no settings file ever touches the API (the profile goes through the outbox only). Without a
/// model (no configured stage) it shows the not-configured view.
struct AccountDeletionDestination: View {
    @Environment(AccountDeletionModel.self) private var deletion: AccountDeletionModel?

    var body: some View {
        if let deletion {
            AccountDeletionScreen(model: deletion)
        } else {
            NotConfiguredView()
        }
    }
}

/// The two confirmation steps, with buttons only (M2-T31). Both say what is deleted: the data,
/// the label photos of unverified beans, and the sign-in.
///
/// 1. This screen lists what goes and offers "Continue to Deletion".
/// 2. A confirmation dialog says it once more and offers "Delete Account", which starts the
///    deletion (`AccountDeletionModel.start()`); its Cancel keeps everything.
///
/// From the shelf: Settings, Delete Account, Continue to Deletion, Delete Account (4 taps).
struct AccountDeletionScreen: View {
    let model: AccountDeletionModel
    @State private var isConfirming = false

    var body: some View {
        List {
            Section {
                AccountDeletionItem(text: L10n.accountDeletionWhatData, systemImage: "cup.and.saucer")
                AccountDeletionItem(text: L10n.accountDeletionWhatPhotos, systemImage: "camera")
                AccountDeletionItem(text: L10n.accountDeletionWhatSignIn, systemImage: "person.crop.circle.badge.xmark")
            } header: {
                Text(L10n.accountDeletionWhatHeader)
                    .secondaryText()
            } footer: {
                Text(L10n.accountDeletionWhatFooter)
                    .secondaryText()
            }
            .surfaceRow()
            Section {
                Button(role: .destructive) {
                    isConfirming = true
                } label: {
                    Text(L10n.accountDeletionContinue)
                }
                .disabled(model.isActive)
                .accessibilityHint(Text(L10n.accountDeletionContinueHint))
                .accessibilityIdentifier("account-deletion-continue")
                if model.state == .couldNotStart {
                    Label {
                        Text(L10n.accountDeletionCouldNotStart)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(Theme.errorText)
                }
            } footer: {
                Text(L10n.accountDeletionExportHint)
                    .secondaryText()
            }
            .surfaceRow()
        }
        .listBackground()
        .navigationTitle(Text(L10n.accountDeletionTitle))
        .accessibilityIdentifier("account-deletion")
        .confirmationDialog(L10n.accountDeletionConfirmTitle, isPresented: $isConfirming, titleVisibility: .visible) {
            Button(role: .destructive) {
                model.start()
            } label: {
                Text(L10n.accountDeletionConfirm)
            }
            .accessibilityIdentifier("account-deletion-confirm")
        } message: {
            Text(L10n.accountDeletionConfirmMessage)
        }
    }
}

/// One thing that is deleted, with its icon.
private struct AccountDeletionItem: View {
    let text: LocalizedStringKey
    let systemImage: String

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: systemImage)
                .accessibilityHidden(true)
        }
    }
}

/// Shown instead of every signed-in screen while a deletion runs (M2-T31), so nothing can be
/// changed or sent and there is no sign-out before the 204. It follows the model's state:
/// deleting, waiting to retry (with "Try Now"), sign in again (with "Sign In Again", which
/// renews the sign-in without signing out, and the warning about another account), the
/// confirmation for another or an unknown account ("Delete This Account" or "Sign Out",
/// ADR 0031), and a failed cleanup (with "Try Now").
struct AccountDeletionProgressView: View {
    let model: AccountDeletionModel
    @Environment(AuthModel.self) private var auth: AuthModel?

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "person.crop.circle.badge.xmark")
                    .font(.largeTitle)
                    .imageScale(.large)
                    .secondaryText()
                    .accessibilityHidden(true)
                Text(L10n.accountDeletionProgressTitle)
                    .themeTitle(.title2)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                status
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .screenBackground()
        .accessibilityIdentifier("account-deletion-progress")
    }

    @ViewBuilder
    private var status: some View {
        switch model.state {
        case .idle, .deleting, .couldNotStart:
            ProgressView()
                .accessibilityHidden(true)
            message(L10n.accountDeletionProgressMessage)
        case .waitingToRetry:
            message(L10n.accountDeletionRetrying)
            Button {
                model.resume()
            } label: {
                Text(L10n.accountDeletionRetryNow)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("account-deletion-retry")
        case .signInRequired:
            message(L10n.accountDeletionSignInRequired)
            // The same warning as the sign-in screen: which account a sign-in deletes.
            message(L10n.accountDeletionSignInNote)
            if let failure = model.signInAgainFailure {
                Text(failure.message)
                    .font(.callout)
                    .foregroundStyle(Theme.errorText)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("account-deletion-sign-in-failure")
            }
            Button {
                Task {
                    await model.signInAgain()
                }
            } label: {
                Text(L10n.accountDeletionSignInAgain)
            }
            .buttonStyle(.prominent)
            .disabled(auth?.isSigningInAgain ?? false)
            .accessibilityIdentifier("account-deletion-sign-in-again")
        case .confirmDifferentAccount, .confirmUnreadableRecord:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title)
                .foregroundStyle(Theme.errorText)
                .accessibilityHidden(true)
            Text(model.state == .confirmDifferentAccount ? L10n.accountDeletionDifferentAccountMessage : L10n.accountDeletionUnreadableRecordMessage)
                .font(.body)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("account-deletion-confirm-account")
            Button(role: .destructive) {
                model.deleteSignedInAccount()
            } label: {
                Text(L10n.accountDeletionDeleteThisAccount)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint(Text(L10n.accountDeletionDeleteThisAccountHint))
            .accessibilityIdentifier("account-deletion-delete-this-account")
            Button {
                Task {
                    await model.signOutOfSignedInAccount()
                }
            } label: {
                Text(L10n.accountDeletionSignOutInstead)
            }
            .buttonStyle(.bordered)
            .accessibilityHint(Text(L10n.accountDeletionSignOutInsteadHint))
            .accessibilityIdentifier("account-deletion-sign-out-instead")
        case .cleanupFailed:
            message(L10n.accountDeletionCleanupFailed)
            Button {
                model.resume()
            } label: {
                Text(L10n.accountDeletionRetryNow)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("account-deletion-retry")
        }
    }

    private func message(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.body)
            .secondaryText()
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("account-deletion-status")
    }
}

/// Connects the app's `AccountDeletionModel` to the sign-in state (M2-T31): a recorded deletion
/// goes on at launch, after every change of the signed-in account (a new sign-in after the
/// token could not be refreshed) and when the app comes back to the foreground.
struct AccountDeletionModifier: ViewModifier {
    let deletion: AccountDeletionModel?
    let auth: AuthModel?
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: auth?.accountID, initial: true) { _, _ in
                deletion?.resume()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    deletion?.resume()
                }
            }
    }
}

extension View {
    /// Resumes a recorded account deletion (M2-T31).
    func accountDeletion(_ deletion: AccountDeletionModel?, auth: AuthModel?) -> some View {
        modifier(AccountDeletionModifier(deletion: deletion, auth: auth))
    }
}
