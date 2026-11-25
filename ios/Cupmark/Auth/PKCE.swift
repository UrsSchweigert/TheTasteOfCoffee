import CryptoKit
import Foundation
import Security

/// Proof Key for Code Exchange (RFC 7636) with the `S256` method, for the public Cognito app
/// client (infra/src/identity.ts: no client secret, PKCE protects the code).
struct PKCE: Equatable, Sendable {
    /// The only method the app uses.
    static let method = "S256"
    /// Random bytes behind a verifier: 32 bytes give the 43-character verifier of RFC 7636,
    /// section 4.1, the shortest it allows, with 256 bits of entropy.
    static let verifierByteCount = 32

    /// Sent only to `/oauth2/token`, with the code.
    let verifier: String
    /// `BASE64URL(SHA256(ASCII(verifier)))`, sent to `/oauth2/authorize`.
    let challenge: String

    /// A PKCE pair for a verifier built from `bytes`, base64url without padding.
    init(verifierBytes bytes: Data) {
        let verifier = Base64URL.encode(bytes)
        self.verifier = verifier
        self.challenge = PKCE.challenge(for: verifier)
    }

    /// A fresh pair with a verifier from the system's secure random generator.
    static func generate() throws -> PKCE {
        PKCE(verifierBytes: try SecureRandom.bytes(count: verifierByteCount))
    }

    /// The S256 challenge of `verifier`.
    static func challenge(for verifier: String) -> String {
        Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
}

/// Bytes from `SecRandomCopyBytes`, the system's cryptographically secure generator.
enum SecureRandom {
    static func bytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw AuthError.randomUnavailable
        }
        return Data(bytes)
    }

    /// A random `state` for one authorization request: 32 bytes, base64url.
    static func state() throws -> String {
        Base64URL.encode(try bytes(count: 32))
    }
}

/// Base64url without padding (RFC 4648, section 5), as JWTs and PKCE use it.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Nil for anything that is not base64url. Padding is accepted but not required.
    static func decode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.hasSuffix("=") {
            base64.removeLast()
        }
        switch base64.count % 4 {
        case 0: break
        case 2: base64 += "=="
        case 3: base64 += "="
        default: return nil
        }
        return Data(base64Encoded: base64)
    }
}
