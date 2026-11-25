import SwiftUI

/// Shows `content` only while someone is signed in (ADR 0020: no local-only mode), the
/// sign-in screen otherwise. Reads the `AuthModel` from the environment and passes the
/// signed-in `AccountID` to `content`, for the local store (M2-T15).
///
/// Until the account screen exists, sign-out is a toolbar button with a confirmation.
struct AuthGate<Content: View>: View {
    @Environment(AuthModel.self) private var auth: AuthModel?
    @State private var confirmingSignOut = false
    private let content: (AccountID) -> Content

    init(@ViewBuilder content: @escaping (AccountID) -> Content) {
        self.content = content
    }

    var body: some View {
        Group {
            if let auth {
                gated(auth)
            } else {
                NotConfiguredView()
            }
        }
        .task {
            await auth?.start()
        }
    }

    @ViewBuilder
    private func gated(_ auth: AuthModel) -> some View {
        switch auth.phase {
        case .restoring:
            ProgressView()
                .accessibilityLabel(Text(L10n.authRestoring))
        case .signedOut, .signingIn:
            SignInView(isSigningIn: auth.phase == .signingIn, failure: auth.failure) {
                Task {
                    await auth.signIn()
                }
            }
        case .signedIn(let account):
            content(account)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            confirmingSignOut = true
                        } label: {
                            Text(L10n.accountSignOut)
                        }
                        .accessibilityIdentifier("sign-out")
                    }
                }
                .confirmationDialog(L10n.accountSignOutConfirmTitle, isPresented: $confirmingSignOut, titleVisibility: .visible) {
                    Button(role: .destructive) {
                        Task {
                            await auth.signOut()
                        }
                    } label: {
                        Text(L10n.accountSignOut)
                    }
                }
        }
    }
}
