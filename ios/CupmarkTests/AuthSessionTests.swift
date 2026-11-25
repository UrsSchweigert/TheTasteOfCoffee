import Security
import XCTest
@testable import Cupmark

/// `AuthSession`, the token store and `TokenProvider` (M2-T11), with a fake token endpoint
/// and an in-memory credential store.
final class AuthSessionTests: XCTestCase {
    private let account = AccountID(subject: AuthFixtures.subject)

    private var storedCredential: StoredCredential {
        StoredCredential(refreshToken: "refresh-1", accountID: account)
    }

    /// Collects the statuses the session reports.
    private final class StatusLog: @unchecked Sendable {
        private let lock = NSLock()
        private var log: [AuthStatus] = []

        var statuses: [AuthStatus] {
            lock.withLock { log }
        }

        func append(_ status: AuthStatus) {
            lock.withLock { log.append(status) }
        }
    }

    private func makeSession(
        endpoint: FakeTokenEndpoint = FakeTokenEndpoint(),
        store: FakeCredentialStore = FakeCredentialStore(),
        clock: TestClock = TestClock()
    ) async -> (AuthSession, StatusLog) {
        let session = AuthSession(endpoint: endpoint, store: store, now: { clock.now })
        let log = StatusLog()
        await session.setStatusHandler { log.append($0) }
        return (session, log)
    }

    /// Yields until `condition` holds. No clock: a bounded number of turns, then a failure.
    private func waitUntil(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () async -> Bool
    ) async {
        for _ in 0..<100_000 {
            if await condition() {
                return
            }
            await Task.yield()
        }
        XCTFail("never happened: \(what)", file: file, line: line)
    }

    private func assertThrows<T>(
        _ expected: AuthError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> T
    ) async {
        do {
            _ = try await body()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? AuthError, expected, file: file, line: line)
        }
    }

    // MARK: - Sign-in and restore

    func testSignInSavesTheRefreshTokenAndKeepsTheAccessTokenInMemory() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore()
        let (session, log) = await makeSession(endpoint: endpoint, store: store)

        let signedIn = try await session.signIn(code: "code-1", verifier: "verifier-1")
        XCTAssertEqual(signedIn, account)
        XCTAssertEqual(store.credential, storedCredential, "only the refresh token and the account are saved")
        let calls = await endpoint.calls
        XCTAssertEqual(calls, [.exchange(code: "code-1", verifier: "verifier-1")])

        let token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-1")
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 0, "a fresh token is not refreshed")
        XCTAssertEqual(log.statuses, [.signedIn(account)])
    }

    func testASignInWithoutARefreshTokenSavesNothing() async throws {
        let endpoint = FakeTokenEndpoint(exchange: { try AuthFixtures.tokenResponse(refresh: nil) })
        let store = FakeCredentialStore()
        let (session, log) = await makeSession(endpoint: endpoint, store: store)
        await assertThrows(.invalidResponse) {
            try await session.signIn(code: "code-1", verifier: "verifier-1")
        }
        XCTAssertNil(store.credential)
        XCTAssertTrue(log.statuses.isEmpty)
    }

    func testAKeychainFailureFailsTheSignIn() async throws {
        let store = FakeCredentialStore()
        store.failSaves(with: .keychain(errSecNotAvailable))
        let (session, _) = await makeSession(store: store)
        await assertThrows(.keychain(errSecNotAvailable)) {
            try await session.signIn(code: "code-1", verifier: "verifier-1")
        }
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
    }

    func testRestoreReadsTheAccountWithoutANetworkRequest() async throws {
        let endpoint = FakeTokenEndpoint()
        let (session, _) = await makeSession(endpoint: endpoint, store: FakeCredentialStore(storedCredential))
        let status = await session.restore()
        XCTAssertEqual(status, .signedIn(account))
        let calls = await endpoint.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreWithNothingSavedIsSignedOut() async throws {
        let (session, _) = await makeSession()
        let status = await session.restore()
        XCTAssertEqual(status, .signedOut)
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
    }

    // MARK: - Refresh

    func testAfterARestartTheFirstTokenIsRefreshed() async throws {
        let endpoint = FakeTokenEndpoint()
        let (session, _) = await makeSession(endpoint: endpoint, store: FakeCredentialStore(storedCredential))
        let token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-2")
        let calls = await endpoint.calls
        XCTAssertEqual(calls, [.refresh("refresh-1")])
    }

    func testTheTokenIsRefreshedBeforeItExpires() async throws {
        let endpoint = FakeTokenEndpoint()
        let clock = TestClock()
        let (session, _) = await makeSession(endpoint: endpoint, clock: clock)
        try await session.signIn(code: "code-1", verifier: "verifier-1")

        clock.advance(3600 - AuthSession.refreshLeeway - 1)
        var token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-1", "still outside the leeway")
        var refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 0)

        clock.advance(2)
        token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-2", "inside the leeway")
        refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1)

        token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-2")
        refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1, "the refreshed token is used until it nears expiry")
    }

    func testAShortLifetimeIsRefreshedAtHalfOfIt() async throws {
        let endpoint = FakeTokenEndpoint(exchange: { try AuthFixtures.tokenResponse(expiresIn: 60) })
        let clock = TestClock()
        let (session, _) = await makeSession(endpoint: endpoint, clock: clock)
        try await session.signIn(code: "code-1", verifier: "verifier-1")
        clock.advance(29)
        var token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-1")
        clock.advance(2)
        token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-2")
    }

    func testTwoCallersAtOnceShareOneRefresh() async throws {
        let endpoint = FakeTokenEndpoint()
        await endpoint.holdRefreshes()
        let (session, _) = await makeSession(endpoint: endpoint, store: FakeCredentialStore(storedCredential))

        let first = Task { try await session.currentAccessToken() }
        await endpoint.waitUntilARefreshIsHeld()
        let second = Task { try await session.currentAccessToken() }
        await waitUntil("the second caller joins the running refresh") {
            await session.refreshJoinerCount == 1
        }
        await endpoint.releaseRefreshes()

        let tokens = try await [first.value, second.value]
        XCTAssertEqual(tokens, ["access-2", "access-2"])
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testTwoRefreshesAfterA401ShareOneRequest() async throws {
        let endpoint = FakeTokenEndpoint()
        let (session, _) = await makeSession(endpoint: endpoint)
        try await session.signIn(code: "code-1", verifier: "verifier-1")
        await endpoint.holdRefreshes()

        let first = Task { try await session.refresh() }
        await endpoint.waitUntilARefreshIsHeld()
        let second = Task { try await session.refresh() }
        await waitUntil("the second refresh joins the first") {
            await session.refreshJoinerCount == 1
        }
        await endpoint.releaseRefreshes()

        try await first.value
        try await second.value
        let token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-2")
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testACallerDuringARefreshWaitsForItInsteadOfTakingTheRejectedToken() async throws {
        let endpoint = FakeTokenEndpoint()
        let (session, _) = await makeSession(endpoint: endpoint)
        try await session.signIn(code: "code-1", verifier: "verifier-1")
        await endpoint.holdRefreshes()

        let refreshing = Task { try await session.refresh() }
        await endpoint.waitUntilARefreshIsHeld()
        // The access token in memory is still fresh, but a refresh is running: wait for it.
        let caller = Task { try await session.currentAccessToken() }
        await waitUntil("the caller waits for the running refresh") {
            await session.refreshJoinerCount == 1
        }
        await endpoint.releaseRefreshes()

        let token = try await caller.value
        try await refreshing.value
        XCTAssertEqual(token, "access-2")
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testAFailedRefreshIsTriedAgainNextTime() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { throw APIError.transport(.notConnectedToInternet) })
        let store = FakeCredentialStore(storedCredential)
        let (session, log) = await makeSession(endpoint: endpoint, store: store)
        do {
            _ = try await session.currentAccessToken()
            XCTFail("expected transport")
        } catch {
            XCTAssertEqual(error as? APIError, .transport(.notConnectedToInternet))
        }
        XCTAssertEqual(store.credential, storedCredential, "offline keeps the sign-in")
        XCTAssertTrue(log.statuses.isEmpty)

        await endpoint.setRefresh { try AuthFixtures.tokenResponse(access: "access-3", refresh: nil) }
        let token = try await session.currentAccessToken()
        XCTAssertEqual(token, "access-3")
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 2)
    }

    func testOfflineIsTransportForTheAPIClientNotUnauthorized() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { throw APIError.transport(.notConnectedToInternet) })
        let (session, _) = await makeSession(endpoint: endpoint, store: FakeCredentialStore(storedCredential))
        let server = try StubServer { _ in StubResponse(status: 200) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: session, session: server.makeSession(), imageCache: nil)
        do {
            _ = try await client.getProfile()
            XCTFail("expected transport")
        } catch {
            XCTAssertEqual(error as? APIError, .transport(.notConnectedToInternet))
        }
        XCTAssertTrue(server.requests.isEmpty)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.notSignedIn), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.sessionExpired), .unauthorized)
    }

    func testARotatedRefreshTokenIsSaved() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { try AuthFixtures.tokenResponse(access: "access-2", refresh: "refresh-2") })
        let store = FakeCredentialStore(storedCredential)
        let (session, _) = await makeSession(endpoint: endpoint, store: store)
        _ = try await session.currentAccessToken()
        XCTAssertEqual(store.credential?.refreshToken, "refresh-2")
        XCTAssertEqual(store.credential?.accountID, account)
    }

    func testAnExpiredRefreshTokenEndsTheSession() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { throw AuthError.invalidGrant })
        let store = FakeCredentialStore(storedCredential)
        let (session, log) = await makeSession(endpoint: endpoint, store: store)
        await assertThrows(.sessionExpired) {
            try await session.currentAccessToken()
        }
        XCTAssertNil(store.credential, "the Keychain is cleared")
        XCTAssertEqual(log.statuses, [.sessionExpired])
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
        let refreshCount = await endpoint.refreshCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testARefreshForAnotherUserEndsTheSession() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { try AuthFixtures.tokenResponse(subject: AuthFixtures.otherSubject, refresh: nil) })
        let store = FakeCredentialStore(storedCredential)
        let (session, log) = await makeSession(endpoint: endpoint, store: store)
        await assertThrows(.accountMismatch) {
            try await session.currentAccessToken()
        }
        XCTAssertNil(store.credential)
        XCTAssertEqual(log.statuses, [.sessionExpired])
    }

    // MARK: - Sign-out

    func testSignOutRevokesTheRefreshTokenAndClearsEverything() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore()
        let (session, log) = await makeSession(endpoint: endpoint, store: store)
        try await session.signIn(code: "code-1", verifier: "verifier-1")

        await session.signOut()
        let calls = await endpoint.calls
        XCTAssertEqual(calls.last, .revoke("refresh-1"))
        XCTAssertNil(store.credential, "the Keychain is cleared")
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
        XCTAssertEqual(log.statuses, [.signedIn(account), .signedOut])
        let status = await session.restore()
        XCTAssertEqual(status, .signedOut)
    }

    func testAFailedRevokeStillSignsOutLocally() async throws {
        let endpoint = FakeTokenEndpoint()
        await endpoint.setRevokeError(APIError.transport(.notConnectedToInternet))
        let store = FakeCredentialStore(storedCredential)
        let (session, log) = await makeSession(endpoint: endpoint, store: store)

        await session.signOut()
        let calls = await endpoint.calls
        XCTAssertEqual(calls, [.revoke("refresh-1")])
        XCTAssertNil(store.credential)
        XCTAssertEqual(log.statuses, [.signedOut])
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
    }

    func testARefreshThatEndsAfterSignOutIsDropped() async throws {
        let endpoint = FakeTokenEndpoint()
        await endpoint.holdRefreshes()
        let store = FakeCredentialStore(storedCredential)
        let (session, log) = await makeSession(endpoint: endpoint, store: store)

        let pending = Task { try await session.currentAccessToken() }
        // The refresh is in flight at Cognito when the user signs out.
        await endpoint.waitUntilARefreshIsHeld()
        await session.signOut()
        XCTAssertNil(store.credential)
        await endpoint.releaseRefreshes()

        do {
            _ = try await pending.value
            XCTFail("expected notSignedIn")
        } catch {
            XCTAssertEqual(error as? AuthError, .notSignedIn)
        }
        XCTAssertNil(store.credential, "the late answer does not sign the user back in")
        XCTAssertEqual(log.statuses, [.signedOut])
        let calls = await endpoint.calls
        XCTAssertEqual(calls, [.refresh("refresh-1"), .revoke("refresh-1")])
        await assertThrows(.notSignedIn) {
            try await session.currentAccessToken()
        }
    }

    // MARK: - Token failures as API errors

    func testCognitoFailuresDuringARefreshAreRetryableForTheAPIClient() async throws {
        let cases: [(any Error, APIError)] = [
            (AuthError.server(status: 500), .serviceUnavailable),
            (AuthError.server(status: 503), .serviceUnavailable),
            (AuthError.invalidResponse, .serviceUnavailable),
            (AuthError.server(status: 429), .tooManyRequests),
        ]
        for (thrown, expected) in cases {
            let endpoint = FakeTokenEndpoint(refresh: { throw thrown })
            let store = FakeCredentialStore(storedCredential)
            let (session, log) = await makeSession(endpoint: endpoint, store: store)
            let server = try StubServer { _ in StubResponse(status: 200) }
            let client = APIClient(baseURL: server.baseURL, tokenProvider: session, session: server.makeSession(), imageCache: nil)
            do {
                _ = try await client.getProfile()
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? APIError, expected, "\(thrown)")
            }
            XCTAssertEqual(store.credential, storedCredential, "\(thrown) keeps the sign-in")
            XCTAssertTrue(log.statuses.isEmpty)
            XCTAssertTrue(server.requests.isEmpty)
        }
    }

    func testOnlySignInAgainFailuresAreUnauthorized() {
        XCTAssertEqual(APIClient.tokenFailure(AuthError.sessionExpired), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.notSignedIn), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.accountMismatch), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.invalidGrant), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.server(status: 400)), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.keychain(-1)), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(URLError(.userAuthenticationRequired)), .unauthorized)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.server(status: 502)), .serviceUnavailable)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.server(status: 429)), .tooManyRequests)
        XCTAssertEqual(APIClient.tokenFailure(AuthError.invalidResponse), .serviceUnavailable)
        XCTAssertEqual(APIClient.tokenFailure(APIError.transport(.timedOut)), .transport(.timedOut))
    }

    func testAnExpiredSessionIsUnauthorizedForTheAPIClient() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { throw AuthError.invalidGrant })
        let (session, _) = await makeSession(endpoint: endpoint, store: FakeCredentialStore(storedCredential))
        let server = try StubServer { _ in StubResponse(status: 200) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: session, session: server.makeSession(), imageCache: nil)
        do {
            _ = try await client.getProfile()
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertTrue(server.requests.isEmpty)
    }
}
