import CoreGraphics
import Foundation
import ImageIO
import Observation

/// A camera capture as decoded pixels and the orientation they are meant to be shown in.
///
/// `@unchecked Sendable`: a `CGImage` is immutable once made, so handing it to the encoding
/// task is safe even where the SDK does not mark it `Sendable`.
struct LabelPhotoCapture: @unchecked Sendable {
    let image: CGImage
    let orientation: CGImagePropertyOrientation
}

/// An encoded label photo and a small upright preview of it for the entry screen.
///
/// `@unchecked Sendable` for the same reason as `LabelPhotoCapture`.
struct PreparedLabelPhoto: @unchecked Sendable, Equatable {
    let photo: EncodedLabelPhoto
    /// About 600 px on its longest side; nil if ImageIO could not make one. Not compared.
    let preview: CGImage?

    static func == (lhs: PreparedLabelPhoto, rhs: PreparedLabelPhoto) -> Bool {
        lhs.photo == rhs.photo
    }

    /// The longest side of `preview`, in pixels.
    static let previewPixelSize = 600

    /// Encodes `capture` for upload (ADR 0016) and makes its preview, on a background task so
    /// the main actor stays free while a 12-megapixel capture is redrawn and compressed.
    static func prepare(_ capture: LabelPhotoCapture) async throws -> PreparedLabelPhoto {
        try await Task.detached(priority: .userInitiated) {
            let photo = try LabelPhotoEncoder.encode(capture.image, orientation: capture.orientation)
            return PreparedLabelPhoto(photo: photo, preview: PreparedLabelPhoto.makePreview(of: photo.data))
        }.value
    }

    /// A thumbnail of a JPEG through ImageIO. The encoded file is already upright.
    static func makePreview(of jpeg: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil) else { return nil }
        let options: [String: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways as String: true,
            kCGImageSourceCreateThumbnailWithTransform as String: true,
            kCGImageSourceThumbnailMaxPixelSize as String: previewPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

/// The label photo of a bean entry draft (M2-T23, F1 step 4). It holds the encoded JPEG in
/// memory until the bean is saved, then `BeanEntryModel` hands it to `LabelPhotoUploadModel`
/// (M2-T24), which writes and uploads it; nothing is written to disk and nothing is sent from
/// here. One photo; taking another replaces it.
@MainActor
@Observable
final class LabelPhotoDraft {
    enum State: Equatable, Sendable {
        /// No photo taken, or it was removed.
        case empty
        /// A capture is being encoded.
        case preparing
        /// The photo to upload.
        case attached(PreparedLabelPhoto)
        /// The last capture could not be encoded (see `LabelPhotoEncodingError`). Retake.
        case failed
    }

    typealias Prepare = @Sendable (LabelPhotoCapture) async throws -> PreparedLabelPhoto

    private(set) var state: State = .empty

    private let prepare: Prepare
    /// Raised by every capture and removal, so a slow encoding that finishes after a newer
    /// capture, or after Remove, is dropped.
    @ObservationIgnored private var generation = 0

    init(prepare: @escaping Prepare = { try await PreparedLabelPhoto.prepare($0) }) {
        self.prepare = prepare
    }

    /// The encoded JPEG to upload, if one is attached.
    var photo: EncodedLabelPhoto? {
        if case .attached(let prepared) = state { prepared.photo } else { nil }
    }

    var isPreparing: Bool {
        state == .preparing
    }

    /// Encodes `capture` and attaches it, replacing any earlier photo.
    func attach(_ capture: LabelPhotoCapture) async {
        generation += 1
        let current = generation
        state = .preparing
        do {
            let prepared = try await prepare(capture)
            guard current == generation else { return }
            state = .attached(prepared)
        } catch {
            guard current == generation else { return }
            state = .failed
        }
    }

    /// Drops the photo, and any encoding still under way.
    func remove() {
        generation += 1
        state = .empty
    }
}
