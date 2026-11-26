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
        /// The server refused the session, also after a refresh (M2-T31, from the M2-T16
        /// review): the sync engine, the pull or a screen asked for sign-in. After a refresh
        /// that 401 looks the same for an account deleted on another device (the tombstone of
        /// ADR 0017, Addendum) and for a session that ended, so the note names both.
        case signInRequired
        /// This device deleted the account (M2-T31). Not a problem: the note says it is done.
        case accountDeleted

        var message: LocalizedStringKey {
            switch self {
            case .signInFailed: L10n.signInFailed
            case .offline: L10n.signInOffline
            case .sessionExpired: L10n.signInSessionExpired
            case .signInRequired: L10n.signInRequiredByServer
            case .accountDeleted: L10n.signInAccountDeleted
            }
        }

        /// False for a note that reports something done rather than something wrong.
        var isProblem: Bool {
            self != .accountDeleted
        }
    }

    private(set) var phase: Phase = .restoring
    private(set) var failure: Failure?
    /// True while `signInAgain()` runs.
    private(set) var isSigningInAgain = false

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
    /// Nothing is sent for any account while `deletions` holds an account deletion (M2-T31).
    nonisolated static func live(config: StageConfig, deletions: any AccountDeletionStore) -> AuthModel {
        let hostedUI = HostedUI(config: config)
        let session = AuthSession(
            endpoint: CognitoTokenEndpoint(hostedUI: hostedUI),
            store: KeychainCredentialStore(stage: config.stage),
            isSendingHeld: { deletions.holdsSending }
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
            phase = .signedIn(try await authenticate())
        } catch AuthError.cancelled {
            phase = .signedOut
        } catch {
            phase = .signedOut
            failure = AuthModel.failure(for: error)
        }
    }

    /// Runs the sign-in again while signed in, without signing out first (M2-T31): account
    /// deletion must never sign out or discard tokens before its 204 (ADR 0017), but needs a new
    /// sign-in when the saved one can no longer be refreshed while it is still saved. The new
    /// sign-in replaces the saved one only once it succeeded; a cancelled or failed one leaves
    /// the session as it was. Returns true when it succeeded.
    func signInAgain() async -> Bool {
        guard case .signedIn = phase, !isSigningInAgain else {
            return false
        }
        isSigningInAgain = true
        defer { isSigningInAgain = false }
        do {
            let account = try await authenticate()
            phase = .signedIn(account)
            failure = nil
            return true
        } catch {
            return false
        }
    }

    /// The web sheet with a fresh `state` and PKCE pair, the callback checked, the code redeemed.
    private func authenticate() async throws -> AccountID {
        let request = try makeRequest(hostedUI)
        let callback = try await authenticator.authenticate(url: request.url, callbackScheme: hostedUI.callbackScheme)
        let code = try request.code(fromCallback: callback, redirectURL: hostedUI.redirectURL)
        return try await session.signIn(code: code, verifier: request.pkce.verifier)
    }

    /// The screen turns to sign-in as soon as the session has cleared itself (through the
    /// status handler), without waiting for the revoke request.
    func signOut() async {
        await signOut(reason: nil)
    }

    /// Signs out, and the sign-in screen shows `reason` (nil: no note).
    func signOut(reason: Failure?) async {
        await session.signOut()
        if phase != .signingIn {
            phase = .signedOut
            failure = reason
        }
    }

    /// The server refused `account`'s session, also after a refresh, and sync asked for sign-in
    /// (`SyncHost.signInRequired`, M2-T31): signs out with the note "this account was deleted or
    /// its session ended" (`Failure.signInRequired`). Only while `account` is still the signed-in
    /// one and its session is still saved: a session that ended itself already shows "session
    /// expired", and a sign-out now would replace that note. Nothing local is removed: the
    /// account's store and outbox stay on the device (ADR 0025).
    func signOutAfterServerRefusal(of account: AccountID) async {
        guard accountID == account, await session.isSignedIn(as: account), accountID == account else {
            return
        }
        await signOut(reason: .signInRequired)
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
