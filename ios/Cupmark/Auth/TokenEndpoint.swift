import Foundation

/// The answer of `/oauth2/token`. Tokens are opaque here except for the id token's `sub`,
/// which `AccountID` reads on the device.
struct TokenResponse: Decodable, Equatable, Sendable {
    let accessToken: String
    let idToken: String
    /// Sent on the code exchange. A refresh answer has none unless Cognito rotates it.
    let refreshToken: String?
    /// Seconds the access and id tokens are valid (60 minutes, infra/src/identity.ts).
    let expiresIn: Int

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case idToken = "id_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case tokenType = "token_type"
    }

    init(accessToken: String, idToken: String, refreshToken: String?, expiresIn: Int) {
        self.accessToken = accessToken
        self.idToken = idToken
        self.refreshToken = refreshToken
        self.expiresIn = expiresIn
    }

    /// Rejects a response without a Bearer token type, with an empty token or with a lifetime
    /// that is not positive. The error names the field only.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tokenType = try container.decode(String.self, forKey: .tokenType)
        guard tokenType.caseInsensitiveCompare("Bearer") == .orderedSame else {
            throw DecodingError.dataCorruptedError(forKey: .tokenType, in: container, debugDescription: "not Bearer")
        }
        accessToken = try container.decode(String.self, forKey: .accessToken)
        idToken = try container.decode(String.self, forKey: .idToken)
        refreshToken = try container.decodeIfPresent(String.self, forKey: .refreshToken)
        expiresIn = try container.decode(Int.self, forKey: .expiresIn)
        guard !accessToken.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .accessToken, in: container, debugDescription: "empty")
        }
        guard !idToken.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .idToken, in: container, debugDescription: "empty")
        }
        if let refreshToken, refreshToken.isEmpty {
            throw DecodingError.dataCorruptedError(forKey: .refreshToken, in: container, debugDescription: "empty")
        }
        guard expiresIn > 0 else {
            throw DecodingError.dataCorruptedError(forKey: .expiresIn, in: container, debugDescription: "not positive")
        }
    }
}

/// Cognito's token and revocation endpoints. A protocol, so `AuthSession` is tested without
/// a network.
protocol TokenEndpoint: Sendable {
    /// `grant_type=authorization_code` with the PKCE verifier.
    func exchange(code: String, verifier: String) async throws -> TokenResponse
    /// `grant_type=refresh_token`.
    func refresh(refreshToken: String) async throws -> TokenResponse
    /// `/oauth2/revoke`: ends the refresh token and the tokens issued from it.
    func revoke(refreshToken: String) async throws
}

/// `TokenEndpoint` over HTTPS with `URLSession`.
///
/// - Bodies are `application/x-www-form-urlencoded`. The client is public: no client secret
///   and no `Authorization` header are sent, only `client_id` (and the PKCE verifier).
/// - Only an error body's OAuth `error` code is read, to tell `invalid_grant` from other
///   failures; nothing else of it is kept. Nothing is logged.
/// - A network failure is `APIError.transport`, a cancelled task `CancellationError`.
final class CognitoTokenEndpoint: TokenEndpoint {
    private let hostedUI: HostedUI
    private let session: URLSession

    init(hostedUI: HostedUI, session: URLSession = APIClient.makeSession()) {
        self.hostedUI = hostedUI
        self.session = session
    }

    func exchange(code: String, verifier: String) async throws -> TokenResponse {
        guard AuthorizationRequest.isPlausibleCode(code) else {
            throw AuthError.missingCode
        }
        let data = try await post(hostedUI.tokenURL, [
            ("grant_type", "authorization_code"),
            ("client_id", hostedUI.clientID),
            ("code", code),
            ("redirect_uri", hostedUI.redirectURL.absoluteString),
            ("code_verifier", verifier),
        ])
        return try decode(data)
    }

    func refresh(refreshToken: String) async throws -> TokenResponse {
        let data = try await post(hostedUI.tokenURL, [
            ("grant_type", "refresh_token"),
            ("client_id", hostedUI.clientID),
            ("refresh_token", refreshToken),
        ])
        return try decode(data)
    }

    func revoke(refreshToken: String) async throws {
        _ = try await post(hostedUI.revokeURL, [
            ("token", refreshToken),
            ("client_id", hostedUI.clientID),
        ])
    }

    // MARK: - Requests

    private struct OAuthErrorBody: Decodable {
        let error: String?
    }

    /// Sends the form and returns the body of a 200. Any other status throws.
    private func post(_ url: URL, _ parameters: [(String, String)]) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(FormEncoding.encode(parameters).utf8)
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            throw APIError.transport((error as? URLError)?.code ?? .unknown)
        }
        guard let http = result.1 as? HTTPURLResponse else {
            throw AuthError.invalidResponse
        }
        guard http.statusCode == 200 else {
            if http.statusCode == 400,
               let body = try? JSONDecoder().decode(OAuthErrorBody.self, from: result.0),
               body.error == "invalid_grant" {
                throw AuthError.invalidGrant
            }
            throw AuthError.server(status: http.statusCode)
        }
        return result.0
    }

    /// The decoding error is dropped: it could quote a token.
    private func decode(_ data: Data) throws -> TokenResponse {
        do {
            return try JSONDecoder().decode(TokenResponse.self, from: data)
        } catch {
            throw AuthError.invalidResponse
        }
    }
}
