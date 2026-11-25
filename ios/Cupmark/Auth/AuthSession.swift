import Foundation

/// Whether someone is signed in, as `AuthSession` reports it.
enum AuthStatus: Equatable, Sendable {
    case signedOut
    case signedIn(AccountID)
    /// The saved sign-in ended on its own (refresh token expired or revoked). Signed out, and
    /// the sign-in screen says why.
    case sessionExpired
}

/// The token store (M2-T11) and the app's `TokenProvider`.
///
/// - The refresh token and the `AccountID` are saved through `CredentialStore` (the Keychain).
///   The access token lives in this actor's memory only and is gone when the app quits; the
///   id token is read once for its `sub` and then dropped, so it is never kept at all.
/// - `currentAccessToken()` refreshes before expiry: when less than `refreshLeeway` (or half
///   the lifetime, if that is shorter) is left. `APIClient` calls `refresh()` on a 401.
/// - Refreshing is single-flight: while a refresh runs, every caller awaits the same task, so
///   one HTTP request is made however many callers ask at once. A caller's cancellation does
///   not cancel the shared refresh.
/// - `invalid_grant` on a refresh ends the session locally and reports `.sessionExpired`. A
///   network failure keeps the session (`APIError.transport` is thrown), so the app stays
///   signed in offline and the outbox retries later.
actor AuthSession: TokenProvider {
    /// Refresh this long before the access token expires.
    static let refreshLeeway: TimeInterval = 120

    private struct SessionTokens: Sendable {
        let accessToken: String
        /// After this the token is refreshed before use.
        let refreshAt: Date

        init(_ response: TokenResponse, issuedAt: Date) {
            accessToken = response.accessToken
            let lifetime = TimeInterval(response.expiresIn)
            refreshAt = issuedAt.addingTimeInterval(lifetime - min(AuthSession.refreshLeeway, lifetime / 2))
        }
    }

    private let endpoint: any TokenEndpoint
    private let store: any CredentialStore
    private let now: @Sendable () -> Date
    private var credential: StoredCredential?
    private var tokens: SessionTokens?
    private var refreshTask: Task<SessionTokens, any Error>?
    private var statusHandler: (@Sendable (AuthStatus) -> Void)?
    /// Callers waiting on the running refresh without having started it. Read by the tests to
    /// know a second caller has joined; never used for a decision.
    private(set) var refreshJoinerCount = 0

    init(endpoint: any TokenEndpoint, store: any CredentialStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.endpoint = endpoint
        self.store = store
        self.now = now
    }

    /// Called with every change of status made by the session itself: sign-in, sign-out and
    /// an expired session.
    func setStatusHandler(_ handler: (@Sendable (AuthStatus) -> Void)?) {
        statusHandler = handler
    }

    /// The account of the saved sign-in, read from the Keychain without a network request,
    /// so the app opens signed in offline. A Keychain that cannot be read yet (before the
    /// first unlock) is `.signedOut` and is read again on the next call.
    func restore() -> AuthStatus {
        if let credential = loadedCredential() {
            return .signedIn(credential.accountID)
        }
        return .signedOut
    }

    /// Redeems an authorization code and saves the sign-in. Returns the new account.
    @discardableResult
    func signIn(code: String, verifier: String) async throws -> AccountID {
        let issuedAt = now()
        let response = try await endpoint.exchange(code: code, verifier: verifier)
        guard let refreshToken = response.refreshToken else {
            throw AuthError.invalidResponse
        }
        let account = try AccountID(idToken: response.idToken)
        let credential = StoredCredential(refreshToken: refreshToken, accountID: account)
        try store.save(credential)
        refreshTask = nil
        self.credential = credential
        tokens = SessionTokens(response, issuedAt: issuedAt)
        statusHandler?(.signedIn(account))
        return account
    }

    /// Signs out. Memory and the Keychain are cleared first, so the sign-out holds even if
    /// the app is ended during the request; then the refresh token is revoked at
    /// `/oauth2/revoke`. A failed revoke changes nothing locally: the token then simply
    /// expires at Cognito.
    func signOut() async {
        let credential = loadedCredential()
        endSession()
        statusHandler?(.signedOut)
        if let credential {
            try? await endpoint.revoke(refreshToken: credential.refreshToken)
        }
    }

    // MARK: - TokenProvider

    /// The access token in memory while it is fresh. While a refresh runs (for example after
    /// a 401) the caller waits for it instead of getting the token that was just rejected.
    func currentAccessToken() async throws -> String {
        if refreshTask == nil, let tokens, now() < tokens.refreshAt {
            return tokens.accessToken
        }
        return try await refreshedTokens().accessToken
    }

    func refresh() async throws {
        _ = try await refreshedTokens()
    }

    // MARK: - Refresh

    /// The running refresh, or a new one.
    private func refreshedTokens() async throws -> SessionTokens {
        if let running = refreshTask {
            refreshJoinerCount += 1
            defer { refreshJoinerCount -= 1 }
            return try await running.value
        }
        guard let credential = loadedCredential() else {
            throw AuthError.notSignedIn
        }
        let task = Task { try await self.performRefresh(using: credential) }
        refreshTask = task
        let result = await task.result
        if refreshTask == task {
            refreshTask = nil
        }
        return try result.get()
    }

    private func performRefresh(using credential: StoredCredential) async throws -> SessionTokens {
        let issuedAt = now()
        let response: TokenResponse
        do {
            response = try await endpoint.refresh(refreshToken: credential.refreshToken)
        } catch AuthError.invalidGrant {
            if self.credential == credential {
                endSession()
                statusHandler?(.sessionExpired)
            }
            throw AuthError.sessionExpired
        }
        // Signed out, or signed in again, while the request ran: drop the answer.
        guard self.credential == credential else {
            throw AuthError.notSignedIn
        }
        let account = try AccountID(idToken: response.idToken)
        guard account == credential.accountID else {
            endSession()
            statusHandler?(.sessionExpired)
            throw AuthError.accountMismatch
        }
        if let rotated = response.refreshToken, rotated != credential.refreshToken {
            let updated = StoredCredential(refreshToken: rotated, accountID: account)
            self.credential = updated
            // If saving fails, the next launch uses the old token and, if Cognito rejects
            // it, asks to sign in again. The session in memory goes on with the new one.
            try? store.save(updated)
        }
        let tokens = SessionTokens(response, issuedAt: issuedAt)
        self.tokens = tokens
        return tokens
    }

    // MARK: - State

    private func loadedCredential() -> StoredCredential? {
        if credential == nil {
            credential = try? store.load()
        }
        return credential
    }

    /// Forgets every token, in memory and in the Keychain. A running refresh is not cancelled
    /// (its callers would see a cancellation); its answer is dropped when it arrives.
    private func endSession() {
        refreshTask = nil
        tokens = nil
        credential = nil
        try? store.delete()
    }
}
