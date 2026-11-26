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
/// The save goes straight to the API, so the saved bean and its label photo uploads can be
/// shown at once (M2-T24). When it cannot answer now (no network, 429, 5xx) and the entry has a
/// store (`offlineStore`, M2-T25), the bean is saved on the device instead: `request` goes into
/// the outbox as the bean's create, the form's label photo into the account's label photo
/// queue, and the bean can go on the shelf and have brews at once. Once online the outbox
/// creates it without asking (a 409 for its barcode adopts the catalogue's bean), and the photo
/// uploads once the bean has its server id.
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
        /// The label photo could not be written to the device (M2-T25): nothing was saved, the
        /// photo is kept, and saving again (or removing the photo) is offered.
        case photoNotSaved
        /// A pending bean's description, made without a store (M2-T36): it is only ever written
        /// to the local store, never sent, so saving again cannot help and is not offered. The
        /// bean is described from the shelf, whose screen has the store.
        case noStore
    }

    enum State: Equatable, Sendable {
        /// Picking; nothing sent yet.
        case editing
        /// `POST /beans`, and after a 409 `GET /barcodes/{barcode}`, under way.
        case saving
        /// The catalogue bean: the one created, or the barcode's existing bean after a 409.
        case saved(API.Bean)
        /// Saved on the device while the API could not answer (M2-T25): the local bean with
        /// this id, created by the outbox once online.
        case savedOffline(UUID)
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

    /// Set when an offline save used a bean the catalogue already had, which cannot take the
    /// picks (M2-T25). The saved screen says so.
    private(set) var picksNotKept = false
    /// The pending bean this entry describes (M2-T25, docs/04 F1 step 4): `save()` writes the
    /// picks and the photo to it in the local store and sends nothing.
    let describing: UUID?

    private let client: APIClient
    /// Where the bean is saved when the API cannot answer now (M2-T25); nil keeps "Try again".
    private let offlineStore: AccountStore?
    /// Whose label photos these are; nil while nobody is signed in, and then none is uploaded.
    private let photoAccount: LabelPhotoAccount?
    private let photoUploader: (any LabelPhotoUploading)?

    init(
        barcode: CanonicalBarcode?,
        client: APIClient,
        picks: API.BeanAttributes = API.BeanAttributes(),
        labelPhotos: LabelPhotoAccount? = nil,
        photoUploader: (any LabelPhotoUploading)? = nil,
        offlineStore: AccountStore? = nil,
        describing: UUID? = nil
    ) {
        self.barcode = barcode
        self.client = client
        self.offlineStore = offlineStore
        self.describing = describing
        self.picks = picks
        self.photoAccount = labelPhotos
        if let photoUploader {
            self.photoUploader = photoUploader
        } else if let labelPhotos {
            self.photoUploader = LabelPhotoUploader(
                api: client,
                files: labelPhotos.files,
                isCurrentAccount: labelPhotos.isSignedIn
            )
        } else {
            self.photoUploader = nil
        }
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
        case .saving, .saved, .savedOffline: false
        }
    }

    /// Whether `save()` would send a request now: not while saving, not once saved, not
    /// while the label photo is being encoded, and not the body a 400 answered.
    var canSave: Bool {
        isEditable && request != rejectedRequest && state != .failed(.signInRequired) && state != .failed(.noStore)
            && !labelPhoto.isPreparing
    }

    /// Sends `POST /beans`, or, when describing a pending bean, writes the description to the
    /// store. Does nothing unless `canSave`.
    func save() async {
        guard canSave else {
            return
        }
        let body = self.request
        state = .saving
        if let describing {
            // A description of a pending bean is only ever written to the local store: the
            // outbox creates the bean. Without a store it is not sent either, and no retry is
            // offered: another try would have no store either.
            guard let offlineStore else {
                state = .failed(.noStore)
                return
            }
            await saveDescription(of: describing, in: offlineStore)
            return
        }
        do {
            let saved = try await client.createBean(body)
            await didSave(saved)
        } catch APIError.badRequest {
            rejectedRequest = body
            state = .failed(.rejected)
        } catch APIError.conflict {
            await useExistingBean(body)
        } catch {
            await didFail(after: error, body: body)
        }
    }

    /// A failure that "Try again" might fix is saved on the device instead, when there is a
    /// store (M2-T25); any other failure is shown.
    private func didFail(after error: any Error, body: API.BeanCreate) async {
        let failed = BeanEntryModel.failureState(after: error)
        guard failed == .failed(.retryable), let offlineStore else {
            state = failed
            return
        }
        await saveOffline(body, in: offlineStore)
    }

    /// Saves the bean in the local store with its queued create, and the form's label photo in
    /// the account's label photo queue, in one save (`AccountStore.addOfflineBean`).
    private func saveOffline(_ body: API.BeanCreate, in store: AccountStore) async {
        let queued = await writeQueuedPhoto()
        guard queued != .failed else {
            state = .failed(.photoNotSaved)
            return
        }
        do {
            let result = try store.addOfflineBean(body, labelPhotoFiles: queued.fileNames)
            labelPhoto.remove()
            picksNotKept = !result.picksKept
            state = .savedOffline(result.bean.localID)
        } catch {
            deleteQueued(queued)
            state = .failed(.retryable)
        }
    }

    /// The description of a pending bean (M2-T25): the picks and the photo, in one save. A bean
    /// that waits for no description any more (answered elsewhere) keeps what it has.
    private func saveDescription(of beanID: UUID, in store: AccountStore) async {
        let queued = await writeQueuedPhoto()
        guard queued != .failed else {
            state = .failed(.photoNotSaved)
            return
        }
        do {
            if try !store.describePendingBean(beanLocalID: beanID, picks: picks, labelPhotoFiles: queued.fileNames) {
                deleteQueued(queued)
            }
            labelPhoto.remove()
            state = .savedOffline(beanID)
        } catch {
            deleteQueued(queued)
            state = .failed(.retryable)
        }
    }

    /// The form's photo in the account's label photo queue.
    private enum QueuedPhoto: Equatable {
        /// No photo (or no account, which takes none).
        case noPhoto
        case file(URL)
        /// The file could not be written.
        case failed

        var fileNames: [String] {
            if case .file(let url) = self {
                return [url.lastPathComponent]
            }
            return []
        }
    }

    /// Writes the form's photo to the account's label photo queue, off the main actor.
    private func writeQueuedPhoto() async -> QueuedPhoto {
        guard case .attached(let prepared) = labelPhoto.state, let photoAccount else {
            return .noPhoto
        }
        let queue = photoAccount.files.queued
        let jpeg = prepared.photo.data
        do {
            let file = try await Task.detached(priority: .userInitiated) {
                try queue.write(jpeg)
            }.value
            return .file(file)
        } catch {
            return .failed
        }
    }

    private func deleteQueued(_ queued: QueuedPhoto) {
        if case .file(let url) = queued, let photoAccount {
            photoAccount.files.queued.delete(url)
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
    private func useExistingBean(_ body: API.BeanCreate) async {
        guard let path = barcode?.lookupBarcode else {
            state = .failed(.retryable)
            return
        }
        do {
            let existing = try await client.lookupBarcode(path)
            await didSave(existing)
        } catch APIError.notFound {
            // A 404 after a 409 contradicts it; "Try again" starts over with `POST /beans`.
            state = .failed(.retryable)
        } catch {
            await didFail(after: error, body: body)
        }
    }

    /// Shows the saved bean. For an unverified bean the label photos start (M2-T24), and the
    /// photo of the form, if any, uploads at once. A verified bean takes no label photos
    /// (ADR 0016), so the form's photo is dropped, as it is while nobody is signed in.
    private func didSave(_ bean: API.Bean) async {
        var formPhoto: PreparedLabelPhoto?
        if case .attached(let prepared) = labelPhoto.state {
            formPhoto = prepared
        }
        labelPhoto.remove()
        var uploads: LabelPhotoUploadModel?
        if !bean.verified, let beanID = ResourceID(bean.beanId), let photoAccount, let photoUploader {
            uploads = LabelPhotoUploadModel(beanID: beanID, account: photoAccount, uploader: photoUploader)
        }
        labelPhotoUploads = uploads
        state = .saved(bean)
        if let uploads, let formPhoto {
            await uploads.add(formPhoto)
        }
    }

    /// The saved-bean screen is gone: the photos that are not uploading lose their files, and
    /// the others once their upload ends (`LabelPhotoUploadModel.releaseFiles()`).
    func releaseLabelPhotos() {
        labelPhotoUploads?.releaseFiles()
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
