#if DEBUG
import Foundation

/// The sign-in of a UI-test launch (M2-T33): a real `AuthModel` and `AuthSession` on fakes, so
/// `RootView` and `AuthGate` run as in the app, without the Keychain, Cognito or the web sheet.
enum UITestAuth {
    /// A stage configuration of the dev shape with made-up ids. Only `RootView`'s check for a
    /// configured stage and the hosted UI's URLs use it; nothing is ever sent to it.
    static func stageConfig() -> StageConfig? {
        try? StageConfig(info: [
            StageConfig.InfoKey.stage.rawValue: "dev",
            StageConfig.InfoKey.hostedDomain.rawValue: "https://cupmark-dev.auth.eu-central-1.amazoncognito.com",
            StageConfig.InfoKey.appClientID.rawValue: "uitestclient",
            StageConfig.InfoKey.apiURL.rawValue: "https://uitest0000.execute-api.eu-central-1.amazonaws.com",
            StageConfig.InfoKey.redirectURL.rawValue: StageConfig.redirectURLString,
            StageConfig.InfoKey.signOutURL.rawValue: StageConfig.signOutURLString,
        ])
    }

    /// Signed in as `account`, or signed out for nil. Signing in again is cancelled at once.
    static func model(config: StageConfig, signedInAs account: AccountID?) -> AuthModel {
        let credential = account.map { StoredCredential(refreshToken: "ui-test-refresh-token", accountID: $0) }
        let session = AuthSession(endpoint: UITestTokenEndpoint(), store: UITestCredentialStore(credential))
        return AuthModel(hostedUI: HostedUI(config: config), session: session, authenticator: UITestWebAuthenticator())
    }
}

/// The saved sign-in, in memory.
final class UITestCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var credential: StoredCredential?

    init(_ credential: StoredCredential?) {
        self.credential = credential
    }

    func load() throws -> StoredCredential? {
        lock.withLock { credential }
    }

    func save(_ credential: StoredCredential) throws {
        lock.withLock { self.credential = credential }
    }

    func delete() throws {
        lock.withLock { credential = nil }
    }
}

/// Cognito's token endpoint, refusing every exchange and refresh. Signing out revokes nothing.
struct UITestTokenEndpoint: TokenEndpoint {
    func exchange(code: String, verifier: String) async throws -> TokenResponse {
        throw AuthError.authorizationFailed
    }

    func refresh(refreshToken: String) async throws -> TokenResponse {
        throw AuthError.invalidResponse
    }

    func revoke(refreshToken: String) async throws {}
}

/// The web sheet, closed by the user before it opens.
struct UITestWebAuthenticator: WebAuthenticator {
    @MainActor
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        throw AuthError.cancelled
    }
}
#endif
