import Foundation
import XCTest
@testable import Cupmark

/// Made-up Cognito values for the auth tests. None is a real id or token.
enum AuthFixtures {
    static let subject = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    static let otherSubject = "0f8fad5b-d9cb-469f-a165-70867728950e"
    static let clientID = "1a2b3c4d5e6f7g8h9i0j1k2l3m"

    /// An unsigned JWT whose payload is `claims` as JSON. Enough for `IDTokenClaims`, which
    /// never checks the signature.
    static func jwt(_ claims: [String: Any]) throws -> String {
        // Sorted keys, so the same claims always give the same token.
        let header = try JSONSerialization.data(withJSONObject: ["alg": "RS256", "kid": "test"], options: [.sortedKeys])
        let payload = try JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys])
        return "\(Base64URL.encode(header)).\(Base64URL.encode(payload)).c2lnbmF0dXJl"
    }

    static func idToken(subject: String = AuthFixtures.subject) throws -> String {
        try jwt(["sub": subject, "token_use": "id", "aud": clientID])
    }

    static func tokenResponse(
        access: String = "access-1",
        subject: String = AuthFixtures.subject,
        refresh: String? = "refresh-1",
        expiresIn: Int = 3600
    ) throws -> TokenResponse {
        TokenResponse(accessToken: access, idToken: try idToken(subject: subject), refreshToken: refresh, expiresIn: expiresIn)
    }

    static func hostedUI(domain: URL) throws -> HostedUI {
        HostedUI(
            domain: domain,
            clientID: clientID,
            redirectURL: try XCTUnwrap(URL(string: "cupmark://auth")),
            callbackScheme: "cupmark"
        )
    }

    static func devHostedUI() throws -> HostedUI {
        try hostedUI(domain: XCTUnwrap(URL(string: "https://cupmark-dev.auth.eu-central-1.amazoncognito.com")))
    }

    /// The name=value pairs of a form body or query, percent-decoded, in order.
    static func formPairs(_ string: String) -> [(String, String)] {
        string.split(separator: "&").map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(parts[0]).removingPercentEncoding ?? ""
            let value = parts.count > 1 ? (String(parts[1]).removingPercentEncoding ?? "") : ""
            return (name, value)
        }
    }

    static func formDictionary(_ data: Data?) -> [String: String] {
        let pairs = formPairs(String(decoding: data ?? Data(), as: UTF8.self))
        return Dictionary(pairs, uniquingKeysWith: { first, _ in first })
    }
}

/// A clock the test moves by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
        current = start
    }

    var now: Date {
        lock.withLock { current }
    }

    func advance(_ seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

/// A `CredentialStore` in memory.
final class FakeCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: StoredCredential?
    private var saveError: AuthError?
    private(set) var saveCount = 0

    init(_ credential: StoredCredential? = nil) {
        stored = credential
    }

    var credential: StoredCredential? {
        lock.withLock { stored }
    }

    func failSaves(with error: AuthError?) {
        lock.withLock { saveError = error }
    }

    func load() throws -> StoredCredential? {
        lock.withLock { stored }
    }

    func save(_ credential: StoredCredential) throws {
        try lock.withLock {
            if let error = saveError {
                throw error
            }
            saveCount += 1
            stored = credential
        }
    }

    func delete() throws {
        lock.withLock { stored = nil }
    }
}

/// A `TokenEndpoint` that answers from closures and records every call.
actor FakeTokenEndpoint: TokenEndpoint {
    enum Call: Equatable, Sendable {
        case exchange(code: String, verifier: String)
        case refresh(String)
        case revoke(String)
    }

    private(set) var calls: [Call] = []
    private var exchangeResult: @Sendable () throws -> TokenResponse
    private var refreshResult: @Sendable () throws -> TokenResponse
    private var revokeError: (any Error)?
    /// Nanoseconds every refresh waits before it answers, so concurrent callers overlap.
    private var refreshDelay: UInt64 = 0

    init(
        exchange: @escaping @Sendable () throws -> TokenResponse = { try AuthFixtures.tokenResponse() },
        refresh: @escaping @Sendable () throws -> TokenResponse = { try AuthFixtures.tokenResponse(access: "access-2", refresh: nil) }
    ) {
        exchangeResult = exchange
        refreshResult = refresh
    }

    var refreshCount: Int {
        calls.filter { if case .refresh = $0 { return true } else { return false } }.count
    }

    var exchangeCount: Int {
        calls.filter { if case .exchange = $0 { return true } else { return false } }.count
    }

    func setRefresh(_ result: @escaping @Sendable () throws -> TokenResponse) {
        refreshResult = result
    }

    func setRefreshDelay(nanoseconds: UInt64) {
        refreshDelay = nanoseconds
    }

    func setRevokeError(_ error: (any Error)?) {
        revokeError = error
    }

    func exchange(code: String, verifier: String) async throws -> TokenResponse {
        calls.append(.exchange(code: code, verifier: verifier))
        return try exchangeResult()
    }

    func refresh(refreshToken: String) async throws -> TokenResponse {
        calls.append(.refresh(refreshToken))
        if refreshDelay > 0 {
            try await Task.sleep(nanoseconds: refreshDelay)
        }
        return try refreshResult()
    }

    func revoke(refreshToken: String) async throws {
        calls.append(.revoke(refreshToken))
        if let revokeError {
            throw revokeError
        }
    }
}

/// A `WebAuthenticator` that answers with `respond(authorizeURL)` and records the URLs.
@MainActor
final class FakeWebAuthenticator: WebAuthenticator {
    private(set) var urls: [URL] = []
    private(set) var schemes: [String] = []
    var respond: (URL) throws -> URL

    nonisolated init(respond: @escaping (URL) throws -> URL) {
        self.respond = respond
    }

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        urls.append(url)
        schemes.append(callbackScheme)
        return try respond(url)
    }

    /// The value of a query parameter of `url`.
    nonisolated static func parameter(_ name: String, of url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
    }

    /// Answers like Cognito: `cupmark://auth?code=<code>&state=<the request's state>`.
    nonisolated static func returningCode(_ code: String) -> (URL) throws -> URL {
        { url in
            let state = try XCTUnwrap(parameter("state", of: url))
            return try XCTUnwrap(URL(string: "cupmark://auth?code=\(code)&state=\(FormEncoding.escape(state))"))
        }
    }
}
