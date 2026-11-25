import Vision
import VisionKit
import XCTest
@testable import Cupmark

/// A barcode source that replays fixed reports, in place of VisionKit.
@MainActor
final class FakeBarcodeSource: BarcodeSource {
    let events: AsyncStream<BarcodeSourceEvent>
    private let continuation: AsyncStream<BarcodeSourceEvent>.Continuation
    private(set) var stopCount = 0

    init(_ reports: [BarcodeSourceEvent], finish: Bool = true) {
        let (stream, continuation) = AsyncStream.makeStream(of: BarcodeSourceEvent.self)
        events = stream
        self.continuation = continuation
        for report in reports {
            continuation.yield(report)
        }
        if finish {
            continuation.finish()
        }
    }

    convenience init(payloads: [String]) {
        self.init(payloads.map(BarcodeSourceEvent.payload))
    }

    func send(_ event: BarcodeSourceEvent) {
        continuation.yield(event)
    }

    func stop() {
        stopCount += 1
        continuation.finish()
    }
}

@MainActor
struct FakeScannerEnvironment: ScannerEnvironment {
    let answer: ScannerAvailability

    func availability() async -> ScannerAvailability {
        answer
    }
}

@MainActor
final class ScannerViewModelTests: XCTestCase {
    private var reported: [CanonicalBarcode] = []

    private func scanningModel() async -> ScannerViewModel {
        let model = ScannerViewModel(environment: FakeScannerEnvironment(answer: .available)) { [weak self] barcode in
            self?.reported.append(barcode)
        }
        await model.checkAvailability()
        return model
    }

    func testAvailabilityDecidesBetweenScanningAndTheFallback() async {
        let cases: [(ScannerAvailability, ScannerViewModel.State)] = [
            (.available, .scanning),
            (.unavailable(.unsupported), .unavailable(.unsupported)),
            (.unavailable(.permissionDenied), .unavailable(.permissionDenied)),
            (.unavailable(.notAvailable), .unavailable(.notAvailable)),
        ]
        for (answer, expected) in cases {
            let model = ScannerViewModel(environment: FakeScannerEnvironment(answer: answer)) { _ in }
            XCTAssertEqual(model.state, .checking)
            await model.checkAvailability()
            XCTAssertEqual(model.state, expected)
        }
    }

    func testAValid13DigitCodeIsReportedOnceAndStopsTheScan() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource(payloads: ["4006381333931"])
        await model.consume(source)
        XCTAssertEqual(reported.map(\.digits), ["4006381333931"])
        XCTAssertEqual(model.state, CanonicalBarcode("4006381333931").map(ScannerViewModel.State.scanned))
        XCTAssertEqual(source.stopCount, 1)
    }

    func testAValid12DigitCodeIsReportedAsEAN13() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource(payloads: ["036000291452"])
        await model.consume(source)
        XCTAssertEqual(reported.map(\.digits), ["0036000291452"])
        XCTAssertEqual(source.stopCount, 1)
    }

    func testInvalidCodesAndNonDigitsAreIgnoredUntilAValidOne() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource(payloads: [
            "4006381333932",  // wrong check digit
            "012345678900",   // UPC-A, wrong check digit
            "40063813339AB",  // non-digits
            "96385074",       // EAN-8
            "",
            "012345678905",
        ])
        await model.consume(source)
        XCTAssertEqual(reported.map(\.digits), ["0012345678905"])
        XCTAssertEqual(source.stopCount, 1)
    }

    func testOnlyInvalidCodesReportNothingAndKeepScanning() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource(payloads: ["4006381333932", "abc", "0012345678901"])
        await model.consume(source)
        XCTAssertTrue(reported.isEmpty)
        XCTAssertEqual(model.state, .scanning)
        XCTAssertEqual(source.stopCount, 0)
    }

    func testDuplicateAndLaterReportsAreIgnored() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource(payloads: ["036000291452", "036000291452", "0036000291452", "4006381333931"])
        await model.consume(source)
        XCTAssertEqual(reported.map(\.digits), ["0036000291452"])
        XCTAssertEqual(source.stopCount, 1)

        // A second run on the same model (the screen reappears) reports nothing more.
        let again = FakeBarcodeSource(payloads: ["4006381333931"])
        await model.consume(again)
        XCTAssertEqual(reported.count, 1)
        XCTAssertEqual(again.stopCount, 0)
    }

    func testReportsArrivingWhileScanningAreHandledInOrder() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([], finish: false)
        let run = Task { await model.consume(source) }
        source.send(.payload("not a code"))
        source.send(.payload("4006381333931"))
        source.send(.payload("4006381333931"))
        await run.value
        XCTAssertEqual(reported.map(\.digits), ["4006381333931"])
        XCTAssertEqual(source.stopCount, 1)
    }

    func testTheCameraBecomingUnavailableShowsTheFallback() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([.payload("abc"), .unavailable, .payload("4006381333931")])
        await model.consume(source)
        XCTAssertTrue(reported.isEmpty)
        XCTAssertEqual(model.state, .unavailable(.notAvailable))
        XCTAssertEqual(source.stopCount, 1)
    }

    func testNothingIsConsumedUnlessScanning() async {
        let model = ScannerViewModel(environment: FakeScannerEnvironment(answer: .unavailable(.permissionDenied))) { [weak self] barcode in
            self?.reported.append(barcode)
        }
        await model.checkAvailability()
        let source = FakeBarcodeSource(payloads: ["4006381333931"])
        await model.consume(source)
        XCTAssertTrue(reported.isEmpty)
        XCTAssertEqual(model.state, .unavailable(.permissionDenied))
        XCTAssertEqual(source.stopCount, 0)
    }

    func testCancellingTheRunReportsNothing() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([], finish: false)
        let run = Task { await model.consume(source) }
        run.cancel()
        await run.value
        XCTAssertTrue(reported.isEmpty)
        XCTAssertEqual(model.state, .scanning)
    }

    // M2-T13 review, fixed in M2-T22: pushing the pick-list entry over the scanner cancels the
    // screen's `.task`. The run must stop the source then, or the camera keeps running.
    func testCancellingTheRunStopsTheSource() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([], finish: false)
        let run = Task { await model.consume(source) }
        run.cancel()
        await run.value
        XCTAssertEqual(source.stopCount, 1)
        XCTAssertTrue(reported.isEmpty)
        XCTAssertEqual(model.state, .scanning)
    }

    func testCancellingARunThatIsAlreadyReadingStopsTheSource() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([], finish: false)
        let run = Task { await model.consume(source) }
        // Let the run reach the `for await` and handle a report before it is cancelled.
        source.send(.payload("not a code"))
        await Task.yield()
        await Task.yield()
        run.cancel()
        await run.value
        XCTAssertEqual(source.stopCount, 1)
        XCTAssertTrue(reported.isEmpty)
    }

    func testACancelledRunAfterTheScanDoesNotStopTheSourceAgain() async {
        let model = await scanningModel()
        let source = FakeBarcodeSource([.payload("4006381333931")], finish: false)
        let run = Task { await model.consume(source) }
        await run.value
        run.cancel()
        XCTAssertEqual(source.stopCount, 1)
        XCTAssertEqual(reported.map(\.digits), ["4006381333931"])
    }

    func testTheScannerReadsEAN13Only() {
        // UPC-A arrives within EAN-13 (leading 0); VisionKit has no separate UPC-A symbology.
        XCTAssertEqual(ScannerSymbologies.recognized, [.barcode(symbologies: [VNBarcodeSymbology.ean13])])
    }
}
