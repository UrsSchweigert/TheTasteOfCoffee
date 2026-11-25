import AVFoundation
import CoreGraphics
import ImageIO
import UIKit
import XCTest
@testable import Cupmark

/// Holds a stubbed encoding until the test opens it.
private final class PrepareGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var isOpen = false

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resumeNow = lock.withLock {
                if isOpen {
                    return true
                }
                self.continuation = continuation
                return false
            }
            if resumeNow {
                continuation.resume()
            }
        }
    }

    func open() {
        let resumable = lock.withLock {
            isOpen = true
            let pending = continuation
            continuation = nil
            return pending
        }
        resumable?.resume()
    }
}

private struct StubEncodingFailure: Error {}

/// `LabelPhotoDraft` (M2-T23): the label photo of a bean entry, held in memory until upload,
/// and the camera availability that decides whether the step is shown.
@MainActor
final class LabelPhotoDraftTests: XCTestCase {
    private func capture() throws -> LabelPhotoCapture {
        LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 40, height: 20), orientation: .right)
    }

    private func prepared(width: Int = 20) -> PreparedLabelPhoto {
        PreparedLabelPhoto(
            photo: EncodedLabelPhoto(data: Data([0xFF, 0xD8, 0xFF, 0xD9]), pixelWidth: width, pixelHeight: 40, quality: 0.9),
            preview: nil
        )
    }

    private func waitUntilPreparing(_ draft: LabelPhotoDraft) async {
        while !draft.isPreparing {
            await Task.yield()
        }
    }

    // MARK: - Draft

    func testANewDraftHasNoPhoto() {
        let draft = LabelPhotoDraft(prepare: { _ in throw StubEncodingFailure() })

        XCTAssertEqual(draft.state, .empty)
        XCTAssertNil(draft.photo)
    }

    func testACaptureIsEncodedAndAttached() async throws {
        let result = prepared()
        let draft = LabelPhotoDraft(prepare: { _ in result })

        await draft.attach(try capture())

        XCTAssertEqual(draft.state, .attached(result))
        XCTAssertEqual(draft.photo, result.photo)
    }

    func testAFailedEncodingOffersARetake() async throws {
        let draft = LabelPhotoDraft(prepare: { _ in throw LabelPhotoEncodingError.tooLarge(bytesAtLowestQuality: 9_000_000) })

        await draft.attach(try capture())

        XCTAssertEqual(draft.state, .failed)
        XCTAssertNil(draft.photo)
    }

    func testTheDraftIsPreparingWhileTheEncodingRuns() async throws {
        let gate = PrepareGate()
        let result = prepared()
        let draft = LabelPhotoDraft(prepare: { _ in
            await gate.wait()
            return result
        })
        let shot = try capture()

        let attaching = Task { await draft.attach(shot) }
        await waitUntilPreparing(draft)
        XCTAssertNil(draft.photo)
        gate.open()
        await attaching.value

        XCTAssertEqual(draft.state, .attached(result))
    }

    func testRemoveDropsThePhoto() async throws {
        let draft = LabelPhotoDraft(prepare: { [result = prepared()] _ in result })
        await draft.attach(try capture())

        draft.remove()

        XCTAssertEqual(draft.state, .empty)
        XCTAssertNil(draft.photo)
    }

    func testRemoveWhileEncodingDropsTheLateResult() async throws {
        let gate = PrepareGate()
        let result = prepared()
        let draft = LabelPhotoDraft(prepare: { _ in
            await gate.wait()
            return result
        })
        let shot = try capture()

        let attaching = Task { await draft.attach(shot) }
        await waitUntilPreparing(draft)
        draft.remove()
        gate.open()
        await attaching.value

        XCTAssertEqual(draft.state, .empty)
    }

    func testARetakeReplacesTheEarlierPhoto() async throws {
        let first = prepared(width: 20)
        let second = prepared(width: 30)
        let results = [first, second]
        let calls = LockedCounter()
        let draft = LabelPhotoDraft(prepare: { _ in results[calls.next() % results.count] })

        await draft.attach(try capture())
        await draft.attach(try capture())

        XCTAssertEqual(draft.photo?.pixelWidth, 30)
    }

    func testTheBeanEntryHoldsALabelPhotoDraftThatStartsEmpty() throws {
        let client = APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://api.example.invalid")),
            tokenProvider: FakeTokenProvider(),
            session: APIClient.makeSession(),
            imageCache: nil
        )
        let model = BeanEntryModel(barcode: nil, client: client)

        XCTAssertEqual(model.labelPhoto.state, .empty)
    }

    // MARK: - Real preparation

    func testPrepareEncodesTheCaptureAndMakesAnUprightPreview() async throws {
        let shot = LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 1600, height: 800), orientation: .right)

        let result = try await PreparedLabelPhoto.prepare(shot)

        XCTAssertEqual(result.photo.pixelWidth, 800)
        XCTAssertEqual(result.photo.pixelHeight, 1600)
        XCTAssertEqual(Array(result.photo.data.prefix(2)), [0xFF, 0xD8])
        let preview = try XCTUnwrap(result.preview)
        XCTAssertEqual(max(preview.width, preview.height), PreparedLabelPhoto.previewPixelSize)
        XCTAssertLessThan(preview.width, preview.height, "the preview is upright")
    }

    // MARK: - Camera availability

    func testThePhotoStepIsHiddenWithoutACamera() {
        for status in [AVAuthorizationStatus.authorized, .notDetermined, .denied, .restricted] {
            XCTAssertEqual(LabelPhotoCameraAvailability.resolve(cameraPresent: false, authorization: status), .unavailable)
        }
    }

    func testThePhotoStepIsOfferedWhenAccessIsGrantedOrNotYetAsked() {
        XCTAssertEqual(LabelPhotoCameraAvailability.resolve(cameraPresent: true, authorization: .authorized), .available)
        XCTAssertEqual(LabelPhotoCameraAvailability.resolve(cameraPresent: true, authorization: .notDetermined), .available)
    }

    func testDeniedAccessOffersSettings() {
        XCTAssertEqual(LabelPhotoCameraAvailability.resolve(cameraPresent: true, authorization: .denied), .permissionDenied)
        XCTAssertEqual(LabelPhotoCameraAvailability.resolve(cameraPresent: true, authorization: .restricted), .permissionDenied)
    }

    // MARK: - UIKit orientation

    func testUIKitOrientationsMapToTheirEXIFValues() {
        let expected: [(UIImage.Orientation, UInt32)] = [
            (.up, 1), (.upMirrored, 2), (.down, 3), (.downMirrored, 4),
            (.leftMirrored, 5), (.right, 6), (.rightMirrored, 7), (.left, 8),
        ]
        for (orientation, exif) in expected {
            XCTAssertEqual(CGImagePropertyOrientation(orientation).rawValue, exif, "\(orientation.rawValue)")
        }
    }

    func testACameraImageBecomesACaptureWithItsOrientation() throws {
        let cgImage = try LabelPhotoEncoderTests.quadrantImage(width: 40, height: 20)
        let image = UIImage(cgImage: cgImage, scale: 1, orientation: .right)

        let shot = try XCTUnwrap(LabelPhotoCapture(image))

        XCTAssertEqual(shot.orientation, .right)
        XCTAssertEqual(shot.image.width, 40)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.withLock {
            defer { value += 1 }
            return value
        }
    }
}
