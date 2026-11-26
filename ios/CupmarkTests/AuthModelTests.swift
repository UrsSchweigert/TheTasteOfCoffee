import XCTest
@testable import Cupmark

/// `AuthModel`, the sign-in flow behind the Sign in with Apple button (M2-T11), with a fake
/// web sheet, a fake token endpoint and an in-memory credential store.
@MainActor
final class AuthModelTests: XCTestCase {
    private let account = AccountID(subject: AuthFixtures.subject)

    private func makeModel(
        respond: @escaping (URL) throws -> URL = FakeWebAuthenticator.returningCode("code-1"),
        endpoint: FakeTokenEndpoint = FakeTokenEndpoint(),
        store: FakeCredentialStore = FakeCredentialStore()
    ) throws -> (AuthModel, FakeWebAuthenticator) {
        let authenticator = FakeWebAuthenticator(respond: respond)
        let model = AuthModel(
            hostedUI: try AuthFixtures.devHostedUI(),
            session: AuthSession(endpoint: endpoint, store: store),
            authenticator: authenticator
        )
        return (model, authenticator)
    }

    /// Lets the status handler's main-actor hop run.
    private func settle() async {
        for _ in 0..<20 {
            await Task.yield()
        }
    }

    func testSignInOpensTheAuthorizeURLAndRedeemsTheCodeWithItsVerifier() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore()
        let (model, authenticator) = try makeModel(endpoint: endpoint, store: store)
        await model.start()
        XCTAssertEqual(model.phase, .signedOut)

        await model.signIn()
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertEqual(model.accountID, account)
        XCTAssertNil(model.failure)

        let url = try XCTUnwrap(authenticator.urls.first)
        XCTAssertEqual(authenticator.urls.count, 1)
        XCTAssertEqual(authenticator.schemes, ["cupmark"])
        XCTAssertEqual(url.host(), "cupmark-dev.auth.eu-central-1.amazoncognito.com")
        XCTAssertEqual(FakeWebAuthenticator.parameter("identity_provider", of: url), "SignInWithApple")
        let challenge = try XCTUnwrap(FakeWebAuthenticator.parameter("code_challenge", of: url))
        let calls = await endpoint.calls
        guard case .exchange(let code, let verifier) = try XCTUnwrap(calls.first) else {
            return XCTFail("expected a code exchange, got \(calls)")
        }
        XCTAssertEqual(code, "code-1")
        XCTAssertEqual(PKCE.challenge(for: verifier), challenge, "the verifier belongs to the challenge sent")
        XCTAssertEqual(store.credential?.accountID, account)
    }

    func testACancelledSignInIsNotAFailure() async throws {
        let endpoint = FakeTokenEndpoint()
        let (model, _) = try makeModel(respond: { _ in throw AuthError.cancelled }, endpoint: endpoint)
        await model.start()
        await model.signIn()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.failure)
        let calls = await endpoint.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testACallbackWithAnotherStateIsRejected() async throws {
        let endpoint = FakeTokenEndpoint()
        let forged: (URL) throws -> URL = { _ in try XCTUnwrap(URL(string: "cupmark://auth?code=code-1&state=forged")) }
        let (model, _) = try makeModel(respond: forged, endpoint: endpoint)
        await model.start()
        await model.signIn()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.failure, .signInFailed)
        let calls = await endpoint.calls
        XCTAssertTrue(calls.isEmpty, "a forged callback's code is never redeemed")
    }

    func testACallbackWithoutACodeIsRejected() async throws {
        let endpoint = FakeTokenEndpoint()
        let noCode: (URL) throws -> URL = { url in
            let state = try XCTUnwrap(FakeWebAuthenticator.parameter("state", of: url))
            return try XCTUnwrap(URL(string: "cupmark://auth?state=\(FormEncoding.escape(state))"))
        }
        let (model, _) = try makeModel(respond: noCode, endpoint: endpoint)
        await model.start()
        await model.signIn()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.failure, .signInFailed)
        let calls = await endpoint.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testAnOfflineCodeExchangeSaysSo() async throws {
        let endpoint = FakeTokenEndpoint(exchange: { throw APIError.transport(.notConnectedToInternet) })
        let (model, _) = try makeModel(endpoint: endpoint)
        await model.start()
        await model.signIn()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.failure, .offline)
    }

    func testStartRestoresTheSavedAccount() async throws {
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, authenticator) = try makeModel(store: store)
        XCTAssertEqual(model.phase, .restoring)
        await model.start()
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertTrue(authenticator.urls.isEmpty)
    }

    func testSignOutReturnsToTheSignInScreen() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore()
        let (model, _) = try makeModel(endpoint: endpoint, store: store)
        await model.start()
        await model.signIn()
        await model.signOut()
        await settle()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.accountID)
        XCTAssertNil(store.credential)
        let calls = await endpoint.calls
        XCTAssertEqual(calls.last, .revoke("refresh-1"))
    }

    func testAnExpiredSessionShowsTheSignInScreenWithANote() async throws {
        let endpoint = FakeTokenEndpoint(refresh: { throw AuthError.invalidGrant })
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, _) = try makeModel(endpoint: endpoint, store: store)
        await model.start()
        XCTAssertEqual(model.phase, .signedIn(account))

        _ = try? await model.session.currentAccessToken()
        await settle()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.failure, .sessionExpired)
    }

    // MARK: - Sign-in required by the server, and signing in again (M2-T31)

    func testASignOutAfterTheServerRefusedTheSessionSaysTheAccountWasDeletedOrItsSessionEnded() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, _) = try makeModel(endpoint: endpoint, store: store)
        await model.start()

        await model.signOutAfterServerRefusal(of: account)
        await settle()

        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.failure, .signInRequired)
        XCTAssertEqual(model.failure?.isProblem, true)
        XCTAssertNil(store.credential)

        await model.signIn()
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertNil(model.failure, "a new sign-in clears the note")
    }

    func testAServerRefusalForAnotherAccountOrAnEndedSessionChangesNothing() async throws {
        let endpoint = FakeTokenEndpoint()
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, _) = try makeModel(endpoint: endpoint, store: store)
        await model.start()

        await model.signOutAfterServerRefusal(of: AccountID(subject: AuthFixtures.otherSubject))
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertNil(model.failure)
        let calls = await endpoint.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testAPlainSignOutShowsNoNoteAndTheDeletionNoteIsNotAProblem() async throws {
        let (model, _) = try makeModel(store: FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account)))
        await model.start()
        await model.signOut(reason: .accountDeleted)
        XCTAssertEqual(model.failure, .accountDeleted)
        XCTAssertEqual(model.failure?.isProblem, false)
        await model.signIn()
        await model.signOut()
        XCTAssertNil(model.failure)
    }

    func testSigningInAgainKeepsTheSavedSignInUntilTheNewOneSucceeded() async throws {
        let endpoint = FakeTokenEndpoint(exchange: { try AuthFixtures.tokenResponse(access: "access-9", refresh: "refresh-9") })
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, authenticator) = try makeModel(respond: { _ in throw AuthError.cancelled }, endpoint: endpoint, store: store)
        await model.start()

        let cancelled = await model.signInAgain()
        XCTAssertEqual(cancelled, .cancelled)
        XCTAssertEqual(model.phase, .signedIn(account), "never signed out")
        XCTAssertEqual(store.credential?.refreshToken, "refresh-1")
        XCTAssertFalse(model.isSigningInAgain)

        authenticator.respond = FakeWebAuthenticator.returningCode("code-9")
        let renewed = await model.signInAgain()
        XCTAssertEqual(renewed, .succeeded)
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertEqual(store.credential?.refreshToken, "refresh-9", "the new sign-in replaced the saved one")
        let calls = await endpoint.calls
        XCTAssertFalse(calls.contains(.revoke("refresh-1")), "nothing was revoked")
    }

    func testAFailedSignInAgainSaysWhyAndKeepsTheSession() async throws {
        let store = FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        let (model, _) = try makeModel(respond: { _ in throw APIError.transport(.notConnectedToInternet) }, store: store)
        await model.start()
        let result = await model.signInAgain()
        XCTAssertEqual(result, .failed(.offline))
        XCTAssertEqual(model.phase, .signedIn(account))
        XCTAssertEqual(store.credential?.refreshToken, "refresh-1")
    }

    func testTheOtherAccountNoteIsNotAProblem() {
        XCTAssertFalse(AuthModel.Failure.otherAccountDeleted.isProblem)
        XCTAssertTrue(AuthModel.Failure.signInRequired.isProblem)
    }

    func testSigningInAgainNeedsASignedInSession() async throws {
        let (model, authenticator) = try makeModel()
        await model.start()
        let result = await model.signInAgain()
        XCTAssertEqual(result, .notAvailable)
        XCTAssertTrue(authenticator.urls.isEmpty)
        XCTAssertEqual(model.phase, .signedOut)
    }

    func testFailuresMapToTheirNotes() {
        XCTAssertEqual(AuthModel.failure(for: APIError.transport(.timedOut)), .offline)
        XCTAssertEqual(AuthModel.failure(for: AuthError.invalidGrant), .signInFailed)
        XCTAssertEqual(AuthModel.failure(for: AuthError.keychain(-1)), .signInFailed)
    }
}
