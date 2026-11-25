import AuthenticationServices
import UIKit

/// Opens the hosted sign-in page and returns the callback URL. A protocol, so the sign-in
/// flow is tested without a browser.
protocol WebAuthenticator: Sendable {
    /// Throws `AuthError.cancelled` when the user closes the sheet.
    @MainActor
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

/// `WebAuthenticator` with `ASWebAuthenticationSession`.
///
/// - `prefersEphemeralWebBrowserSession` is true: the sheet shares no cookies with Safari and
///   keeps none. Nothing of the Cognito or Apple web session outlives the sign-in, so
///   sign-out needs no hosted `/logout` call (`cupmark://signout` stays unused) and the next
///   sign-in cannot silently reuse the previous user. iOS also skips its "wants to use ... to
///   sign in" alert for an ephemeral session. The cost is that Apple asks for the Apple ID
///   each time, which happens rarely: the refresh token lasts 30 days.
/// - The only callback accepted is the custom scheme `cupmark` (`StageConfig.callbackScheme`).
///   No URL scheme is registered in Info.plist; the session catches the redirect itself.
@MainActor
final class SystemWebAuthenticator: WebAuthenticator {
    /// Held while the sheet is open; both are released when it ends.
    private var session: ASWebAuthenticationSession?
    private var anchorProvider: PresentationAnchorProvider?

    nonisolated init() {}

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, any Error>) in
            let completion: ASWebAuthenticationSession.CompletionHandler = { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    self?.anchorProvider = nil
                }
                if let error {
                    if let sessionError = error as? ASWebAuthenticationSessionError, sessionError.code == .canceledLogin {
                        continuation.resume(throwing: AuthError.cancelled)
                    } else {
                        continuation.resume(throwing: AuthError.couldNotStart)
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: AuthError.unexpectedCallback)
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme), completionHandler: completion)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completion)
            }
            let anchorProvider = PresentationAnchorProvider(anchor: SystemWebAuthenticator.keyWindow())
            session.prefersEphemeralWebBrowserSession = true
            session.presentationContextProvider = anchorProvider
            self.session = session
            self.anchorProvider = anchorProvider
            if !session.start() {
                self.session = nil
                self.anchorProvider = nil
                continuation.resume(throwing: AuthError.couldNotStart)
            }
        }
    }

    /// The key window of the app's scenes, for the sign-in sheet.
    private static func keyWindow() -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
    }
}

/// Gives the session the window it was started from. The window is looked up on the main
/// actor before the session starts, so this callback needs no actor of its own.
private final class PresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }
}
