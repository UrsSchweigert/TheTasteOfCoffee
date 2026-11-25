import Foundation

/// Why signing in, refreshing or reading the saved sign-in failed. No case carries a token, a
/// code, a server message or any other text from outside the app, so an error can be shown or
/// logged without leaking one.
///
/// Network failures of the Cognito endpoints are thrown as `APIError.transport`, the same as
/// for API calls, so `APIClient` and the outbox can tell "offline" from "signed out".
enum AuthError: Error, Equatable, Sendable {
    /// The user closed the sign-in sheet. Not a failure to show.
    case cancelled
    /// The web authentication session could not be started.
    case couldNotStart
    /// The callback's `state` is missing or is not the one sent (a forged or stale callback).
    case stateMismatch
    /// The callback has no usable authorization code.
    case missingCode
    /// The callback is not `cupmark://auth`.
    case unexpectedCallback
    /// The hosted UI returned an OAuth `error` (for example `access_denied`).
    case authorizationFailed
    /// Cognito answered `invalid_grant`: the code or the refresh token is expired or revoked.
    case invalidGrant
    /// A token endpoint answered with another status.
    case server(status: Int)
    /// A token response that breaks OAuth 2.0 or Cognito's shape (no Bearer, no id token, ...).
    case invalidResponse
    /// No refresh token is saved: nobody is signed in.
    case notSignedIn
    /// The saved sign-in ended (refresh token expired or revoked). The user signs in again.
    case sessionExpired
    /// A refreshed id token names another user than the saved one.
    case accountMismatch
    /// The Keychain rejected the operation with this status.
    case keychain(OSStatus)
    /// The secure random generator failed.
    case randomUnavailable
}
