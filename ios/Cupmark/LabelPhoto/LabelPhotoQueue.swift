import Foundation

// The label photo queue (M2-T25, ADR 0016): label photos taken while the bean could not be
// saved on the server (offline) wait in the account's store (`QueuedLabelPhoto`) and its queue
// folder, and upload once the bean has a server id.

extension ResourceID: Codable {
    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let id = ResourceID(text) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an id of the contract.")
        }
        self = id
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Runs the queued label photos of one account (M2-T25). `SyncHost` runs it in the sync
/// engine's idle slot, so it never overlaps a drain, and a bean created by the drain has its
/// server id by then.
///
/// - A photo waits while its bean has no server id. A bean that is gone (discarded) or
///   verified (it takes no photos, ADR 0016) drops its photos and their files.
/// - One run per photo of `LabelPhotoUploader`, which checks the account before every step.
///   The job is stored after each run, so the next one resumes where it stopped.
/// - Outcomes: completed, rejected and "no more photos" end the photo (the file goes); the
///   daily cap waits `limitWait`; any other failure backs off (`SyncBackoff`); sign-in
///   required stops the run and is passed on.
@MainActor
final class LabelPhotoQueue {
    /// How long a photo waits after the daily upload cap answered 429.
    nonisolated static let limitWait: TimeInterval = 6 * 60 * 60

    let store: AccountStore
    let account: AccountID
    /// The account's queue folder (`LabelPhotoFolders.queue(for:)`).
    let files: LabelPhotoFileStore
    private let uploader: any LabelPhotoUploading
    private let backoff: SyncBackoff
    private let now: @Sendable () -> Date
    private let jitter: @Sendable () -> Double
    private var isRunning = false

    init(
        store: AccountStore,
        account: AccountID,
        files: LabelPhotoFileStore,
        uploader: any LabelPhotoUploading,
        backoff: SyncBackoff = SyncBackoff(),
        now: @escaping @Sendable () -> Date = { Date() },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }
    ) {
        self.store = store
        self.account = account
        self.files = files
        self.uploader = uploader
        self.backoff = backoff
        self.now = now
        self.jitter = jitter
    }

    /// Uploads every queued photo that is due and whose bean has a server id, one at a time.
    func run() async -> SyncEngine.IdleOutcome {
        guard !isRunning else {
            return .done
        }
        isRunning = true
        defer { isRunning = false }
        let ids = ((try? store.queuedLabelPhotos()) ?? []).map(\.localID)
        for id in ids {
            if Task.isCancelled {
                return .done
            }
            guard let photo = try? store.queuedLabelPhoto(localID: id), photo.nextAttemptAt <= now() else {
                continue
            }
            let file = files.directory.appending(path: photo.fileName, directoryHint: .notDirectory)
            guard let bean = try? store.bean(localID: photo.beanLocalID), !bean.verified else {
                finish(id, deleting: file)
                continue
            }
            guard let serverID = bean.serverID, let beanID = ResourceID(serverID) else {
                // Waits for the bean's create.
                continue
            }
            let stored = photo.jobData.flatMap { data in try? JSONDecoder().decode(LabelPhotoUploadJob.self, from: data) }
            let job = LabelPhotoUploadJob(
                account: account,
                beanID: beanID,
                file: file,
                // A stage of another bean (the bean was replaced) starts over.
                stage: stored?.beanID == beanID ? (stored?.stage ?? .notStarted) : .notStarted
            )
            photo.attemptCount += 1
            try? store.save()

            let result = await uploader.run(job)

            guard let current = try? store.queuedLabelPhoto(localID: id) else {
                // Removed meanwhile (the bean was discarded): its file goes too.
                files.delete(file)
                continue
            }
            switch result.outcome {
            case .completed, .rejected, .noMorePhotos:
                finish(id, deleting: file)
            case .dailyLimitReached:
                current.jobData = try? JSONEncoder().encode(result.job)
                current.nextAttemptAt = now().addingTimeInterval(LabelPhotoQueue.limitWait)
                try? store.save()
            case .failed:
                current.jobData = try? JSONEncoder().encode(result.job)
                let wait = backoff.delay(afterAttempt: max(1, current.attemptCount), jitter: jitter())
                current.nextAttemptAt = now().addingTimeInterval(wait)
                try? store.save()
            case .signInRequired:
                current.jobData = try? JSONEncoder().encode(result.job)
                // Not counted: nothing was refused.
                current.attemptCount = max(0, current.attemptCount - 1)
                try? store.save()
                return .signInRequired
            }
        }
        return .done
    }

    /// The earliest moment a photo whose bean has a server id may run again, nil for none.
    func nextAttempt() -> Date? {
        let current = now()
        let photos = (try? store.queuedLabelPhotos()) ?? []
        return photos
            .filter { photo in photo.nextAttemptAt > current }
            .filter { photo in (try? store.bean(localID: photo.beanLocalID))?.serverID != nil }
            .map(\.nextAttemptAt)
            .min()
    }

    /// Removes the photo from the queue and deletes its file.
    private func finish(_ id: UUID, deleting file: URL) {
        if let photo = try? store.queuedLabelPhoto(localID: id) {
            store.removeQueuedLabelPhoto(photo)
            try? store.save()
        }
        files.delete(file)
    }
}
