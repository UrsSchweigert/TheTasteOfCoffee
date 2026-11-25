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

    func testFailuresMapToTheirNotes() {
        XCTAssertEqual(AuthModel.failure(for: APIError.transport(.timedOut)), .offline)
        XCTAssertEqual(AuthModel.failure(for: AuthError.invalidGrant), .signInFailed)
        XCTAssertEqual(AuthModel.failure(for: AuthError.keychain(-1)), .signInFailed)
    }
}
