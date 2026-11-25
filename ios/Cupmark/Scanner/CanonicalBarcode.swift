import Foundation

/// A barcode in the canonical 13-digit form the backend stores (`canonicalBarcode` in
/// backend/src/repository/keys.ts, `Barcode` in contracts/openapi.yaml):
/// - EAN-13 (13 digits) is kept as is;
/// - UPC-A (12 digits) gets a leading 0 and becomes the EAN-13 of the same product;
/// - the GS1 check digit (weights 1 and 3 alternating from the left over the first 12 digits)
///   must be right.
/// Anything else (other lengths, non-ASCII-digits, a wrong check digit) is not a barcode, so
/// the scanner ignores it and no request is made. Pure Swift, no VisionKit.
struct CanonicalBarcode: Hashable, Sendable, CustomStringConvertible {
    /// Always 13 ASCII digits with a valid check digit.
    let digits: String

    /// Nil unless `payload` is a valid EAN-13 or UPC-A. Whitespace is not trimmed, so the rule
    /// is exactly the server's.
    init?(_ payload: String) {
        let bytes = Array(payload.utf8)
        guard bytes.count == 12 || bytes.count == 13,
              bytes.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }) else {
            return nil
        }
        let values = (bytes.count == 12 ? [0] : []) + bytes.map { Int($0 - UInt8(ascii: "0")) }
        guard values.count == 13, let check = values.last,
              CanonicalBarcode.checkDigit(of: values.prefix(12)) == check else {
            return nil
        }
        digits = bytes.count == 12 ? "0" + payload : payload
    }

    /// The GS1 check digit of the first 12 digits of an EAN-13.
    static func checkDigit<Digits: Collection>(of values: Digits) -> Int where Digits.Element == Int {
        var sum = 0
        for (index, value) in values.enumerated() {
            sum += value * (index.isMultiple(of: 2) ? 1 : 3)
        }
        return (10 - sum % 10) % 10
    }

    /// The path value for `GET /barcodes/{barcode}` (M2-T14). Never nil for a canonical
    /// barcode; optional only because `LookupBarcode` checks its input itself.
    var lookupBarcode: LookupBarcode? { LookupBarcode(digits) }

    var description: String { digits }
}

/// Accepts the payloads a scanner reports and lets through only the first valid barcode, once.
/// After that every report, valid or not and duplicate or not, is ignored.
struct BarcodeScanSession: Sendable {
    private(set) var result: CanonicalBarcode?

    var isFinished: Bool { result != nil }

    /// The canonical barcode if `payload` is the first valid one, else nil.
    mutating func accept(_ payload: String) -> CanonicalBarcode? {
        guard result == nil, let barcode = CanonicalBarcode(payload) else { return nil }
        result = barcode
        return barcode
    }
}
