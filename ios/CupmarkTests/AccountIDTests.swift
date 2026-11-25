import XCTest
@testable import Cupmark

/// `AccountID`, the local store key derived from the id token's `sub` (M2-T11, M2-T15).
final class AccountIDTests: XCTestCase {
    func testTheSubjectIsReadFromTheIDTokenPayload() throws {
        XCTAssertEqual(try IDTokenClaims.subject(of: AuthFixtures.idToken()), AuthFixtures.subject)
    }

    func testTheAccountIsTheSHA256OfTheSubjectInHex() throws {
        // FIPS 180-2 test vector: SHA-256("abc").
        XCTAssertEqual(AccountID(subject: "abc").rawValue, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let account = try AccountID(idToken: AuthFixtures.idToken())
        XCTAssertEqual(account, AccountID(subject: AuthFixtures.subject))
        XCTAssertEqual(account.rawValue.count, AccountID.length)
        XCTAssertNotEqual(account.rawValue, AuthFixtures.subject, "the sub itself is never the key")
        XCTAssertNotEqual(account, AccountID(subject: AuthFixtures.otherSubject))
    }

    func testOnlyHexOfTheRightLengthIsARawValue() {
        let valid = AccountID(subject: AuthFixtures.subject).rawValue
        XCTAssertEqual(AccountID(rawValue: valid)?.rawValue, valid)
        XCTAssertNil(AccountID(rawValue: valid.uppercased()))
        XCTAssertNil(AccountID(rawValue: String(valid.dropLast())))
        XCTAssertNil(AccountID(rawValue: valid + "0"))
        XCTAssertNil(AccountID(rawValue: AuthFixtures.subject))
        XCTAssertNil(AccountID(rawValue: ""))
    }

    func testTheAccountRoundTripsAsAJSONString() throws {
        let account = AccountID(subject: AuthFixtures.subject)
        let data = try JSONEncoder().encode([account])
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "[\"\(account.rawValue)\"]")
        XCTAssertEqual(try JSONDecoder().decode([AccountID].self, from: data), [account])
        XCTAssertThrowsError(try JSONDecoder().decode([AccountID].self, from: Data("[\"abc\"]".utf8)))
    }

    func testMalformedIDTokensAreRejected() throws {
        let tokens = [
            "",
            "abc",
            "a.b",
            "a.b.c.d",
            "eyJhbGciOiJub25lIn0.!!!.sig",
            try AuthFixtures.jwt(["token_use": "id"]),
            try AuthFixtures.jwt(["sub": ""]),
            try AuthFixtures.jwt(["sub": "has space"]),
            try AuthFixtures.jwt(["sub": 42]),
            try AuthFixtures.jwt(["sub": String(repeating: "a", count: IDTokenClaims.maxSubjectLength + 1)]),
        ]
        for token in tokens {
            XCTAssertThrowsError(try AccountID(idToken: token), token) { error in
                XCTAssertEqual(error as? AuthError, .invalidResponse)
            }
        }
    }
}
