import Foundation

/// A failed API call. The statuses of contracts/openapi.yaml each have a case; error bodies are
/// never read, so no case carries server text (docs/05, Security).
enum APIError: Error, Equatable, Sendable {
    /// 400: a value is outside its list or range, or the item cannot be accepted. Never retried.
    case badRequest
    /// 401, also after one refresh and one retry, or no token could be had. The user signs in again.
    case unauthorized
    /// 404.
    case notFound
    /// 409.
    case conflict
    /// 429: throttled, or a daily cap is used up.
    case tooManyRequests
    /// 503: the lookup is unavailable for now (Open Food Facts lookup).
    case serviceUnavailable
    /// Any other 5xx.
    case server(status: Int)
    /// The request did not complete: no network, a timeout, a lost connection. The server may
    /// or may not have acted on it.
    case transport(URLError.Code)
    /// A status the contract does not list for the route, including a 2xx other than its success status.
    case unexpectedStatus(Int)
    /// A success body that does not decode as the contract's type, for example with an id the
    /// bundled vocabulary does not know.
    case undecodable
    /// A response that breaks the contract in another way: not HTTP, an image that is not a
    /// JPEG, or a page cursor that repeats or is malformed.
    case invalidResponse
    /// The client refused to build the request (a parameter out of range). A programming error.
    case invalidRequest

    /// The error for an HTTP status that is not the route's success status.
    init(status: Int) {
        switch status {
        case 400: self = .badRequest
        case 401: self = .unauthorized
        case 404: self = .notFound
        case 409: self = .conflict
        case 429: self = .tooManyRequests
        case 503: self = .serviceUnavailable
        case 500...599: self = .server(status: status)
        default: self = .unexpectedStatus(status)
        }
    }

    /// True when the same request may succeed later without a change: 429, 503, other 5xx and
    /// transport failures. The outbox (M2-T16) backs off and retries these. Never true for a
    /// cancelled request (the client throws `CancellationError` for those).
    var isRetryable: Bool {
        switch self {
        case .transport(let code):
            return code != .cancelled
        case .tooManyRequests, .serviceUnavailable, .server:
            return true
        case .badRequest, .unauthorized, .notFound, .conflict, .unexpectedStatus, .undecodable, .invalidResponse, .invalidRequest:
            return false
        }
    }
}
