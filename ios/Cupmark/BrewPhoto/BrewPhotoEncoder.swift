import CoreGraphics
import Foundation
import ImageIO

/// The limits of brew photos (M2-T42, ADR 0033).
enum BrewPhotoLimits {
    /// A brew holds at most this many photos. Adding one more is refused
    /// (`BrewPhotoError.limitReached`) before any file is written.
    static let maxPerBrew = 6

    /// The encoder limits of a brew photo: smaller than the upload limits of a label photo
    /// (`LabelPhotoEncoder.Limits.upload`, 4096 px and 8 MiB), since a brew photo is only shown
    /// on the phone and is kept on it, up to 6 per brew. 2048 px on the longest side is more
    /// than a phone screen's width in pixels; 2 MiB keeps a full brew under 12 MiB.
    static let encoding = LabelPhotoEncoder.Limits(
        maxPixelSize: 2048,
        maxBytes: 2 * 1024 * 1024,
        qualities: [0.85, 0.75, 0.65, 0.55, 0.45]
    )
}

/// A brew photo ready to be stored: a baseline JPEG with no metadata, made by
/// `BrewPhotoEncoder` only, so the store never writes a file that was not stripped.
struct EncodedBrewPhoto: Sendable, Equatable {
    /// The JPEG file, starting with `FF D8`.
    let data: Data
    /// The upright size in pixels.
    let pixelWidth: Int
    let pixelHeight: Int

    /// Only the encoder below makes one.
    fileprivate init(_ encoded: EncodedLabelPhoto) {
        data = encoded.data
        pixelWidth = encoded.pixelWidth
        pixelHeight = encoded.pixelHeight
    }
}

/// Turns a camera capture or a picked image into a brew photo (M2-T42, ADR 0033) by reusing
/// `LabelPhotoEncoder` with `BrewPhotoLimits.encoding`: the orientation is applied to the
/// pixels, the pixels are redrawn into a fresh bitmap, and only SOI, APP0 (JFIF), APP14 (Adobe)
/// and the image segments are kept, so no EXIF, GPS, TIFF or XMP of the input is stored.
///
/// Errors are `LabelPhotoEncodingError` (unreadable image, too large, ...).
enum BrewPhotoEncoder {
    /// Encodes an image file (HEIC, JPEG, PNG, ...). Synchronous: call it off the main actor,
    /// or use `encodeInBackground(_:)`.
    static func encode(_ imageData: Data) throws -> EncodedBrewPhoto {
        EncodedBrewPhoto(try LabelPhotoEncoder.encode(imageData, limits: BrewPhotoLimits.encoding))
    }

    /// Encodes decoded pixels whose display orientation is `orientation` (EXIF meaning).
    static func encode(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> EncodedBrewPhoto {
        EncodedBrewPhoto(try LabelPhotoEncoder.encode(image, orientation: orientation, limits: BrewPhotoLimits.encoding))
    }

    /// `encode(_:)` on a background task, never on the caller's actor: the screens (M2-T42b)
    /// call this, then `AccountStore.addBrewPhoto(to:jpeg:)` on the main actor. Only `Data` and
    /// the `Sendable` result cross; no model is held across the hop.
    static func encodeInBackground(_ imageData: Data) async throws -> EncodedBrewPhoto {
        try await Task.detached(priority: .userInitiated) {
            try BrewPhotoEncoder.encode(imageData)
        }.value
    }
}
