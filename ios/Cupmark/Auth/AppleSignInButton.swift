import SwiftUI

/// The Sign in with Apple button, drawn in Apple's style (Human Interface Guidelines, Sign in
/// with Apple: black on a light background, white on a dark one, the Apple logo before the
/// title, a rounded rectangle, at least 44 points high).
///
/// Not `AuthenticationServices.SignInWithAppleButton`: that control always starts the native
/// `ASAuthorizationController` request when tapped, which needs the Sign in with Apple
/// entitlement and returns an Apple identity token that the Cognito hosted UI cannot take.
/// It offers no way to run another action instead. This button starts the Cognito web flow
/// through the Services ID, so the app needs no entitlement (M2-T11).
///
/// The title is Apple's wording in each language ("Sign in with Apple", "Mit Apple anmelden")
/// from the String Catalog, and it scales with Dynamic Type.
struct AppleSignInButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(L10n.signInWithApple)
            } icon: {
                Image(systemName: "apple.logo")
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(AppleSignInButtonStyle())
        .accessibilityLabel(Text(L10n.signInWithApple))
        .accessibilityIdentifier("sign-in-with-apple")
    }
}

private struct AppleSignInButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        return configuration.label
            .labelStyle(.titleAndIcon)
            .font(.title3.weight(.medium))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(colorScheme == .dark ? Color.white : Color.black, in: shape)
            .contentShape(shape)
            .opacity(configuration.isPressed ? 0.7 : (isEnabled ? 1 : 0.5))
    }
}
