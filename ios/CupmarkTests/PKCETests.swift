import XCTest
@testable import Cupmark

/// PKCE (RFC 7636) with S256, the random `state` and base64url (M2-T11).
final class PKCETests: XCTestCase {
    /// RFC 7636, appendix B: the 32 random octets, the verifier they encode to, and its
    /// S256 challenge.
    func testRFC7636AppendixBVector() {
        let octets: [UInt8] = [
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
            22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ]
        let pkce = PKCE(verifierBytes: Data(octets))
        XCTAssertEqual(pkce.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(PKCE.method, "S256")
    }

    func testGeneratedVerifiersAreLongEnoughUnreservedAndDifferent() throws {
        let first = try PKCE.generate()
        let second = try PKCE.generate()
        for pkce in [first, second] {
            // RFC 7636, 4.1: 43 to 128 characters of [A-Z a-z 0-9 - . _ ~].
            XCTAssertEqual(pkce.verifier.count, 43)
            XCTAssertTrue(pkce.verifier.utf8.allSatisfy(FormEncoding.isUnreserved))
            XCTAssertEqual(pkce.challenge, PKCE.challenge(for: pkce.verifier))
            XCTAssertEqual(pkce.challenge.count, 43)
        }
        XCTAssertNotEqual(first.verifier, second.verifier)
    }

    func testStatesAreRandomAndURLSafe() throws {
        let states = try (0..<10).map { _ in try SecureRandom.state() }
        XCTAssertEqual(Set(states).count, states.count)
        for state in states {
            XCTAssertEqual(state.count, 43)
            XCTAssertTrue(state.utf8.allSatisfy(FormEncoding.isUnreserved))
        }
    }

    func testBase64URLRoundTripsWithoutPadding() {
        for length in 0...6 {
            let data = Data((0..<length).map { UInt8(250 - $0) })
            let encoded = Base64URL.encode(data)
            XCTAssertFalse(encoded.contains("="))
            XCTAssertFalse(encoded.contains("+"))
            XCTAssertFalse(encoded.contains("/"))
            XCTAssertEqual(Base64URL.decode(encoded), data, "length \(length)")
        }
        XCTAssertNil(Base64URL.decode("a"))
        XCTAssertNil(Base64URL.decode("ab!c"))
    }
}
