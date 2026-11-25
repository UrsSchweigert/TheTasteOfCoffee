import Foundation

/// The Cognito hosted UI endpoints and settings of one stage (infra/src/identity.ts): the
/// public app client, the `openid` scope, Sign in with Apple as the only provider and the
/// `cupmark://auth` callback.
struct HostedUI: Equatable, Sendable {
    /// Cognito's name of the Apple provider (infra/src/identity.ts, `APPLE_PROVIDER_NAME`).
    static let identityProvider = "SignInWithApple"
    /// The only scope of the app client. No `email` or `profile`: the app reads no name and
    /// no email.
    static let scope = "openid"

    /// `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com`, no trailing slash.
    let domain: URL
    let clientID: String
    /// `cupmark://auth`.
    let redirectURL: URL
    /// `cupmark`, the scheme `ASWebAuthenticationSession` waits for.
    let callbackScheme: String

    init(domain: URL, clientID: String, redirectURL: URL, callbackScheme: String) {
        self.domain = domain
        self.clientID = clientID
        self.redirectURL = redirectURL
        self.callbackScheme = callbackScheme
    }

    init(config: StageConfig) {
        self.init(
            domain: config.hostedDomain,
            clientID: config.appClientID,
            redirectURL: config.redirectURL,
            callbackScheme: StageConfig.callbackScheme
        )
    }

    var authorizeURL: URL { domain.appending(path: "oauth2/authorize") }
    var tokenURL: URL { domain.appending(path: "oauth2/token") }
    var revokeURL: URL { domain.appending(path: "oauth2/revoke") }
}

/// One authorization request: the URL to open, and the `state` and PKCE verifier to check
/// the callback and redeem the code with. Kept in memory for the length of one sign-in only.
struct AuthorizationRequest: Equatable, Sendable {
    let url: URL
    let state: String
    let pkce: PKCE

    /// `/oauth2/authorize` with `identity_provider=SignInWithApple`, so the hosted UI goes
    /// straight to Apple and shows no page of its own.
    init(hostedUI: HostedUI, state: String, pkce: PKCE) throws {
        let parameters: [(String, String)] = [
            ("response_type", "code"),
            ("client_id", hostedUI.clientID),
            ("redirect_uri", hostedUI.redirectURL.absoluteString),
            ("identity_provider", HostedUI.identityProvider),
            ("scope", HostedUI.scope),
            ("state", state),
            ("code_challenge", pkce.challenge),
            ("code_challenge_method", PKCE.method),
        ]
        guard var components = URLComponents(url: hostedUI.authorizeURL, resolvingAgainstBaseURL: false) else {
            throw AuthError.couldNotStart
        }
        components.percentEncodedQuery = FormEncoding.encode(parameters)
        guard let url = components.url else {
            throw AuthError.couldNotStart
        }
        self.url = url
        self.state = state
        self.pkce = pkce
    }

    /// A request with a fresh random `state` and PKCE pair.
    static func make(hostedUI: HostedUI) throws -> AuthorizationRequest {
        try AuthorizationRequest(hostedUI: hostedUI, state: SecureRandom.state(), pkce: PKCE.generate())
    }

    /// The authorization code of the callback `url`, after checking that it is the redirect
    /// URL and carries this request's `state`.
    ///
    /// Order: wrong URL, then `state` (so a forged callback is always `stateMismatch`, also
    /// when it carries an error), then an OAuth `error`, then the code.
    func code(fromCallback url: URL, redirectURL: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let expected = URLComponents(url: redirectURL, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == expected.scheme?.lowercased(),
              components.host?.lowercased() == expected.host?.lowercased(),
              components.path == expected.path else {
            throw AuthError.unexpectedCallback
        }
        let items = components.queryItems ?? []
        func single(_ name: String) -> String? {
            let values = items.filter { $0.name == name }
            guard values.count == 1 else {
                return nil
            }
            return values[0].value
        }
        guard let returnedState = single("state"), returnedState == state else {
            throw AuthError.stateMismatch
        }
        if items.contains(where: { $0.name == "error" }) {
            throw AuthError.authorizationFailed
        }
        guard let code = single("code"), AuthorizationRequest.isPlausibleCode(code) else {
            throw AuthError.missingCode
        }
        return code
    }

    /// Cognito codes are short URL-safe strings. Anything else is not sent to the token endpoint.
    static func isPlausibleCode(_ code: String) -> Bool {
        (1...2048).contains(code.utf8.count) && code.utf8.allSatisfy(FormEncoding.isUnreserved)
    }
}

/// `application/x-www-form-urlencoded` for the few fixed parameters the app sends. Every byte
/// but the RFC 3986 unreserved set is percent-encoded, so `cupmark://auth` becomes
/// `cupmark%3A%2F%2Fauth` and no value can break out of its pair.
enum FormEncoding {
    static func encode(_ parameters: [(String, String)]) -> String {
        parameters
            .map { "\(escape($0.0))=\(escape($0.1))" }
            .joined(separator: "&")
    }

    static func escape(_ value: String) -> String {
        var result = ""
        for byte in value.utf8 {
            if isUnreserved(byte) {
                result.append(Character(Unicode.Scalar(byte)))
            } else {
                result += String(format: "%%%02X", byte)
            }
        }
        return result
    }

    static func isUnreserved(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~"):
            return true
        default:
            return false
        }
    }
}
