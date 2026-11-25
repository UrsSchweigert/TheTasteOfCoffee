import CryptoKit
import Foundation

/// The local key of the signed-in account, for the SwiftData store (M2-T15).
///
/// - It is derived on the device: the lowercase hex SHA-256 of the id token's `sub` (64
///   characters). The same user always gets the same id; another user never does.
/// - It is never sent anywhere. The backend takes the user from the access token (invariant
///   3); no request body, path or query carries this value or the `sub` it comes from. Being
///   a hash, it also never equals the server's user id, so it cannot be mistaken for one.
/// - It is safe as a file or directory name (hex digits only).
/// - It is saved next to the refresh token in the Keychain, so the app knows the account
///   offline at launch, before any refresh.
struct AccountID: RawRepresentable, Hashable, Codable, Sendable {
    static let length = 64

    let rawValue: String

    /// Nil unless `rawValue` is 64 lowercase hex digits.
    init?(rawValue: String) {
        guard rawValue.utf8.count == AccountID.length,
              rawValue.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }) else {
            return nil
        }
        self.rawValue = rawValue
    }

    /// The account of a Cognito `sub`.
    init(subject: String) {
        rawValue = SHA256.hash(data: Data(subject.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// The account of an id token, from the `sub` claim of its payload.
    init(idToken: String) throws {
        self.init(subject: try IDTokenClaims.subject(of: idToken))
    }

    init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        guard let account = AccountID(rawValue: value) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an account id"))
        }
        self = account
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Reads the `sub` claim of a Cognito id token.
///
/// The signature is not verified, on purpose: the token was just received over TLS from the
/// stage's Cognito domain, in exchange for a code or a refresh token only this app holds, and
/// `sub` is used only to pick the local store on this device. Nothing the server trusts is
/// derived from it; the backend verifies the access token on every request. A forged id token
/// could only make the app open another (empty) local store. The app reads no other claim, so
/// no name or email (none is requested either).
enum IDTokenClaims {
    /// Longest `sub` accepted. Cognito's is a UUID (36 characters).
    static let maxSubjectLength = 128

    private struct Payload: Decodable {
        let sub: String
    }

    static func subject(of idToken: String) throws -> String {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let data = Base64URL.decode(String(parts[1])),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            throw AuthError.invalidResponse
        }
        let subject = payload.sub
        guard (1...maxSubjectLength).contains(subject.utf8.count),
              subject.utf8.allSatisfy({ FormEncoding.isUnreserved($0) }) else {
            throw AuthError.invalidResponse
        }
        return subject
    }
}
