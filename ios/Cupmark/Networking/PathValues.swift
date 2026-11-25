import Foundation

/// A value that `APIClient` may put in a URL path. Only `ResourceID` and `LookupBarcode`
/// conform, and both are checked against the contract's pattern, so a path is never built from
/// arbitrary text and never holds a user id (invariant 3).
protocol APIPathValue: Sendable {
    /// The path segment, ASCII letters and digits only.
    var pathSegment: String { get }
}

/// A server-generated id: a ULID, Crockford base32 in upper case (`Id` in contracts/openapi.yaml,
/// `^[0-9A-HJKMNP-TV-Z]{26}$`). Safe as a path segment and as a file name.
struct ResourceID: APIPathValue, Hashable, CustomStringConvertible {
    let rawValue: String

    /// Nil unless `text` matches the contract's `Id` pattern.
    init?(_ text: String) {
        guard text.utf8.count == 26, text.utf8.allSatisfy(ResourceID.isCrockfordDigit) else {
            return nil
        }
        rawValue = text
    }

    var pathSegment: String { rawValue }

    var description: String { rawValue }

    /// 0 to 9 and A to Z without I, L, O and U.
    private static func isCrockfordDigit(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"):
            return true
        case UInt8(ascii: "I"), UInt8(ascii: "L"), UInt8(ascii: "O"), UInt8(ascii: "U"):
            return false
        case UInt8(ascii: "A")...UInt8(ascii: "Z"):
            return true
        default:
            return false
        }
    }
}

/// A barcode to look up: EAN-13 (13 digits) or UPC-A (12 digits), `Barcode` in
/// contracts/openapi.yaml. The scanner (M2-T13) checks the check digit before it makes one;
/// the server checks it again.
struct LookupBarcode: APIPathValue, Hashable, CustomStringConvertible {
    let rawValue: String

    /// Nil unless `text` is 12 or 13 ASCII digits.
    init?(_ text: String) {
        guard (12...13).contains(text.utf8.count),
              text.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }) else {
            return nil
        }
        rawValue = text
    }

    var pathSegment: String { rawValue }

    var description: String { rawValue }
}
