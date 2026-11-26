#if DEBUG
import Foundation

/// The stub API of a UI-test launch (M2-T33): an `APIClient` whose session answers every
/// request in the process, from the fixtures, so nothing reaches a network. The base URL is on
/// the reserved `.test` domain, so even a request that escaped the stub could not reach a
/// server.
///
/// - `GET /barcodes/<UITestFixtures.barcode>` answers the catalogue bean (the lookup result).
/// - Every other request answers 503, which the app treats as "unavailable for now": a screen
///   that asks for something else shows its offline state, and nothing waits forever.
enum UITestAPI {
    static let baseURL = URL(string: "https://api.cupmark.test")

    /// The client the screens of a UI-test launch use; nil only if the base URL did not parse.
    static func makeClient() -> APIClient? {
        guard let baseURL else {
            return nil
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UITestStubURLProtocol.self]
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return APIClient(
            baseURL: baseURL,
            tokenProvider: UITestTokenProvider(),
            session: URLSession(configuration: configuration),
            imageCache: nil
        )
    }

    /// The status and body for a request.
    static func answer(method: String, path: String) -> (status: Int, body: Data) {
        if method == "GET", path == "/barcodes/\(UITestFixtures.barcode)",
           let body = try? JSONEncoder().encode(UITestFixtures.catalogueBean()) {
            return (200, body)
        }
        return (503, Data())
    }
}

/// A token that is never sent anywhere: the stub answers every request.
struct UITestTokenProvider: TokenProvider {
    func currentAccessToken() async throws -> String {
        "ui-test-access-token"
    }

    func refresh() async throws {}
}

/// Answers every request of the UI-test session with `UITestAPI.answer`.
final class UITestStubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let answer = UITestAPI.answer(method: request.httpMethod ?? "GET", path: url.path(percentEncoded: true))
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: answer.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
