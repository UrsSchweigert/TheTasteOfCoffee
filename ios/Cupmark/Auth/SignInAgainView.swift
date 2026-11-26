import SwiftUI

/// Shown in the scan flow when the server refused the token, also after a refresh
/// (`APIError.unauthorized`, M2-T18): a sign-in message instead of a retry that would fail the
/// same way. "Sign In" signs out, like a sign-in-required stop of the sync engine
/// (`SyncHostModifier`), so `AuthGate` shows the sign-in screen with the note that the account
/// was deleted or its session ended (`AuthModel.Failure.signInRequired`). Nothing local is lost: the
/// account's store and outbox stay on the device (ADR 0025).
struct SignInAgainView: View {
    var body: some View {
        ContentUnavailableView {
            Label {
                Text(L10n.signInAgainTitle)
            } icon: {
                Image(systemName: "person.crop.circle.badge.exclamationmark")
                    .accessibilityHidden(true)
            }
        } description: {
            Text(L10n.signInAgainMessage)
        } actions: {
            SignInAgainButton()
        }
        .accessibilityIdentifier("sign-in-again")
    }
}

/// The button of `SignInAgainView`, also for forms that show the message in a section.
struct SignInAgainButton: View {
    @Environment(AuthModel.self) private var auth: AuthModel?

    var body: some View {
        Button {
            Task {
                await auth?.signOut(reason: .signInRequired)
            }
        } label: {
            Text(L10n.signInAgainButton)
        }
        .buttonStyle(.borderedProminent)
        .disabled(auth == nil)
        .accessibilityIdentifier("sign-in-again-button")
    }
}
