import XCTest
@testable import Cupmark

/// The scanner's normalisation must match `canonicalBarcode` in backend/src/repository/keys.ts;
/// the vectors are the backend's (backend/test/repository/keys.test.ts) plus edge cases.
final class CanonicalBarcodeTests: XCTestCase {
    func testEAN13WithAValidCheckDigitIsKept() {
        XCTAssertEqual(CanonicalBarcode("4006381333931")?.digits, "4006381333931")
        XCTAssertEqual(CanonicalBarcode("5901234123457")?.digits, "5901234123457")
        XCTAssertEqual(CanonicalBarcode("9783161484100")?.digits, "9783161484100", "check digit 0")
    }

    func testUPCAGetsALeadingZeroAndMatchesItsEAN13Form() {
        XCTAssertEqual(CanonicalBarcode("012345678905")?.digits, "0012345678905")
        XCTAssertEqual(CanonicalBarcode("036000291452")?.digits, "0036000291452")
        XCTAssertEqual(CanonicalBarcode("036000291452"), CanonicalBarcode("0036000291452"))
        XCTAssertEqual(CanonicalBarcode("0012345678905")?.digits, "0012345678905")
    }

    func testAWrongCheckDigitIsRejected() {
        for payload in ["0012345678901", "4006381333932", "012345678900", "4006381339331", "036000291453"] {
            XCTAssertNil(CanonicalBarcode(payload), payload)
        }
    }

    func testOtherLengthsAreRejected() {
        // EAN-8 and UPC-E are valid barcodes, but not the contract's 12 or 13 digits.
        for payload in ["", "96385074", "01234565", "01234567890", "40063813339310", "00012345678905"] {
            XCTAssertNil(CanonicalBarcode(payload), payload)
        }
    }

    func testNonDigitsAreRejected() {
        let payloads = [
            "40063813339AB",
            "400638133393a",
            " 4006381333931",
            "4006381333931 ",
            "4006381333931\n",
            "4006-381333931",
            "+4006381333931",
            "-012345678905",
            "4006381333931\u{0}",
            // Arabic-Indic and full-width digits are numbers, but not ASCII digits.
            "\u{0664}\u{0660}\u{0660}\u{0666}\u{0663}\u{0668}\u{0661}\u{0663}\u{0663}\u{0663}\u{0669}\u{0663}\u{0661}",
            "\u{FF14}\u{FF10}\u{FF10}\u{FF16}\u{FF13}\u{FF18}\u{FF11}\u{FF13}\u{FF13}\u{FF13}\u{FF19}\u{FF13}\u{FF11}",
        ]
        for payload in payloads {
            XCTAssertNil(CanonicalBarcode(payload), payload.debugDescription)
        }
    }

    func testCheckDigitFollowsGS1() {
        XCTAssertEqual(CanonicalBarcode.checkDigit(of: [4, 0, 0, 6, 3, 8, 1, 3, 3, 3, 9, 3]), 1)
        XCTAssertEqual(CanonicalBarcode.checkDigit(of: [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]), 5)
        XCTAssertEqual(CanonicalBarcode.checkDigit(of: [9, 7, 8, 3, 1, 6, 1, 4, 8, 4, 1, 0]), 0)
    }

    func testTheLookupPathValueIsTheCanonicalForm() throws {
        let barcode = try XCTUnwrap(CanonicalBarcode("036000291452"))
        XCTAssertEqual(barcode.lookupBarcode?.pathSegment, "0036000291452")
        XCTAssertEqual(barcode.description, "0036000291452")
    }

    func testASessionLetsThroughOnlyTheFirstValidCode() {
        var session = BarcodeScanSession()
        XCTAssertNil(session.accept("not a code"))
        XCTAssertNil(session.accept("4006381333932"))
        XCTAssertFalse(session.isFinished)
        XCTAssertEqual(session.accept("036000291452")?.digits, "0036000291452")
        XCTAssertTrue(session.isFinished)
        XCTAssertNil(session.accept("036000291452"), "duplicate")
        XCTAssertNil(session.accept("0036000291452"), "same product, other form")
        XCTAssertNil(session.accept("4006381333931"), "another valid code")
        XCTAssertEqual(session.result?.digits, "0036000291452")
    }
}
