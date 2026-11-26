import CoreGraphics
import Foundation
import ImageIO
import Observation

/// The "Photos" section of a saved brew (M2-T42b, ADR 0033): the brew's photos, adding one from
/// the camera or the photo library, and deleting one after a confirmation.
///
/// - A photo is added only to a brew that is in the store: the section is shown on the rating
///   screen of a saved brew (the brew sheet's rating after saving, and the brew list's detail),
///   so there is no draft photo and nothing to clean up. A brew that disappears meanwhile (a
///   pull removed it) refuses the photo with `.brewNotFound`.
/// - The image is encoded off the main actor (`BrewPhotoEncoder.encodeInBackground`, metadata
///   stripped); the file and the record are written by `AccountStore.addBrewPhoto`. A failure
///   keeps the brew and its photos as they were and sets `failure`.
/// - At `BrewPhotoLimits.maxPerBrew` photos nothing is encoded: `isFull` disables the add
///   controls and the screen says why.
/// - Deleting is two steps: `requestDelete` names the photo, the screen asks, and
///   `confirmDelete` deletes record and file (`AccountStore.deleteBrewPhoto`). `cancelDelete`
///   changes nothing.
/// - Nothing is typed (invariant 1) and nothing is sent: brew photos stay on the device.
@MainActor
@Observable
final class BrewPhotosModel {
    /// Why the last add or delete failed. The screen shows a localised message for each.
    enum Failure: Equatable, Sendable {
        /// The image could not be read or turned into a JPEG.
        case unreadable
        /// Even the lowest quality is over the size limit.
        case tooLarge
        /// The brew already has `BrewPhotoLimits.maxPerBrew` photos.
        case limitReached
        /// The brew is gone (removed here, or on another device and pulled).
        case brewNotFound
        /// The store could not save, or has no photo folder. Nothing was changed.
        case saveFailed
    }

    /// One photo of the brew, newest first.
    struct Item: Identifiable, Equatable, Sendable {
        /// The record's `localID`.
        let id: UUID
        let createdAt: Date
        /// The JPEG; nil when the file is missing (the record stays so it can be deleted).
        let fileURL: URL?
    }

    /// Encodes a picked image file; replaced in tests.
    typealias EncodeData = @Sendable (Data) async throws -> EncodedBrewPhoto
    /// Encodes a camera capture; replaced in tests.
    typealias EncodeCapture = @Sendable (LabelPhotoCapture) async throws -> EncodedBrewPhoto

    let brewLocalID: UUID
    let store: AccountStore
    private(set) var items: [Item] = []
    private(set) var failure: Failure?
    /// Whether the brew is in the store and not removed. The section is shown only then.
    private(set) var brewExists = false
    private(set) var cameraAvailability: LabelPhotoCameraAvailability = .unavailable
    /// The camera is up (set by the screen).
    var isCapturing = false
    /// An image is being encoded and saved.
    private(set) var isAdding = false
    /// The photo the user asked to delete and has not confirmed yet.
    private(set) var pendingDeletion: UUID?

    private let camera: any LabelPhotoCameraEnvironment
    private let encodeData: EncodeData
    private let encodeCapture: EncodeCapture
    private let now: () -> Date

    init(
        brew localID: UUID,
        store: AccountStore,
        camera: any LabelPhotoCameraEnvironment = LiveLabelPhotoCameraEnvironment(),
        encodeData: @escaping EncodeData = { try await BrewPhotoEncoder.encodeInBackground($0) },
        encodeCapture: @escaping EncodeCapture = { try await BrewPhotoEncoder.encodeInBackground($0) },
        now: @escaping () -> Date = { Date() }
    ) {
        brewLocalID = localID
        self.store = store
        self.camera = camera
        self.encodeData = encodeData
        self.encodeCapture = encodeCapture
        self.now = now
        refresh()
    }

    // MARK: - State

    var count: Int { items.count }
    var limit: Int { BrewPhotoLimits.maxPerBrew }
    /// No photo can be added: the brew holds the most it can.
    var isFull: Bool { count >= limit }
    /// The section is shown: the brew is there and the store has a photo folder (it has none
    /// only for an account id that cannot name a folder).
    var isOffered: Bool { brewExists && store.brewPhotoFiles != nil }
    var canAdd: Bool { brewExists && !isFull && !isAdding }
    /// The camera step is offered unless the device has no camera.
    var offersCamera: Bool { cameraAvailability != .unavailable }

    /// Whether the delete confirmation is up. Setting it to false cancels.
    var isConfirmingDelete: Bool {
        get { pendingDeletion != nil }
        set { if !newValue { pendingDeletion = nil } }
    }

    /// The 1-based position of `item` in the list, for "Photo 2 of 3".
    func position(of item: Item) -> Int {
        (items.firstIndex { $0.id == item.id } ?? 0) + 1
    }

    // MARK: - Reading

    /// Reads the brew's photos and the camera's availability again. Called when the screen
    /// appears and after every save of the store (a pull may have removed the brew).
    func refresh() {
        cameraAvailability = camera.availability()
        guard let brew = try? store.brew(localID: brewLocalID), brew.syncState != .pendingDelete else {
            brewExists = false
            items = []
            pendingDeletion = nil
            return
        }
        brewExists = true
        do {
            // The file is looked up here, not through `brewPhotoFileURL(of:)`, which logs a
            // missing file: this runs on every save of the store (the sync engine's too), and
            // the log would repeat for the same record each time.
            let files = store.brewPhotoFiles
            items = try store.brewPhotos(of: brew).map { photo in
                let url = files.flatMap { $0.fileExists(photo.fileName) ? $0.url(of: photo.fileName) : nil }
                return Item(id: photo.localID, createdAt: photo.createdAt, fileURL: url)
            }
        } catch {
            items = []
            failure = .saveFailed
        }
        if let pending = pendingDeletion, !items.contains(where: { $0.id == pending }) {
            pendingDeletion = nil
        }
    }

    // MARK: - Adding

    /// Adds the image file `load` returns (a library pick). A pick that cannot be loaded or has
    /// no data is `.unreadable`.
    func addPicked(_ load: () async throws -> Data?) async {
        guard prepareToAdd() else { return }
        defer { isAdding = false }
        let data: Data?
        do {
            data = try await load()
        } catch {
            failure = .unreadable
            return
        }
        guard let data else {
            failure = .unreadable
            return
        }
        do {
            save(try await encodeData(data))
        } catch {
            fail(error)
        }
    }

    /// Adds a camera capture.
    func add(_ capture: LabelPhotoCapture) async {
        guard prepareToAdd() else { return }
        defer { isAdding = false }
        do {
            save(try await encodeCapture(capture))
        } catch {
            fail(error)
        }
    }

    /// Clears the last failure and checks the brew and the limit before any work is done.
    private func prepareToAdd() -> Bool {
        failure = nil
        guard !isAdding else { return false }
        refresh()
        guard brewExists else {
            failure = .brewNotFound
            return false
        }
        guard !isFull else {
            failure = .limitReached
            return false
        }
        isAdding = true
        return true
    }

    /// Writes the photo on the main actor. The brew may have gone while the image was encoded:
    /// the store refuses then, and nothing is left behind.
    private func save(_ jpeg: EncodedBrewPhoto) {
        do {
            guard let brew = try self.store.brew(localID: brewLocalID) else {
                throw BrewPhotoError.brewNotFound
            }
            try self.store.addBrewPhoto(to: brew, jpeg: jpeg, createdAt: now())
        } catch {
            fail(error)
        }
        refresh()
    }

    private func fail(_ error: any Error) {
        switch error {
        case let encoding as LabelPhotoEncodingError:
            switch encoding {
            case .tooLarge: failure = .tooLarge
            case .unreadableImage, .renderingFailed, .encodingFailed: failure = .unreadable
            }
        case let photo as BrewPhotoError:
            switch photo {
            case .limitReached: failure = .limitReached
            case .brewNotFound: failure = .brewNotFound
            case .noPhotoFolder, .fileMissing: failure = .saveFailed
            }
        default:
            failure = .saveFailed
        }
    }

    /// The user cancelled the camera or the picker: nothing changes.
    func clearFailure() {
        failure = nil
    }

    // MARK: - Deleting

    /// Asks to delete `item`; the screen shows its confirmation.
    func requestDelete(_ item: Item) {
        failure = nil
        pendingDeletion = item.id
    }

    func cancelDelete() {
        pendingDeletion = nil
    }

    /// Deletes the photo that was asked about, record and file. The brew is not touched.
    func confirmDelete() {
        guard let id = pendingDeletion else { return }
        pendingDeletion = nil
        do {
            try store.deleteBrewPhoto(localID: id)
        } catch {
            failure = .saveFailed
        }
        refresh()
    }
}

/// Thumbnails of brew photos, made with ImageIO from the file, never the full image in a list.
enum BrewPhotoThumbnails {
    /// A decoded thumbnail. `@unchecked Sendable`: a `CGImage` is immutable once made.
    struct Thumbnail: @unchecked Sendable {
        let image: CGImage
    }

    /// The longest side of a thumbnail in pixels: 64 points at 3x.
    static let pixelSize = 192

    /// The thumbnail of the JPEG at `url`, made on a background task; nil when the file cannot
    /// be read.
    static func load(_ url: URL, maxPixelSize: Int = pixelSize) async -> Thumbnail? {
        await Task.detached(priority: .utility) {
            downsample(url, maxPixelSize: maxPixelSize)
        }.value
    }

    /// `load`, tried once more when the first read fails (a file that was not readable yet, or
    /// while the app was inactive).
    static func loadWithRetry(_ url: URL, maxPixelSize: Int = pixelSize) async -> Thumbnail? {
        if let loaded = await load(url, maxPixelSize: maxPixelSize) {
            return loaded
        }
        return await load(url, maxPixelSize: maxPixelSize)
    }

    /// A thumbnail that was loaded, with the file and the size it was made for.
    struct Loaded: @unchecked Sendable {
        let url: URL
        let pixels: Int
        let thumbnail: Thumbnail
    }

    /// What a view shows after it asked for `url` at `maxPixelSize` (M2-T43b), given what it
    /// showed before (`current`):
    /// - no file: nothing;
    /// - the image already shown is of this file and at least this large: it stays, nothing is
    ///   read again (a scene phase change reloads every thumbnail otherwise);
    /// - a load that fails keeps the last good image of the same file instead of replacing it
    ///   with the placeholder; an image of another file is never kept.
    static func updated(_ current: Loaded?, for url: URL?, maxPixelSize: Int) async -> Loaded? {
        guard let url else {
            return nil
        }
        if let current, current.url == url, current.pixels >= maxPixelSize {
            return current
        }
        if let thumbnail = await loadWithRetry(url, maxPixelSize: maxPixelSize) {
            return Loaded(url: url, pixels: maxPixelSize, thumbnail: thumbnail)
        }
        return current?.url == url ? current : nil
    }

    /// Synchronous; call it off the main actor. The file is upright already (the encoder applied
    /// the orientation), and the thumbnail is never cached by ImageIO beyond this call.
    static func downsample(_ url: URL, maxPixelSize: Int) -> Thumbnail? {
        let sourceOptions: [String: Any] = [kCGImageSourceShouldCache as String: false]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions as CFDictionary) else {
            return nil
        }
        let options: [String: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways as String: true,
            kCGImageSourceCreateThumbnailWithTransform as String: true,
            kCGImageSourceShouldCacheImmediately as String: true,
            kCGImageSourceThumbnailMaxPixelSize as String: maxPixelSize,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return Thumbnail(image: image)
    }
}
