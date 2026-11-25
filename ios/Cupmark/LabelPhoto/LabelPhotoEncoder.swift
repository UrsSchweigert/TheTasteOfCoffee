import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A label photo ready for upload (M2-T23, ADR 0016): a baseline JPEG with no metadata.
struct EncodedLabelPhoto: Sendable, Equatable {
    /// The JPEG file, starting with `FF D8`.
    let data: Data
    /// The upright size in pixels, after orientation and downscaling.
    let pixelWidth: Int
    let pixelHeight: Int
    /// The `kCGImageDestinationLossyCompressionQuality` the file was written with.
    let quality: Double
}

/// Why a capture could not be turned into an upload.
enum LabelPhotoEncodingError: Error, Equatable, Sendable {
    /// The data is not an image ImageIO can read.
    case unreadableImage
    /// The bitmap context for the upright, downscaled pixels could not be made.
    case renderingFailed
    /// ImageIO did not write a JPEG, or wrote one this file cannot parse.
    case encodingFailed
    /// Even the lowest quality step is larger than the limit. Carries that smallest size.
    case tooLarge(bytesAtLowestQuality: Int)
}

/// Turns a camera capture into the JPEG the label photo upload accepts (ADR 0016, D12):
///
/// - the orientation is applied to the pixels, so the result is upright without a tag;
/// - the longest side is at most `Limits.maxPixelSize` (4096), never scaled up;
/// - a baseline (sequential, Huffman) 8-bit JPEG with three components (sRGB) is written
///   through ImageIO, starting at the highest quality step and stepping down until the file
///   is at most `Limits.maxBytes` (8 MiB); below the lowest step it fails with `.tooLarge`;
/// - no metadata: the pixels are redrawn into a fresh bitmap, so nothing of the input's
///   EXIF, GPS, TIFF or XMP reaches ImageIO, and the only properties written are the quality,
///   the orientation 1 and JFIF "not progressive". ImageIO may still add segments of its own
///   (an APP1 holding the orientation, an APP2 ICC profile), so the written file is then
///   cut down to SOI, APP0 (JFIF), APP14 (Adobe) and the image segments, which is also the
///   shape `backend/src/images/jpeg.ts` accepts. The server strips again at completion (D12).
///
/// Pure: ImageIO and CoreGraphics only, no UIKit, no state. Safe to call off the main actor;
/// a 12-megapixel capture takes a fraction of a second.
enum LabelPhotoEncoder {
    struct Limits: Sendable, Equatable {
        /// The longest side in pixels.
        var maxPixelSize: Int
        /// The largest file in bytes.
        var maxBytes: Int
        /// The qualities tried, highest first. The last one is the floor.
        var qualities: [Double]

        /// ADR 0016: 4096 px a side, 8 MiB, the server's own limits.
        static let upload = Limits(
            maxPixelSize: 4096,
            maxBytes: 8 * 1024 * 1024,
            qualities: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]
        )
    }

    // MARK: - Entry points

    /// Encodes an image file (a HEIC or JPEG capture, for example). The orientation is read
    /// from the file's properties; nothing else of them is used.
    static func encode(_ data: Data, limits: Limits = .upload) throws -> EncodedLabelPhoto {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard
            let source = CGImageSourceCreateWithData(data as CFData, options),
            CGImageSourceGetCount(source) > 0,
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw LabelPhotoEncodingError.unreadableImage
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        let rawOrientation = (properties?[kCGImagePropertyOrientation as String] as? NSNumber)?.uint32Value ?? 1
        let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
        return try encode(image, orientation: orientation, limits: limits)
    }

    /// Encodes decoded pixels whose intended display orientation is `orientation` (as EXIF
    /// defines it: `.right`, 6, means the pixels must be turned 90° clockwise to be upright).
    static func encode(
        _ image: CGImage,
        orientation: CGImagePropertyOrientation,
        limits: Limits = .upload
    ) throws -> EncodedLabelPhoto {
        guard !limits.qualities.isEmpty, limits.maxPixelSize > 0 else {
            throw LabelPhotoEncodingError.encodingFailed
        }
        let size = outputSize(
            width: image.width,
            height: image.height,
            orientation: orientation,
            maxPixelSize: limits.maxPixelSize
        )
        let upright = try render(image, orientation: orientation, width: size.width, height: size.height)

        var smallest = Int.max
        for quality in limits.qualities {
            let written = try writeJPEG(upright, quality: quality)
            guard let clean = removingMetadataSegments(fromJPEG: written) else {
                throw LabelPhotoEncodingError.encodingFailed
            }
            if clean.count <= limits.maxBytes {
                return EncodedLabelPhoto(data: clean, pixelWidth: size.width, pixelHeight: size.height, quality: quality)
            }
            smallest = min(smallest, clean.count)
        }
        throw LabelPhotoEncodingError.tooLarge(bytesAtLowestQuality: smallest)
    }

    // MARK: - Geometry

    /// Whether `orientation` turns the picture by 90°, so width and height swap.
    static func swapsAxes(_ orientation: CGImagePropertyOrientation) -> Bool {
        switch orientation {
        case .up, .upMirrored, .down, .downMirrored: false
        case .leftMirrored, .right, .rightMirrored, .left: true
        }
    }

    /// The upright output size for a `width` × `height` input: axes swapped if the orientation
    /// turns the picture, then scaled down (never up) so the longest side is `maxPixelSize`.
    /// Each side is at least 1 and at most `maxPixelSize`.
    static func outputSize(
        width: Int,
        height: Int,
        orientation: CGImagePropertyOrientation,
        maxPixelSize: Int
    ) -> (width: Int, height: Int) {
        let swaps = swapsAxes(orientation)
        let uprightWidth = max(1, swaps ? height : width)
        let uprightHeight = max(1, swaps ? width : height)
        let longest = max(uprightWidth, uprightHeight)
        guard longest > maxPixelSize else { return (uprightWidth, uprightHeight) }
        let scale = Double(maxPixelSize) / Double(longest)
        func scaled(_ side: Int) -> Int {
            min(maxPixelSize, max(1, Int((Double(side) * scale).rounded())))
        }
        return (scaled(uprightWidth), scaled(uprightHeight))
    }

    /// The transform that maps the stored pixels, drawn into `(0, 0, w, h)` with `w` × `h` the
    /// stored size scaled, onto the upright `width` × `height` canvas. CoreGraphics coordinates:
    /// origin at the bottom left, y up. Maps `(x, y)` to `(a·x + c·y + tx, b·x + d·y + ty)`.
    static func orientationTransform(
        _ orientation: CGImagePropertyOrientation,
        width: CGFloat,
        height: CGFloat
    ) -> CGAffineTransform {
        switch orientation {
        case .up:
            // 1: as stored.
            CGAffineTransform.identity
        case .upMirrored:
            // 2: mirrored left to right.
            CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: width, ty: 0)
        case .down:
            // 3: turned 180°.
            CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: width, ty: height)
        case .downMirrored:
            // 4: mirrored top to bottom.
            CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: height)
        case .leftMirrored:
            // 5: transposed; the stored top-left stays top-left.
            CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: width, ty: height)
        case .right:
            // 6: turned 90° clockwise; the stored top-left goes to the top-right.
            CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: height)
        case .rightMirrored:
            // 7: transversed; the stored top-left goes to the bottom-right.
            CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0)
        case .left:
            // 8: turned 90° counterclockwise; the stored top-left goes to the bottom-left.
            CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: width, ty: 0)
        }
    }

    // MARK: - Pixels

    /// Draws `image` upright into a new `width` × `height` sRGB bitmap with no alpha, over
    /// white, so a transparent input does not turn black. A Display P3 capture is converted
    /// to sRGB here, which is what a decoder assumes once the server has dropped every ICC
    /// profile.
    private static func render(
        _ image: CGImage,
        orientation: CGImagePropertyOrientation,
        width: Int,
        height: Int
    ) throws -> CGImage {
        guard
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
            )
        else {
            throw LabelPhotoEncodingError.renderingFailed
        }
        let canvas = CGRect(x: 0, y: 0, width: width, height: height)
        context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.fill(canvas)
        context.interpolationQuality = .high
        context.concatenate(orientationTransform(orientation, width: canvas.width, height: canvas.height))
        // The stored picture, scaled: for a turned orientation its width is the canvas height.
        let swaps = swapsAxes(orientation)
        let drawn = CGRect(
            x: 0,
            y: 0,
            width: swaps ? canvas.height : canvas.width,
            height: swaps ? canvas.width : canvas.height
        )
        context.draw(image, in: drawn)
        guard let upright = context.makeImage() else {
            throw LabelPhotoEncodingError.renderingFailed
        }
        return upright
    }

    // MARK: - JPEG

    /// One ImageIO JPEG at `quality`. The properties are only the quality, orientation 1 and
    /// "not progressive"; no EXIF, GPS, TIFF or XMP dictionary is passed.
    private static func writeJPEG(_ image: CGImage, quality: Double) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw LabelPhotoEncodingError.encodingFailed
        }
        let jfif: [String: Any] = [kCGImagePropertyJFIFIsProgressive as String: false]
        let properties: [String: Any] = [
            kCGImageDestinationLossyCompressionQuality as String: quality,
            kCGImagePropertyOrientation as String: 1,
            kCGImagePropertyJFIFDictionary as String: jfif,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw LabelPhotoEncodingError.encodingFailed
        }
        return Data(referencing: output)
    }

    /// Whether a marker is a metadata segment: APP1 to APP13 and APP15 (EXIF with TIFF and
    /// GPS, XMP, ICC, MPF, IPTC, ...) and COM. APP0 (JFIF) and APP14 (Adobe colour transform)
    /// are kept: they tell a decoder how to read the components, and the server keeps
    /// canonical copies of them too.
    static func isMetadataMarker(_ marker: UInt8) -> Bool {
        (0xE1...0xED).contains(marker) || marker == 0xEF || marker == 0xFE
    }

    /// `jpeg` without its metadata segments (see `isMetadataMarker`). Everything from the first
    /// SOS on (the entropy-coded data, and for a baseline file EOI) is copied as is. Nil if
    /// the header is not a well-formed marker sequence: SOI, then segments with a length that
    /// stays inside the data, then SOS.
    static func removingMetadataSegments(fromJPEG jpeg: Data) -> Data? {
        let bytes = [UInt8](jpeg)
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8 else { return nil }
        var output = Data([0xFF, 0xD8])
        output.reserveCapacity(bytes.count)
        var position = 2
        while position < bytes.count {
            guard bytes[position] == 0xFF else { return nil }
            // Fill bytes: any number of 0xFF before the marker byte.
            var markerIndex = position
            while markerIndex < bytes.count, bytes[markerIndex] == 0xFF {
                markerIndex += 1
            }
            guard markerIndex + 2 < bytes.count else { return nil }
            let marker = bytes[markerIndex]
            // Markers without a length (TEM, RSTn, SOI, EOI) or a stuffed 0x00 do not belong
            // in a header.
            if marker == 0x00 || marker == 0x01 || (0xD0...0xD9).contains(marker) {
                return nil
            }
            let length = Int(bytes[markerIndex + 1]) << 8 | Int(bytes[markerIndex + 2])
            let end = markerIndex + 1 + length
            guard length >= 2, end <= bytes.count else { return nil }
            if marker == 0xDA {
                output.append(0xFF)
                output.append(contentsOf: bytes[markerIndex...])
                return output
            }
            if !isMetadataMarker(marker) {
                output.append(0xFF)
                output.append(contentsOf: bytes[markerIndex..<end])
            }
            position = end
        }
        return nil
    }
}
