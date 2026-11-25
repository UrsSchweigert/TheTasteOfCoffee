import Foundation
import Observation

/// F1 step 4 (M2-T22): the user describes a bean with pick lists when there is no Open Food
/// Facts hit or no barcode, and saves it as an unverified catalogue bean with `POST /beans`.
///
/// - Every pick is optional and is a `Vocabulary` value; nothing is typed (invariant 1).
/// - There is no roaster pick (ADR 0006): the roaster comes from Open Food Facts or the
///   operator.
/// - The body is `vocabulary_version`, `attributes` and, if one was scanned, `barcode`. It never
///   carries `open_food_facts_confirmed`: this path is for beans without a confirmed hit.
/// - A 409 means the barcode already has a bean: the model looks it up and uses it. A 400 is
///   shown and the same body is never sent again. Every other failure can be retried.
///
/// The save goes straight to the API for now. `request` is the complete body, built from the
/// picks alone, so M2-T25 can put it into the outbox instead of calling `save()`. Once an
/// unverified bean is saved, its label photos are uploaded by `labelPhotoUploads` (M2-T24).
@MainActor
@Observable
final class BeanEntryModel {
    /// Why the last save failed.
    enum Failure: Equatable, Sendable {
        /// 400: the server did not accept the body. Not retried; changing a pick allows a new save.
        case rejected
        /// Anything else: no network, 429, 5xx, a 409 whose bean could not be read, and so on.
        case retryable
        /// 401, also after the client's refresh: the user has to sign in again (M2-T18).
        /// Not retried; the screen offers the sign-in instead.
        case signInRequired
    }

    enum State: Equatable, Sendable {
        /// Picking; nothing sent yet.
        case editing
        /// `POST /beans`, and after a 409 `GET /barcodes/{barcode}`, under way.
        case saving
        /// The catalogue bean: the one created, or the barcode's existing bean after a 409.
        case saved(API.Bean)
        /// The last save failed. The picks are kept.
        case failed(Failure)
    }

    /// The scanned barcode, if the entry came from a scan. Nil for a bag without a barcode.
    let barcode: CanonicalBarcode?
    /// The optional picks. A nil field is "not set" and is left out of the body.
    var picks = API.BeanAttributes()
    private(set) var state: State = .editing
    /// The body a 400 answered. It is never sent again.
    private(set) var rejectedRequest: API.BeanCreate?
    /// The label photo (M2-T23), held in memory as an encoded JPEG. It is not part of
    /// `request`: once the bean is saved, it is handed to `labelPhotoUploads`.
    let labelPhoto = LabelPhotoDraft()
    /// The label photos of the saved bean (M2-T24): set once the bean is saved, if it is
    /// unverified. The photo of the form is its first one and starts uploading at once.
    private(set) var labelPhotoUploads: LabelPhotoUploadModel?

    private let client: APIClient
    private let photoUploader: any LabelPhotoUploading
    private let photoFiles: LabelPhotoFileStore

    init(
        barcode: CanonicalBarcode?,
        client: APIClient,
        picks: API.BeanAttributes = API.BeanAttributes(),
        photoUploader: (any LabelPhotoUploading)? = nil,
        photoFiles: LabelPhotoFileStore = .standard()
    ) {
        self.barcode = barcode
        self.client = client
        self.picks = picks
        if let photoUploader {
            self.photoUploader = photoUploader
        } else {
            self.photoUploader = LabelPhotoUploader(api: client, files: photoFiles)
        }
        self.photoFiles = photoFiles
    }

    /// The `POST /beans` body for the current picks: the bundled vocabulary version, the
    /// barcode if there is one, and the picks.
    var request: API.BeanCreate {
        API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: barcode?.digits,
            openFoodFactsConfirmed: nil,
            attributes: picks
        )
    }

    /// Whether the picks can be changed now.
    var isEditable: Bool {
        switch state {
        case .editing, .failed: true
        case .saving, .saved: false
        }
    }

    /// Whether `save()` would send a request now: not while saving, not once saved, not
    /// while the label photo is being encoded, and not the body a 400 answered.
    var canSave: Bool {
        isEditable && request != rejectedRequest && state != .failed(.signInRequired) && !labelPhoto.isPreparing
    }

    /// Sends `POST /beans`. Does nothing unless `canSave`.
    func save() async {
        guard canSave else {
            return
        }
        let body = self.request
        state = .saving
        do {
            didSave(try await client.createBean(body))
        } catch APIError.badRequest {
            rejectedRequest = body
            state = .failed(.rejected)
        } catch APIError.conflict {
            await useExistingBean()
        } catch {
            state = BeanEntryModel.failureState(after: error)
        }
    }

    /// The bytes of a catalogue image, for the saved bean's screen. Nil if the id is malformed
    /// or the image cannot be loaded.
    func image(_ imageID: API.Id) async -> Data? {
        guard let id = ResourceID(imageID) else {
            return nil
        }
        return try? await client.catalogueImage(id)
    }

    /// After a 409 the barcode already points to a bean: `GET /barcodes/{barcode}` and use it.
    /// Without a barcode a 409 is unexpected and can be retried.
    private func useExistingBean() async {
        guard let path = barcode?.lookupBarcode else {
            state = .failed(.retryable)
            return
        }
        do {
            didSave(try await client.lookupBarcode(path))
        } catch {
            // A 404 after a 409 contradicts it; "Try again" starts over with `POST /beans`.
            state = BeanEntryModel.failureState(after: error)
        }
    }

    /// Shows the saved bean. For an unverified bean the label photos start (M2-T24), and the
    /// photo of the form, if any, uploads at once. A verified bean takes no label photos
    /// (ADR 0016), so the form's photo is dropped.
    private func didSave(_ bean: API.Bean) {
        if !bean.verified, let beanID = ResourceID(bean.beanId) {
            photoFiles.removeStale()
            let uploads = LabelPhotoUploadModel(beanID: beanID, uploader: photoUploader, files: photoFiles)
            if case .attached(let prepared) = labelPhoto.state {
                uploads.add(prepared)
            }
            labelPhotoUploads = uploads
        }
        labelPhoto.remove()
        state = .saved(bean)
    }

    /// The state after a failed call that is not a 400 or 409 from `POST /beans`. A cancelled
    /// call goes back to editing, so the user can save again.
    private static func failureState(after error: any Error) -> State {
        if error is CancellationError {
            return .editing
        }
        if case .unauthorized? = error as? APIError {
            return .failed(.signInRequired)
        }
        return .failed(.retryable)
    }
}
