import XCTest
@testable import Cupmark

/// The authorize URL and the callback checks of the hosted sign-in (M2-T11).
final class HostedUITests: XCTestCase {
    private let pkce = PKCE(verifierBytes: Data(repeating: 7, count: 32))
    private let state = "state-123_abc"

    private func request() throws -> AuthorizationRequest {
        try AuthorizationRequest(hostedUI: AuthFixtures.devHostedUI(), state: state, pkce: pkce)
    }

    private func callback(_ string: String) throws -> URL {
        try XCTUnwrap(URL(string: string))
    }

    private func redirect() throws -> URL {
        try XCTUnwrap(URL(string: "cupmark://auth"))
    }

    private func assertRejected(_ callback: String, _ expected: AuthError, file: StaticString = #filePath, line: UInt = #line) throws {
        let request = try request()
        let url = try self.callback(callback)
        XCTAssertThrowsError(try request.code(fromCallback: url, redirectURL: redirect()), file: file, line: line) { error in
            XCTAssertEqual(error as? AuthError, expected, file: file, line: line)
        }
    }

    // MARK: - Configuration

    func testTheHostedUIComesFromTheStageConfiguration() throws {
        let config = try StageConfig(info: [
            "CupmarkStage": "dev",
            "CupmarkHostedDomain": "https://cupmark-dev.auth.eu-central-1.amazoncognito.com",
            "CupmarkAppClientID": AuthFixtures.clientID,
            "CupmarkAPIURL": "https://abc123defg.execute-api.eu-central-1.amazonaws.com",
            "CupmarkRedirectURL": "cupmark://auth",
            "CupmarkSignOutURL": "cupmark://signout",
        ])
        let hostedUI = HostedUI(config: config)
        XCTAssertEqual(hostedUI, try AuthFixtures.devHostedUI())
        XCTAssertEqual(hostedUI.authorizeURL.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com/oauth2/authorize")
        XCTAssertEqual(hostedUI.tokenURL.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com/oauth2/token")
        XCTAssertEqual(hostedUI.revokeURL.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com/oauth2/revoke")
        XCTAssertEqual(hostedUI.callbackScheme, "cupmark")
    }

    // MARK: - Authorize URL

    func testTheAuthorizeURLHasExactlyTheRequiredParameters() throws {
        let url = try request().url
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "cupmark-dev.auth.eu-central-1.amazoncognito.com")
        XCTAssertEqual(components.path, "/oauth2/authorize")

        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(Set(items.map(\.name)).count, items.count, "a parameter appears twice")
        let parameters = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(parameters, [
            "response_type": "code",
            "client_id": AuthFixtures.clientID,
            "redirect_uri": "cupmark://auth",
            "identity_provider": "SignInWithApple",
            "scope": "openid",
            "state": state,
            "code_challenge": pkce.challenge,
            "code_challenge_method": "S256",
        ])
        // No secret, no verifier, no name or email scope.
        XCTAssertFalse(url.absoluteString.contains(pkce.verifier))
        XCTAssertFalse(url.absoluteString.contains("secret"))
        XCTAssertFalse(url.absoluteString.contains("email"))
    }

    func testTheRedirectURIIsPercentEncoded() throws {
        let query = try XCTUnwrap(URLComponents(url: request().url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
        XCTAssertTrue(query.contains("redirect_uri=cupmark%3A%2F%2Fauth"), query)
    }

    func testEveryRequestHasItsOwnStateAndVerifier() throws {
        let hostedUI = try AuthFixtures.devHostedUI()
        let first = try AuthorizationRequest.make(hostedUI: hostedUI)
        let second = try AuthorizationRequest.make(hostedUI: hostedUI)
        XCTAssertNotEqual(first.state, second.state)
        XCTAssertNotEqual(first.pkce.verifier, second.pkce.verifier)
        XCTAssertEqual(FakeWebAuthenticator.parameter("state", of: first.url), first.state)
        XCTAssertEqual(FakeWebAuthenticator.parameter("code_challenge", of: first.url), first.pkce.challenge)
    }

    // MARK: - Callback

    func testAValidCallbackGivesTheCode() throws {
        let code = try request().code(fromCallback: callback("cupmark://auth?code=abc-123&state=\(state)"), redirectURL: redirect())
        XCTAssertEqual(code, "abc-123")
    }

    func testAStateMismatchIsRejected() throws {
        try assertRejected("cupmark://auth?code=abc&state=other", .stateMismatch)
    }

    func testAMissingStateIsRejected() throws {
        try assertRejected("cupmark://auth?code=abc", .stateMismatch)
    }

    func testARepeatedStateIsRejected() throws {
        try assertRejected("cupmark://auth?code=abc&state=\(state)&state=\(state)", .stateMismatch)
    }

    func testAnErrorWithAForeignStateIsAStateMismatch() throws {
        try assertRejected("cupmark://auth?error=access_denied&state=other", .stateMismatch)
    }

    func testAnOAuthErrorIsRejected() throws {
        try assertRejected("cupmark://auth?error=access_denied&state=\(state)", .authorizationFailed)
    }

    func testAMissingCodeIsRejected() throws {
        try assertRejected("cupmark://auth?state=\(state)", .missingCode)
    }

    func testAnEmptyCodeIsRejected() throws {
        try assertRejected("cupmark://auth?code=&state=\(state)", .missingCode)
    }

    func testACodeWithOtherCharactersIsRejected() throws {
        try assertRejected("cupmark://auth?code=a%20b&state=\(state)", .missingCode)
    }

    func testAnotherURLIsRejected() throws {
        try assertRejected("cupmark://signout?code=abc&state=\(state)", .unexpectedCallback)
        try assertRejected("https://auth?code=abc&state=\(state)", .unexpectedCallback)
        try assertRejected("cupmark://auth/extra?code=abc&state=\(state)", .unexpectedCallback)
    }

    // MARK: - Form encoding

    func testFormEncodingEscapesEverythingButUnreservedCharacters() {
        XCTAssertEqual(FormEncoding.escape("aZ09-._~"), "aZ09-._~")
        XCTAssertEqual(FormEncoding.escape("a b&c=d+e/f:g"), "a%20b%26c%3Dd%2Be%2Ff%3Ag")
        XCTAssertEqual(FormEncoding.escape("ü"), "%C3%BC")
        XCTAssertEqual(FormEncoding.encode([("a", "1"), ("b", "x y")]), "a=1&b=x%20y")
    }
}
