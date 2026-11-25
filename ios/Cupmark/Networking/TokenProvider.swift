import Foundation

/// Gives `APIClient` the caller's Cognito access token (M2-T11 implements it: the refresh
/// token in the Keychain, the access token in memory, a single-flight refresh).
///
/// The user is always the subject of this token. The client never sends a user id in a path,
/// query or body (invariant 3), and never logs the token.
protocol TokenProvider: Sendable {
    /// The current access token. Throws when nobody is signed in.
    func currentAccessToken() async throws -> String

    /// Gets a new access token, for example after a 401. Throws when that is not possible;
    /// the user then has to sign in again.
    func refresh() async throws
}
