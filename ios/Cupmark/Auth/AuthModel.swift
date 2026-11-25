import Observation
import SwiftUI

/// The sign-in state the screens show, and the sign-in and sign-out actions (M2-T11).
///
/// - Sign-in: a fresh `state` and PKCE pair, `/oauth2/authorize` in the web sheet, the
///   callback checked against the `state`, then the code redeemed by `AuthSession`.
/// - `accountID` is the key of the local store (M2-T15). It is nil while signed out.
/// - `session` is the `TokenProvider` to give `APIClient`.
@MainActor
@Observable
final class AuthModel {
    enum Phase: Equatable, Sendable {
        /// Reading the Keychain at launch.
        case restoring
        case signedOut
        /// The web sheet is open or the code is being redeemed.
        case signingIn
        case signedIn(AccountID)
    }

    /// Why the sign-in screen shows a note. A cancelled sign-in is not a failure.
    enum Failure: Equatable, Sendable {
        case signInFailed
        case offline
        case sessionExpired

        var message: LocalizedStringKey {
            switch self {
            case .signInFailed: L10n.signInFailed
            case .offline: L10n.signInOffline
            case .sessionExpired: L10n.signInSessionExpired
            }
        }
    }

    private(set) var phase: Phase = .restoring
    private(set) var failure: Failure?

    /// The app's token provider.
    let session: AuthSession
    private let hostedUI: HostedUI
    private let authenticator: any WebAuthenticator
    private let makeRequest: @Sendable (HostedUI) throws -> AuthorizationRequest
    /// Not shown anywhere, so not observed.
    @ObservationIgnored private var started = false

    /// Nonisolated, so `CupmarkApp.init` can build it whatever its isolation.
    nonisolated init(
        hostedUI: HostedUI,
        session: AuthSession,
        authenticator: any WebAuthenticator,
        makeRequest: @escaping @Sendable (HostedUI) throws -> AuthorizationRequest = { try AuthorizationRequest.make(hostedUI: $0) }
    ) {
        self.hostedUI = hostedUI
        self.session = session
        self.authenticator = authenticator
        self.makeRequest = makeRequest
    }

    /// The model of the built stage: Cognito over HTTPS, the Keychain, the system web sheet.
    nonisolated static func live(config: StageConfig) -> AuthModel {
        let hostedUI = HostedUI(config: config)
        let session = AuthSession(
            endpoint: CognitoTokenEndpoint(hostedUI: hostedUI),
            store: KeychainCredentialStore(stage: config.stage)
        )
        return AuthModel(hostedUI: hostedUI, session: session, authenticator: SystemWebAuthenticator())
    }

    /// The local store key of the signed-in account.
    var accountID: AccountID? {
        if case .signedIn(let account) = phase {
            return account
        }
        return nil
    }

    /// Reads the saved sign-in once and follows the session's later changes, such as an
    /// expired refresh token.
    func start() async {
        guard !started else {
            return
        }
        started = true
        await session.setStatusHandler { [weak self] status in
            Task { @MainActor in
                self?.apply(status)
            }
        }
        apply(await session.restore())
    }

    /// The Sign in with Apple button's action.
    func signIn() async {
        guard phase == .signedOut else {
            return
        }
        phase = .signingIn
        failure = nil
        do {
            let request = try makeRequest(hostedUI)
            let callback = try await authenticator.authenticate(url: request.url, callbackScheme: hostedUI.callbackScheme)
            let code = try request.code(fromCallback: callback, redirectURL: hostedUI.redirectURL)
            let account = try await session.signIn(code: code, verifier: request.pkce.verifier)
            phase = .signedIn(account)
        } catch AuthError.cancelled {
            phase = .signedOut
        } catch {
            phase = .signedOut
            failure = AuthModel.failure(for: error)
        }
    }

    /// The screen turns to sign-in as soon as the session has cleared itself (through the
    /// status handler), without waiting for the revoke request.
    func signOut() async {
        await session.signOut()
        if phase != .signingIn {
            phase = .signedOut
            failure = nil
        }
    }

    static func failure(for error: any Error) -> Failure {
        if let apiError = error as? APIError, case .transport = apiError {
            return .offline
        }
        return .signInFailed
    }

    private func apply(_ status: AuthStatus) {
        switch status {
        case .signedIn(let account):
            phase = .signedIn(account)
            failure = nil
        case .signedOut:
            if phase != .signingIn {
                phase = .signedOut
            }
        case .sessionExpired:
            if phase != .signingIn {
                phase = .signedOut
                failure = .sessionExpired
            }
        }
    }
}
