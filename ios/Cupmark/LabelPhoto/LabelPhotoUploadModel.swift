import CoreGraphics
import Foundation
import Observation

/// The files of the jobs that are kept for "Try again" but not running, so they can be
/// deleted from the model's `deinit` (which cannot reach its main-actor state).
final class LabelPhotoIdleFiles: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: Set<URL> = []
    private let store: LabelPhotoFileStore

    init(store: LabelPhotoFileStore) {
        self.store = store
    }

    func insert(_ url: URL) {
        lock.withLock { _ = urls.insert(url) }
    }

    func remove(_ url: URL) {
        lock.withLock { _ = urls.remove(url) }
    }

    /// Deletes every file still listed.
    func deleteAll() {
        let all = lock.withLock {
            let current = urls
            urls = []
            return current
        }
        for url in all {
            store.delete(url)
        }
    }
}

/// The label photos of one saved, unverified bean (M2-T24, F1 step 4, ADR 0016): up to
/// `maxPhotos`, each written (off the main actor) to a file of the account's
/// `LabelPhotoFileStore` and uploaded at once by `LabelPhotoUploader`. The network is needed;
/// nothing is queued yet (M2-T25).
///
/// - Uploads run in unstructured tasks, so leaving the screen does not cancel one the server
///   may already be acting on.
/// - What each outcome does to a photo: see `Status`. A rejected photo offers a retake, a
///   failed one "Try again" (which resumes its job), and 409 or 429 stop new photos.
/// - A photo's file is deleted when the upload completes (by the uploader); when the photo is
///   rejected, refused or removed; when the screen goes away (`releaseFiles()`), for files
///   that are not uploading then, and for the others once their upload ends; and when the
///   model is freed (`deinit`, and a task that finds the model gone deletes its own file).
@MainActor
@Observable
final class LabelPhotoUploadModel {
    /// ADR 0016: at most 3 label photos per bean and user.
    static let maxPhotos = 3

    enum Status: Equatable, Sendable {
        /// A capture is being encoded, or its file written.
        case preparing
        /// The capture could not be encoded or written. Retake.
        case encodingFailed
        /// The upload is running.
        case uploading
        /// 204: stored for review.
        case uploaded
        /// 400 on completion: the photo was not accepted. Retake.
        case rejected
        /// 409: the bean takes no more label photos. Not uploaded.
        case notAccepted
        /// 429: try again tomorrow. Not uploaded.
        case dailyLimitReached
        /// 401, or another account is signed in now: sign in again, then try again.
        case signInRequired
        /// Any other failure: try again.
        case failed
    }

    struct Photo: Identifiable, Equatable {
        let id: UUID
        var status: Status
        /// A small upright preview; not compared.
        var preview: CGImage?

        static func == (lhs: Photo, rhs: Photo) -> Bool {
            lhs.id == rhs.id && lhs.status == rhs.status
        }
    }

    let beanID: ResourceID
    let account: AccountID
    private(set) var photos: [Photo] = []
    /// Set by a 409: no new photo is offered.
    private(set) var noMorePhotos = false
    /// Set by a 429: no new photo is offered until the next time.
    private(set) var dailyLimitReached = false

    @ObservationIgnored private var jobs: [UUID: LabelPhotoUploadJob] = [:]
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    /// Raised per photo by every capture and removal, so a slow encoding or write of a
    /// replaced or removed capture is dropped.
    @ObservationIgnored private var generations: [UUID: Int] = [:]
    /// Set by `releaseFiles()`: the screen is gone, so no file is kept any more.
    @ObservationIgnored private var released = false

    private let uploader: any LabelPhotoUploading
    private let files: LabelPhotoFileStore
    private let prepare: LabelPhotoDraft.Prepare
    /// The files of kept jobs that are not running; `deinit` deletes them.
    private let idleFiles: LabelPhotoIdleFiles

    init(
        beanID: ResourceID,
        account: LabelPhotoAccount,
        uploader: any LabelPhotoUploading,
        prepare: @escaping LabelPhotoDraft.Prepare = { try await PreparedLabelPhoto.prepare($0) }
    ) {
        self.beanID = beanID
        self.account = account.account
        self.uploader = uploader
        self.files = account.files
        self.prepare = prepare
        self.idleFiles = LabelPhotoIdleFiles(store: account.files)
    }

    deinit {
        idleFiles.deleteAll()
    }

    /// Whether another photo can be taken: fewer than `maxPhotos`, and no 409 or 429 yet.
    var canAddPhoto: Bool {
        photos.count < LabelPhotoUploadModel.maxPhotos && !noMorePhotos && !dailyLimitReached
    }

    var uploadedCount: Int {
        photos.filter { $0.status == .uploaded }.count
    }

    /// Whether any photo is being encoded or uploaded.
    var isBusy: Bool {
        photos.contains { $0.status == .preparing || $0.status == .uploading }
    }

    // MARK: - Actions

    /// Adds an already encoded photo (the one taken in the entry form) and uploads it.
    func add(_ prepared: PreparedLabelPhoto) async {
        guard canAddPhoto else {
            return
        }
        let id = UUID()
        photos.append(Photo(id: id, status: .preparing, preview: prepared.preview))
        await store(prepared, for: id, generation: nextGeneration(id))
    }

    /// Encodes `capture`, adds it and uploads it.
    func add(_ capture: LabelPhotoCapture) async {
        guard canAddPhoto else {
            return
        }
        let id = UUID()
        photos.append(Photo(id: id, status: .preparing, preview: nil))
        await encode(capture, for: id)
    }

    /// Replaces a photo that was rejected, could not be encoded or failed with a new capture.
    func retake(_ id: UUID, with capture: LabelPhotoCapture) async {
        guard let photo = photo(id), LabelPhotoUploadModel.canRetake(photo.status) else {
            return
        }
        discardJob(id)
        update(id) { photo in
            photo.status = .preparing
            photo.preview = nil
        }
        await encode(capture, for: id)
    }

    /// Runs a failed upload again, from where it stopped.
    func retry(_ id: UUID) {
        guard let photo = photo(id), LabelPhotoUploadModel.canRetry(photo.status), let job = jobs[id] else {
            return
        }
        start(id, job: job)
    }

    /// Drops a photo that is not uploading or uploaded, and its file.
    func remove(_ id: UUID) {
        guard let photo = photo(id), LabelPhotoUploadModel.canRemove(photo.status) else {
            return
        }
        generations[id, default: 0] += 1
        discardJob(id)
        photos.removeAll { $0.id == id }
    }

    /// The screen is gone: deletes the files of every photo that is not uploading now, and of
    /// the others once their upload ends. Nothing can retry them any more.
    func releaseFiles() {
        released = true
        for (id, job) in jobs where tasks[id] == nil {
            idleFiles.remove(job.file)
            files.delete(job.file)
            jobs[id] = nil
        }
    }

    /// Waits for every upload under way. For tests.
    func waitForUploads() async {
        while let task = tasks.values.first {
            await task.value
        }
    }

    static func canRetake(_ status: Status) -> Bool {
        status == .rejected || status == .encodingFailed || status == .failed
    }

    static func canRetry(_ status: Status) -> Bool {
        status == .failed || status == .signInRequired
    }

    static func canRemove(_ status: Status) -> Bool {
        switch status {
        case .preparing, .uploading, .uploaded: false
        case .encodingFailed, .rejected, .notAccepted, .dailyLimitReached, .signInRequired, .failed: true
        }
    }

    // MARK: - Steps

    private func nextGeneration(_ id: UUID) -> Int {
        generations[id, default: 0] += 1
        return generations[id, default: 0]
    }

    private func isCurrent(_ id: UUID, _ generation: Int) -> Bool {
        generations[id, default: 0] == generation && photo(id) != nil
    }

    private func encode(_ capture: LabelPhotoCapture, for id: UUID) async {
        let generation = nextGeneration(id)
        do {
            let prepared = try await prepare(capture)
            guard isCurrent(id, generation) else {
                return
            }
            update(id) { $0.preview = prepared.preview }
            await store(prepared, for: id, generation: generation)
        } catch {
            guard isCurrent(id, generation) else {
                return
            }
            update(id) { $0.status = .encodingFailed }
        }
    }

    /// Writes the JPEG to a file on a background task (up to 8 MiB) and starts its upload. A
    /// file that cannot be written counts as a failed encoding: retake.
    private func store(_ prepared: PreparedLabelPhoto, for id: UUID, generation: Int) async {
        let files = self.files
        let data = prepared.photo.data
        let file: URL
        do {
            file = try await Task.detached(priority: .userInitiated) {
                try files.write(data)
            }.value
        } catch {
            if isCurrent(id, generation) {
                update(id) { $0.status = .encodingFailed }
            }
            return
        }
        guard isCurrent(id, generation), !released else {
            files.delete(file)
            return
        }
        start(id, job: LabelPhotoUploadJob(account: account, beanID: beanID, file: file))
    }

    private func start(_ id: UUID, job: LabelPhotoUploadJob) {
        jobs[id] = job
        idleFiles.remove(job.file)
        update(id) { $0.status = .uploading }
        let uploader = self.uploader
        let files = self.files
        tasks[id] = Task { [weak self] in
            let result = await uploader.run(job)
            guard let self else {
                // The model is gone: nothing can retry this photo. (After `.completed` the
                // uploader has deleted the file already.)
                files.delete(result.job.file)
                return
            }
            self.finish(id, with: result)
        }
    }

    private func finish(_ id: UUID, with result: LabelPhotoUploadResult) {
        tasks[id] = nil
        guard !released, photo(id) != nil, jobs[id]?.file == result.job.file else {
            // The screen is gone, or the photo was removed or retaken meanwhile.
            files.delete(result.job.file)
            if jobs[id]?.file == result.job.file {
                jobs[id] = nil
            }
            return
        }
        switch result.outcome {
        case .completed:
            jobs[id] = nil
            update(id) { $0.status = .uploaded }
        case .rejected:
            discardJob(id)
            update(id) { $0.status = .rejected }
        case .noMorePhotos:
            discardJob(id)
            noMorePhotos = true
            update(id) { $0.status = .notAccepted }
        case .dailyLimitReached:
            // Nothing retries it in this task; M2-T25 will queue it instead.
            discardJob(id)
            dailyLimitReached = true
            update(id) { $0.status = .dailyLimitReached }
        case .signInRequired:
            keep(result.job, for: id)
            update(id) { $0.status = .signInRequired }
        case .failed:
            keep(result.job, for: id)
            update(id) { $0.status = .failed }
        }
    }

    /// Keeps a job for "Try again"; its file is idle until then.
    private func keep(_ job: LabelPhotoUploadJob, for id: UUID) {
        jobs[id] = job
        idleFiles.insert(job.file)
    }

    private func discardJob(_ id: UUID) {
        if let job = jobs.removeValue(forKey: id) {
            idleFiles.remove(job.file)
            files.delete(job.file)
        }
    }

    private func photo(_ id: UUID) -> Photo? {
        photos.first { $0.id == id }
    }

    private func update(_ id: UUID, _ change: (inout Photo) -> Void) {
        guard let index = photos.firstIndex(where: { $0.id == id }) else {
            return
        }
        change(&photos[index])
    }
}
