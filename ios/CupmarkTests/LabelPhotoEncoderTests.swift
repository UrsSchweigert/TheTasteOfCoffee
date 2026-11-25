import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Cupmark

/// `LabelPhotoEncoder` (M2-T23, ADR 0016, D12). Every image is drawn in code.
final class LabelPhotoEncoderTests: XCTestCase {
    private let eightMiB = 8 * 1024 * 1024

    // MARK: - Size

    func testATwelveMegapixelCaptureKeepsItsSize() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 4032, height: 3024), orientation: .up)

        XCTAssertEqual(photo.pixelWidth, 4032)
        XCTAssertEqual(photo.pixelHeight, 3024)
        let decoded = try Self.decode(photo.data)
        XCTAssertEqual(decoded.width, 4032)
        XCTAssertEqual(decoded.height, 3024)
    }

    func testALargerImageIsScaledTo4096OnItsLongestSide() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 5000, height: 3000), orientation: .up)

        XCTAssertEqual(photo.pixelWidth, 4096)
        XCTAssertEqual(photo.pixelHeight, 2458) // 3000 × 4096 / 5000 = 2457.6
        let decoded = try Self.decode(photo.data)
        XCTAssertEqual(decoded.width, 4096)
        XCTAssertEqual(decoded.height, 2458)
    }

    func testOutputSizeSwapsForATurnedOrientationAndNeverScalesUp() {
        let scaled = LabelPhotoEncoder.outputSize(width: 3000, height: 5000, orientation: .right, maxPixelSize: 4096)
        XCTAssertEqual(scaled.width, 4096)
        XCTAssertEqual(scaled.height, 2458)

        let small = LabelPhotoEncoder.outputSize(width: 300, height: 200, orientation: .left, maxPixelSize: 4096)
        XCTAssertEqual(small.width, 200)
        XCTAssertEqual(small.height, 300)

        let square = LabelPhotoEncoder.outputSize(width: 8192, height: 8192, orientation: .up, maxPixelSize: 4096)
        XCTAssertEqual(square.width, 4096)
        XCTAssertEqual(square.height, 4096)

        let sliver = LabelPhotoEncoder.outputSize(width: 100_000, height: 1, orientation: .up, maxPixelSize: 4096)
        XCTAssertEqual(sliver.width, 4096)
        XCTAssertEqual(sliver.height, 1)
    }

    // MARK: - File

    func testTheOutputIsAJPEGOfAtMostEightMiB() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 4032, height: 3024), orientation: .up)

        XCTAssertEqual(Array(photo.data.prefix(2)), [0xFF, 0xD8])
        XCTAssertEqual(Array(photo.data.suffix(2)), [0xFF, 0xD9])
        XCTAssertLessThanOrEqual(photo.data.count, eightMiB)
        XCTAssertEqual(photo.quality, LabelPhotoEncoder.Limits.upload.qualities.first)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
    }

    /// The shape `backend/src/images/jpeg.ts` accepts at completion: one SOF0 (baseline), 8-bit,
    /// 3 components with sampling 1 to 4 and table ids 0 to 3, at most 4096 px a side, well-formed
    /// DQT, DHT and SOS, EOI at the end, and no APPn other than APP0 and APP14, no COM.
    func testTheOutputHasTheShapeTheServerAccepts() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 5000, height: 3000), orientation: .up)
        let shape = try JPEGShape(photo.data)

        XCTAssertEqual(shape.frameMarkers, [0xC0], "exactly one baseline frame")
        XCTAssertEqual(shape.precision, 8)
        XCTAssertEqual(shape.width, 4096)
        XCTAssertEqual(shape.height, 2458)
        XCTAssertEqual(shape.components, 3)
        XCTAssertTrue(shape.samplingAndTablesValid)
        XCTAssertTrue(shape.tablesValid, "DQT or DHT is malformed")
        XCTAssertGreaterThanOrEqual(shape.scanCount, 1)
        XCTAssertTrue(shape.endsWithEOI)
        XCTAssertEqual(shape.metadataMarkers, [], "metadata segments are left")
    }

    // MARK: - Metadata

    func testNoEXIFGPSOrTIFFSurvivesFromACameraStyleInput() throws {
        let input = try Self.jpegWithMetadata(try Self.quadrantImage(width: 400, height: 200), orientation: 6)
        // The fixture really carries all of it, so the assertions below mean something.
        let inputProperties = try Self.properties(of: input)
        XCTAssertNotNil(inputProperties[kCGImagePropertyExifDictionary as String])
        XCTAssertNotNil(inputProperties[kCGImagePropertyGPSDictionary as String])
        XCTAssertNotNil(inputProperties[kCGImagePropertyTIFFDictionary as String])

        let photo = try LabelPhotoEncoder.encode(input)

        try Self.assertNoMetadata(in: photo.data)
    }

    func testNoXMPSurvives() throws {
        let input = try Self.jpegWithXMP(try Self.quadrantImage(width: 400, height: 200))
        XCTAssertTrue(Self.hasXMPCreatorTool(input), "the fixture has its XMP packet")

        let photo = try LabelPhotoEncoder.encode(input)

        try Self.assertNoMetadata(in: photo.data)
    }

    /// The encoder's own output, from drawn pixels, carries none either: whatever ImageIO adds
    /// when it writes (an orientation in APP1, an ICC profile in APP2) is cut.
    func testTheEncodersOwnOutputCarriesNoMetadata() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 640, height: 480), orientation: .right)

        try Self.assertNoMetadata(in: photo.data)
    }

    static func assertNoMetadata(in jpeg: Data, line: UInt = #line) throws {
        let found = try Self.properties(of: jpeg)
        XCTAssertNil(found[kCGImagePropertyExifDictionary as String], "EXIF", line: line)
        XCTAssertNil(found[kCGImagePropertyGPSDictionary as String], "GPS", line: line)
        XCTAssertNil(found[kCGImagePropertyTIFFDictionary as String], "TIFF", line: line)
        XCTAssertNil(found[kCGImagePropertyIPTCDictionary as String], "IPTC", line: line)
        XCTAssertNil(found[kCGImagePropertyExifAuxDictionary as String], "EXIF aux", line: line)
        XCTAssertNil(found[kCGImagePropertyMakerAppleDictionary as String], "Apple maker note", line: line)
        let orientation = (found[kCGImagePropertyOrientation as String] as? NSNumber)?.intValue
        XCTAssertTrue(orientation == nil || orientation == 1, "orientation \(String(describing: orientation))", line: line)
        XCTAssertFalse(Self.hasXMPCreatorTool(jpeg), "XMP", line: line)
        XCTAssertEqual(try JPEGShape(jpeg).metadataMarkers, [], "metadata segments", line: line)
        XCTAssertNil(jpeg.range(of: Data("Exif".utf8)), "an EXIF header is left in the bytes", line: line)
        XCTAssertNil(jpeg.range(of: Data("http://ns.adobe.com/xap/1.0/".utf8)), "an XMP header is left in the bytes", line: line)
        XCTAssertNil(jpeg.range(of: Data("Cupmark probe".utf8)), "a metadata value is left in the bytes", line: line)
    }

    func testTheScrubDropsAPP1ToAPP13APP15AndCOMAndKeepsTheRest() throws {
        let input = try Self.jpegWithMetadata(try Self.quadrantImage(width: 64, height: 64), orientation: 1)
        XCTAssertFalse(try JPEGShape(input).metadataMarkers.isEmpty, "the fixture has metadata segments")

        let clean = try XCTUnwrap(LabelPhotoEncoder.removingMetadataSegments(fromJPEG: input))

        let shape = try JPEGShape(clean)
        XCTAssertEqual(shape.metadataMarkers, [])
        XCTAssertEqual(shape.width, 64)
        XCTAssertTrue(shape.endsWithEOI)
        XCTAssertEqual(try Self.decode(clean).width, 64)
        XCTAssertTrue(LabelPhotoEncoder.isMetadataMarker(0xE1))
        XCTAssertTrue(LabelPhotoEncoder.isMetadataMarker(0xE2))
        XCTAssertTrue(LabelPhotoEncoder.isMetadataMarker(0xED))
        XCTAssertTrue(LabelPhotoEncoder.isMetadataMarker(0xEF))
        XCTAssertTrue(LabelPhotoEncoder.isMetadataMarker(0xFE))
        XCTAssertFalse(LabelPhotoEncoder.isMetadataMarker(0xE0))
        XCTAssertFalse(LabelPhotoEncoder.isMetadataMarker(0xEE))
        XCTAssertFalse(LabelPhotoEncoder.isMetadataMarker(0xDB))
    }

    func testTheScrubRefusesWhatIsNotAJPEGHeader() {
        XCTAssertNil(LabelPhotoEncoder.removingMetadataSegments(fromJPEG: Data()))
        XCTAssertNil(LabelPhotoEncoder.removingMetadataSegments(fromJPEG: Data([0x89, 0x50, 0x4E, 0x47])))
        // A segment length running past the end.
        XCTAssertNil(LabelPhotoEncoder.removingMetadataSegments(fromJPEG: Data([0xFF, 0xD8, 0xFF, 0xE1, 0x10, 0x00, 0x00])))
        // EOI before any scan.
        XCTAssertNil(LabelPhotoEncoder.removingMetadataSegments(fromJPEG: Data([0xFF, 0xD8, 0xFF, 0xD9, 0x00, 0x00])))
    }

    func testUnreadableDataIsAClearError() {
        XCTAssertThrowsError(try LabelPhotoEncoder.encode(Data("not an image".utf8))) { error in
            XCTAssertEqual(error as? LabelPhotoEncodingError, .unreadableImage)
        }
    }

    // MARK: - Orientation

    func testOrientationUpKeepsTheCornerWhereItIs() throws {
        // Also checks the pixel helper's row order: without it, a flipped helper could make
        // the turned cases below pass for the wrong reason.
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 400, height: 200), orientation: .up)

        XCTAssertEqual(photo.pixelWidth, 400)
        XCTAssertEqual(photo.pixelHeight, 200)
        try Self.assertRed(in: photo.data, at: (0.25, 0.25))
        try Self.assertBlue(in: photo.data, at: (0.75, 0.25))
        try Self.assertBlue(in: photo.data, at: (0.25, 0.75))
    }

    func testOrientationSixIsTurnedClockwise() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 400, height: 200), orientation: .right)

        XCTAssertEqual(photo.pixelWidth, 200)
        XCTAssertEqual(photo.pixelHeight, 400)
        let decoded = try Self.decode(photo.data)
        XCTAssertEqual(decoded.width, 200)
        XCTAssertEqual(decoded.height, 400)
        // The stored top-left corner is shown at the top right.
        try Self.assertRed(in: photo.data, at: (0.75, 0.25))
        try Self.assertBlue(in: photo.data, at: (0.25, 0.25))
        try Self.assertBlue(in: photo.data, at: (0.75, 0.75))
    }

    func testOrientationSixFromTheFilesPropertiesIsTurnedToo() throws {
        let input = try Self.jpegWithMetadata(try Self.quadrantImage(width: 400, height: 200), orientation: 6)

        let photo = try LabelPhotoEncoder.encode(input)

        XCTAssertEqual(photo.pixelWidth, 200)
        XCTAssertEqual(photo.pixelHeight, 400)
        try Self.assertRed(in: photo.data, at: (0.75, 0.25))
        try Self.assertBlue(in: photo.data, at: (0.25, 0.25))
    }

    func testOrientationEightIsTurnedCounterclockwise() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 400, height: 200), orientation: .left)

        XCTAssertEqual(photo.pixelWidth, 200)
        XCTAssertEqual(photo.pixelHeight, 400)
        try Self.assertRed(in: photo.data, at: (0.25, 0.75))
        try Self.assertBlue(in: photo.data, at: (0.25, 0.25))
    }

    func testOrientationThreeIsTurnedHalfway() throws {
        let photo = try LabelPhotoEncoder.encode(try Self.quadrantImage(width: 400, height: 200), orientation: .down)

        XCTAssertEqual(photo.pixelWidth, 400)
        XCTAssertEqual(photo.pixelHeight, 200)
        try Self.assertRed(in: photo.data, at: (0.75, 0.75))
        try Self.assertBlue(in: photo.data, at: (0.25, 0.25))
    }

    func testMirroredOrientationsMoveTheCornerAsEXIFDefines() throws {
        let image = try Self.quadrantImage(width: 400, height: 200)
        // 2: mirrored left to right; the stored top-left is shown top-right.
        try Self.assertRed(in: try LabelPhotoEncoder.encode(image, orientation: .upMirrored).data, at: (0.75, 0.25))
        // 4: mirrored top to bottom; shown bottom-left.
        try Self.assertRed(in: try LabelPhotoEncoder.encode(image, orientation: .downMirrored).data, at: (0.25, 0.75))
        // 5: transposed; stays top-left, on a 200 × 400 picture.
        let transposed = try LabelPhotoEncoder.encode(image, orientation: .leftMirrored)
        XCTAssertEqual(transposed.pixelWidth, 200)
        try Self.assertRed(in: transposed.data, at: (0.25, 0.25))
        try Self.assertBlue(in: transposed.data, at: (0.75, 0.25))
        // 7: transversed; shown bottom-right.
        try Self.assertRed(in: try LabelPhotoEncoder.encode(image, orientation: .rightMirrored).data, at: (0.75, 0.75))
    }

    // MARK: - Quality loop

    func testTheQualityStepsDownUntilTheFileFits() throws {
        let image = try Self.noiseImage(width: 512, height: 512, seed: 7)
        let highest = try XCTUnwrap(LabelPhotoEncoder.Limits.upload.qualities.first)
        let unlimited = LabelPhotoEncoder.Limits(maxPixelSize: 4096, maxBytes: .max, qualities: [highest])
        let atHighest = try LabelPhotoEncoder.encode(image, orientation: .up, limits: unlimited)

        var limits = LabelPhotoEncoder.Limits.upload
        limits.maxBytes = atHighest.data.count - 1
        let photo = try LabelPhotoEncoder.encode(image, orientation: .up, limits: limits)

        XCTAssertLessThan(photo.quality, highest)
        XCTAssertLessThanOrEqual(photo.data.count, limits.maxBytes)
        XCTAssertEqual(Array(photo.data.prefix(2)), [0xFF, 0xD8])
    }

    func testTheFloorIsAClearError() throws {
        let image = try Self.noiseImage(width: 256, height: 256, seed: 11)
        var limits = LabelPhotoEncoder.Limits.upload
        limits.maxBytes = 100

        XCTAssertThrowsError(try LabelPhotoEncoder.encode(image, orientation: .up, limits: limits)) { error in
            guard case .tooLarge(let bytes) = error as? LabelPhotoEncodingError else {
                return XCTFail("expected tooLarge, got \(error)")
            }
            XCTAssertGreaterThan(bytes, 100)
        }
    }

    /// Noise in every pixel and channel is close to the worst case for JPEG: at the highest
    /// quality this 4096 × 4096 picture is above 8 MiB, so the loop has to step down to fit.
    func testALargeNoisyImageIsBroughtUnderEightMiB() throws {
        let image = try Self.noiseImage(width: 4096, height: 4096, seed: 42)

        let photo = try LabelPhotoEncoder.encode(image, orientation: .up)

        XCTAssertLessThanOrEqual(photo.data.count, eightMiB)
        XCTAssertLessThan(photo.quality, try XCTUnwrap(LabelPhotoEncoder.Limits.upload.qualities.first), "the loop never stepped down")
        XCTAssertEqual(photo.pixelWidth, 4096)
        XCTAssertEqual(try JPEGShape(photo.data).frameMarkers, [0xC0])
    }

    // MARK: - Fixtures

    /// Blue, with the stored top-left quadrant red.
    static func quadrantImage(width: Int, height: Int) throws -> CGImage {
        let context = try bitmap(width: width, height: height)
        context.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
        // CoreGraphics' origin is the bottom left: the top half is y from height / 2 up.
        context.fill(CGRect(x: 0, y: height / 2, width: width / 2, height: height - height / 2))
        return try XCTUnwrap(context.makeImage())
    }

    /// Grey with noise of ±64 in every pixel and channel, from a seeded xorshift generator, so
    /// the picture is the same on each run. Calibrated with libjpeg on a 4096 × 4096 picture:
    /// above 8 MiB at quality 90 (10.7 MiB with 4:2:0 chroma, 22.4 MiB with 4:4:4), below it from
    /// quality 40 (3.2 and 5.1 MiB), so the loop must step down and can still fit whichever
    /// subsampling and quality scale ImageIO uses. Uniform noise over 0 to 255 could miss the
    /// floor with 4:4:4 (9 MiB at quality 30), which no camera picture comes near.
    static func noiseImage(width: Int, height: Int, seed: UInt64) throws -> CGImage {
        let context = try bitmap(width: width, height: height)
        let data = try XCTUnwrap(context.data)
        let words = context.bytesPerRow * height / 8
        let pointer = data.bindMemory(to: UInt64.self, capacity: words)
        var state = seed | 1
        for index in 0..<words {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            // Each byte 64 to 191: the random byte halved, plus 64.
            pointer[index] = ((state >> 1) & 0x7F7F_7F7F_7F7F_7F7F) + 0x4040_4040_4040_4040
        }
        return try XCTUnwrap(context.makeImage())
    }

    static func bitmap(width: Int, height: Int) throws -> CGContext {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        return try XCTUnwrap(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ))
    }

    /// A JPEG of `image` with an orientation tag and EXIF, GPS and TIFF dictionaries, as a
    /// camera would write them.
    static func jpegWithMetadata(_ image: CGImage, orientation: Int) throws -> Data {
        let properties: [String: Any] = [
            kCGImagePropertyOrientation as String: orientation,
            kCGImagePropertyExifDictionary as String: [
                kCGImagePropertyExifDateTimeOriginal as String: "2026:11:25 08:30:00",
                kCGImagePropertyExifUserComment as String: "Cupmark probe",
            ],
            kCGImagePropertyGPSDictionary as String: [
                kCGImagePropertyGPSLatitude as String: 52.52,
                kCGImagePropertyGPSLatitudeRef as String: "N",
                kCGImagePropertyGPSLongitude as String: 13.405,
                kCGImagePropertyGPSLongitudeRef as String: "E",
            ],
            kCGImagePropertyTIFFDictionary as String: [
                kCGImagePropertyTIFFMake as String: "Cupmark probe",
                kCGImagePropertyTIFFModel as String: "Cupmark probe",
            ],
        ]
        return try writeJPEG { destination in
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        }
    }

    /// A JPEG of `image` with an XMP packet (`xmp:CreatorTool`).
    static func jpegWithXMP(_ image: CGImage) throws -> Data {
        let metadata = CGImageMetadataCreateMutable()
        XCTAssertTrue(CGImageMetadataSetValueWithPath(metadata, nil, "xmp:CreatorTool" as CFString, "Cupmark probe" as CFString))
        return try writeJPEG { destination in
            CGImageDestinationAddImageAndMetadata(destination, image, metadata, nil)
        }
    }

    private static func writeJPEG(add: (CGImageDestination) -> Void) throws -> Data {
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            output as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ))
        add(destination)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return Data(referencing: output)
    }

    static func properties(of jpeg: Data) throws -> [String: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
    }

    static func hasXMPCreatorTool(_ jpeg: Data) -> Bool {
        guard
            let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
            let metadata = CGImageSourceCopyMetadataAtIndex(source, 0, nil)
        else {
            return false
        }
        return CGImageMetadataCopyTagWithPath(metadata, nil, "xmp:CreatorTool" as CFString) != nil
    }

    static func decode(_ jpeg: Data) throws -> CGImage {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }

    /// The colour at a point given as fractions of the width and of the height from the top.
    static func pixel(in jpeg: Data, at point: (x: Double, y: Double)) throws -> (red: UInt8, green: UInt8, blue: UInt8) {
        let image = try decode(jpeg)
        let context = try bitmap(width: image.width, height: image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let data = try XCTUnwrap(context.data)
        // A bitmap context's first row in memory is the top of the picture.
        let column = min(image.width - 1, Int(Double(image.width) * point.x))
        let row = min(image.height - 1, Int(Double(image.height) * point.y))
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let offset = row * context.bytesPerRow + column * 4
        return (bytes[offset], bytes[offset + 1], bytes[offset + 2])
    }

    static func assertRed(in jpeg: Data, at point: (x: Double, y: Double), line: UInt = #line) throws {
        let colour = try pixel(in: jpeg, at: point)
        XCTAssertTrue(colour.red > 180 && colour.green < 80 && colour.blue < 80, "expected red at \(point), got \(colour)", line: line)
    }

    static func assertBlue(in jpeg: Data, at point: (x: Double, y: Double), line: UInt = #line) throws {
        let colour = try pixel(in: jpeg, at: point)
        XCTAssertTrue(colour.blue > 180 && colour.red < 80 && colour.green < 80, "expected blue at \(point), got \(colour)", line: line)
    }
}

/// The marker structure of a JPEG, checked with the rules of `backend/src/images/jpeg.ts`
/// (`validFrame`, `validQuantisationTables`, `validHuffmanTables`, `validScanHeader`).
private struct JPEGShape {
    struct Malformed: Error {}

    var frameMarkers: [UInt8] = []
    var metadataMarkers: [UInt8] = []
    var precision = 0
    var width = 0
    var height = 0
    var components = 0
    var samplingAndTablesValid = false
    var tablesValid = true
    var scanCount = 0
    var endsWithEOI = false

    init(_ data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8 else { throw Malformed() }
        endsWithEOI = bytes[bytes.count - 2] == 0xFF && bytes[bytes.count - 1] == 0xD9
        var position = 2
        while position < bytes.count {
            guard bytes[position] == 0xFF else { throw Malformed() }
            while position < bytes.count, bytes[position] == 0xFF {
                position += 1
            }
            guard position < bytes.count else { throw Malformed() }
            let marker = bytes[position]
            position += 1
            if marker == 0xD9 { return }
            guard position + 1 < bytes.count else { throw Malformed() }
            let length = Int(bytes[position]) << 8 | Int(bytes[position + 1])
            guard length >= 2, position + length <= bytes.count else { throw Malformed() }
            let payload = Array(bytes[(position + 2)..<(position + length)])
            position += length

            switch marker {
            case 0xC0...0xC3, 0xC5...0xC7, 0xC9...0xCB, 0xCD...0xCF:
                frameMarkers.append(marker)
                readFrame(payload)
            case 0xDB:
                tablesValid = tablesValid && Self.validQuantisationTables(payload)
            case 0xC4:
                tablesValid = tablesValid && Self.validHuffmanTables(payload)
            case 0xE1...0xED, 0xEF, 0xFE:
                metadataMarkers.append(marker)
            case 0xDA:
                let count = payload.first.map { Int($0) } ?? 0
                guard (1...4).contains(count), payload.count == 1 + 2 * count + 3 else { throw Malformed() }
                scanCount += 1
                position = Self.endOfEntropyData(bytes, from: position)
            default:
                break
            }
        }
    }

    private mutating func readFrame(_ payload: [UInt8]) {
        guard payload.count >= 6 else { return }
        precision = Int(payload[0])
        height = Int(payload[1]) << 8 | Int(payload[2])
        width = Int(payload[3]) << 8 | Int(payload[4])
        components = Int(payload[5])
        guard payload.count == 6 + 3 * components else { return }
        samplingAndTablesValid = (0..<components).allSatisfy { c in
            let sampling = payload[7 + 3 * c]
            let h = sampling >> 4
            let v = sampling & 0x0F
            return (1...4).contains(h) && (1...4).contains(v) && payload[8 + 3 * c] <= 3
        }
    }

    private static func validQuantisationTables(_ payload: [UInt8]) -> Bool {
        guard !payload.isEmpty else { return false }
        var i = 0
        while i < payload.count {
            let precision = Int(payload[i] >> 4)
            guard precision <= 1, payload[i] & 0x0F <= 3 else { return false }
            i += 1 + 64 * (precision + 1)
        }
        return i == payload.count
    }

    private static func validHuffmanTables(_ payload: [UInt8]) -> Bool {
        guard !payload.isEmpty else { return false }
        var i = 0
        while i < payload.count {
            guard payload[i] >> 4 <= 1, payload[i] & 0x0F <= 3, i + 17 <= payload.count else { return false }
            let codes = payload[(i + 1)...(i + 16)].reduce(0) { $0 + Int($1) }
            guard codes <= 256 else { return false }
            i += 17 + codes
        }
        return i == payload.count
    }

    /// The index of the marker after the entropy-coded data that starts at `from`.
    private static func endOfEntropyData(_ bytes: [UInt8], from: Int) -> Int {
        var i = from
        while i + 1 < bytes.count {
            if bytes[i] == 0xFF {
                let next = bytes[i + 1]
                if next == 0x00 || (0xD0...0xD7).contains(next) {
                    i += 2
                    continue
                }
                return i
            }
            i += 1
        }
        return bytes.count
    }
}
