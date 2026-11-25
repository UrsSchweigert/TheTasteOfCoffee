import XCTest
@testable import Cupmark

/// `CognitoTokenEndpoint` against a `URLProtocol` stub: the form bodies of the code exchange,
/// the refresh and the revoke, no client secret, token response decoding and the errors.
final class TokenEndpointTests: XCTestCase {
    /// The stub registry holds servers weakly; the test keeps them alive.
    private var servers: [StubServer] = []

    private func makeEndpoint(_ handler: @escaping StubServer.Handler) throws -> (CognitoTokenEndpoint, StubServer) {
        let server = try StubServer(handler: handler)
        servers.append(server)
        let endpoint = CognitoTokenEndpoint(hostedUI: try AuthFixtures.hostedUI(domain: server.baseURL), session: server.makeSession())
        return (endpoint, server)
    }

    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private func tokenBody(refresh: String? = "refresh-1", tokenType: String = "Bearer", expiresIn: Int = 3600) throws -> Data {
        var body: [String: Any] = [
            "access_token": "access-1",
            "id_token": try AuthFixtures.idToken(),
            "token_type": tokenType,
            "expires_in": expiresIn,
        ]
        if let refresh {
            body["refresh_token"] = refresh
        }
        return try json(body)
    }

    private func assertFormRequest(_ request: RecordedRequest, path: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(request.method, "POST", file: file, line: line)
        XCTAssertEqual(request.path, path, file: file, line: line)
        XCTAssertEqual(request.header("Content-Type"), "application/x-www-form-urlencoded", file: file, line: line)
        XCTAssertNil(request.header("Authorization"), "a public client sends no credentials", file: file, line: line)
        XCTAssertTrue(request.queryItems.isEmpty, "nothing goes in the query", file: file, line: line)
        XCTAssertNil(AuthFixtures.formDictionary(request.body)["client_secret"], file: file, line: line)
    }

    // MARK: - Requests

    func testTheCodeIsExchangedWithTheVerifierAndNoSecret() async throws {
        let body = try tokenBody()
        let (endpoint, server) = try makeEndpoint { _ in StubResponse(status: 200, body: body) }
        let response = try await endpoint.exchange(code: "code-1", verifier: "verifier-1")

        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(server.requests.count, 1)
        assertFormRequest(request, path: "/oauth2/token")
        XCTAssertEqual(AuthFixtures.formDictionary(request.body), [
            "grant_type": "authorization_code",
            "client_id": AuthFixtures.clientID,
            "code": "code-1",
            "redirect_uri": "cupmark://auth",
            "code_verifier": "verifier-1",
        ])
        XCTAssertTrue(String(decoding: request.body ?? Data(), as: UTF8.self).contains("redirect_uri=cupmark%3A%2F%2Fauth"))
        XCTAssertEqual(response, try AuthFixtures.tokenResponse())
    }

    func testAnImplausibleCodeIsNotSent() async throws {
        let (endpoint, server) = try makeEndpoint { _ in StubResponse(status: 500) }
        do {
            _ = try await endpoint.exchange(code: "a b", verifier: "verifier-1")
            XCTFail("expected missingCode")
        } catch {
            XCTAssertEqual(error as? AuthError, .missingCode)
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testARefreshSendsTheRefreshToken() async throws {
        let body = try tokenBody(refresh: nil)
        let (endpoint, server) = try makeEndpoint { _ in StubResponse(status: 200, body: body) }
        let response = try await endpoint.refresh(refreshToken: "refresh-1")

        let request = try XCTUnwrap(server.requests.first)
        assertFormRequest(request, path: "/oauth2/token")
        XCTAssertEqual(AuthFixtures.formDictionary(request.body), [
            "grant_type": "refresh_token",
            "client_id": AuthFixtures.clientID,
            "refresh_token": "refresh-1",
        ])
        XCTAssertNil(response.refreshToken)
        XCTAssertEqual(response.accessToken, "access-1")
        XCTAssertEqual(response.expiresIn, 3600)
    }

    func testRevokeSendsTheRefreshToken() async throws {
        let (endpoint, server) = try makeEndpoint { _ in StubResponse(status: 200) }
        try await endpoint.revoke(refreshToken: "refresh-1")

        let request = try XCTUnwrap(server.requests.first)
        assertFormRequest(request, path: "/oauth2/revoke")
        XCTAssertEqual(AuthFixtures.formDictionary(request.body), [
            "token": "refresh-1",
            "client_id": AuthFixtures.clientID,
        ])
    }

    // MARK: - Errors

    func testInvalidGrantIsTyped() async throws {
        let body = try json(["error": "invalid_grant"])
        let (endpoint, _) = try makeEndpoint { _ in StubResponse(status: 400, body: body) }
        do {
            _ = try await endpoint.refresh(refreshToken: "refresh-1")
            XCTFail("expected invalidGrant")
        } catch {
            XCTAssertEqual(error as? AuthError, .invalidGrant)
        }
    }

    func testOtherStatusesAreServerErrors() async throws {
        let body = try json(["error": "invalid_request"])
        for status in [400, 401, 500, 503] {
            let (endpoint, _) = try makeEndpoint { _ in StubResponse(status: status, body: body) }
            do {
                _ = try await endpoint.refresh(refreshToken: "refresh-1")
                XCTFail("expected server(\(status))")
            } catch {
                XCTAssertEqual(error as? AuthError, .server(status: status))
            }
        }
    }

    func testANetworkFailureIsTransport() async throws {
        let (endpoint, _) = try makeEndpoint { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await endpoint.refresh(refreshToken: "refresh-1")
            XCTFail("expected transport")
        } catch {
            XCTAssertEqual(error as? APIError, .transport(.notConnectedToInternet))
        }
    }

    // MARK: - Decoding

    func testTokenResponseDecoding() throws {
        let decoded = try JSONDecoder().decode(TokenResponse.self, from: tokenBody())
        XCTAssertEqual(decoded, try AuthFixtures.tokenResponse())
        // Cognito writes "Bearer"; the type is case-insensitive.
        XCTAssertNoThrow(try JSONDecoder().decode(TokenResponse.self, from: tokenBody(tokenType: "bearer")))
        XCTAssertNil(try JSONDecoder().decode(TokenResponse.self, from: tokenBody(refresh: nil)).refreshToken)
    }

    func testMalformedTokenResponsesAreRejected() async throws {
        let idToken = try AuthFixtures.idToken()
        let bodies: [Data] = [
            try tokenBody(tokenType: "MAC"),
            try tokenBody(expiresIn: 0),
            try tokenBody(refresh: ""),
            try json(["access_token": "a", "token_type": "Bearer", "expires_in": 3600]),
            try json(["id_token": idToken, "token_type": "Bearer", "expires_in": 3600]),
            try json(["access_token": "", "id_token": idToken, "token_type": "Bearer", "expires_in": 3600]),
            try json(["access_token": "a", "id_token": idToken, "expires_in": 3600]),
            Data("not json".utf8),
        ]
        for body in bodies {
            XCTAssertThrowsError(try JSONDecoder().decode(TokenResponse.self, from: body))
            let (endpoint, _) = try makeEndpoint { _ in StubResponse(status: 200, body: body) }
            do {
                _ = try await endpoint.refresh(refreshToken: "refresh-1")
                XCTFail("expected invalidResponse")
            } catch {
                XCTAssertEqual(error as? AuthError, .invalidResponse)
            }
        }
    }
}
