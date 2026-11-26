import SwiftUI

/// The sign-in screen (M2-T11). Its only control is the Sign in with Apple button: no other
/// input, no account form. The app asks for no name and no email.
///
/// While an account deletion waits for a new sign-in (M2-T31, `finishesDeletion`), the screen
/// says that signing in with that account finishes the deletion, and that a different account
/// is only deleted after the user confirms it. The failure note is shown as well.
struct SignInView: View {
    let isSigningIn: Bool
    let failure: AuthModel.Failure?
    var finishesDeletion = false
    let onSignIn: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "cup.and.saucer.fill")
                    .font(.largeTitle)
                    .imageScale(.large)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(L10n.signInTitle)
                    .themeTitle()
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(L10n.signInMessage)
                    .font(.body)
                    .secondaryText()
                    .multilineTextAlignment(.center)
                if finishesDeletion {
                    Text(L10n.accountDeletionSignInNote)
                        .font(.callout)
                        .foregroundStyle(Theme.errorText)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("sign-in-deletion-note")
                }
                // Also while a deletion waits: why the last sign-in failed, or that it expired.
                if let failure {
                    Text(failure.message)
                        .font(.callout)
                        .foregroundStyle(failure.isProblem ? Theme.errorText : Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("sign-in-failure")
                }
                AppleSignInButton(action: onSignIn)
                    .disabled(isSigningIn)
                if isSigningIn {
                    ProgressView()
                        .accessibilityLabel(Text(L10n.signInInProgress))
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .screenBackground()
        .accessibilityIdentifier("sign-in")
    }
}
