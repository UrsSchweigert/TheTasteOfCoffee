import Foundation
@testable import Cupmark

/// A request as the stub received it.
struct RecordedRequest: Sendable {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data?

    /// The percent-encoded path, for example `/shelf/01JDQ6Y8Z5W4V3T2S1R0P9N8M0`.
    var path: String { url.path(percentEncoded: true) }

    /// The query items in order; empty when there is no query.
    var queryItems: [URLQueryItem] {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    }

    /// The value of a header, by case-insensitive name.
    func header(_ name: String) -> String? {
        headers.first { key, _ in key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// What the stub answers.
struct StubResponse: Sendable {
    let status: Int
    let body: Data
    let headers: [String: String]

    init(status: Int, body: Data = Data(), headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }
}

/// A fake API server for one test. Each server has its own host, so tests never see each
/// other's requests. The handler may throw a `URLError` to fail the request in transport.
final class StubServer: @unchecked Sendable {
    typealias Handler = @Sendable (RecordedRequest) throws -> StubResponse

    let host: String
    let baseURL: URL
    private let lock = NSLock()
    private var handler: Handler
    private var recorded: [RecordedRequest] = []

    init(basePath: String = "", handler: @escaping Handler) throws {
        host = "\(UUID().uuidString.lowercased()).api.cupmark.test"
        guard let url = URL(string: "https://\(host)\(basePath)") else {
            throw URLError(.badURL)
        }
        baseURL = url
        self.handler = handler
        StubRegistry.register(self)
    }

    deinit {
        StubRegistry.unregister(host: host)
    }

    /// Every request received so far, in order.
    var requests: [RecordedRequest] {
        lock.withLock { recorded }
    }

    func setHandler(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    /// A session whose requests all go to `StubURLProtocol`.
    func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    fileprivate func respond(to request: RecordedRequest) throws -> StubResponse {
        let current: Handler = lock.withLock {
            recorded.append(request)
            return handler
        }
        return try current(request)
    }
}

/// The live stub servers, by host. Held weakly, so a server goes away with its test.
private enum StubRegistry {
    private final class WeakServer {
        weak var server: StubServer?

        init(_ server: StubServer) {
            self.server = server
        }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [String: WeakServer] = [:]

    static func register(_ server: StubServer) {
        lock.withLock { servers[server.host] = WeakServer(server) }
    }

    static func unregister(host: String) {
        lock.withLock { servers[host] = nil }
    }

    static func server(for host: String) -> StubServer? {
        lock.withLock { servers[host]?.server }
    }
}

/// Answers every request of a session made by `StubServer.makeSession()`.
final class StubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url,
              let host = url.host(),
              let server = StubRegistry.server(for: host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let recorded = RecordedRequest(
            method: request.httpMethod ?? "GET",
            url: url,
            headers: request.allHTTPHeaderFields ?? [:],
            body: StubURLProtocol.body(of: request)
        )
        do {
            let reply = try server.respond(to: recorded)
            guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    /// The body: URLSession hands it to a protocol as a stream, not as `httpBody`.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 {
                break
            }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// A token provider that counts its calls. `refresh()` switches to the next token, or throws
/// when `refreshFails` is set.
actor FakeTokenProvider: TokenProvider {
    private(set) var token: String
    private(set) var refreshCount = 0
    private(set) var tokenRequests = 0
    private let refreshedToken: String
    private let refreshFails: Bool
    private let signedIn: Bool

    init(token: String = "access-token-1", refreshedToken: String = "access-token-2", refreshFails: Bool = false, signedIn: Bool = true) {
        self.token = token
        self.refreshedToken = refreshedToken
        self.refreshFails = refreshFails
        self.signedIn = signedIn
    }

    func currentAccessToken() async throws -> String {
        tokenRequests += 1
        guard signedIn else {
            throw URLError(.userAuthenticationRequired)
        }
        return token
    }

    func refresh() async throws {
        refreshCount += 1
        if refreshFails {
            throw URLError(.userAuthenticationRequired)
        }
        token = refreshedToken
    }
}
