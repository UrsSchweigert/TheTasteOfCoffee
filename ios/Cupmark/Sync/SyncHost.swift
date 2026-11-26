import Observation
import SwiftUI

/// Owns the local store and the sync engine of the signed-in account (M2-T16, ADR 0025).
///
/// - `switchTo(_:)` is called with every change of the signed-in account (`SyncHostModifier`).
///   A new account gets its own store and engine; nil (sign-out, expired session) stops the
///   engine first, so nothing more is sent. The operations stay in that account's store.
/// - The engine uses the app's one `APIClient` (M2-T14) and asks `AuthSession` before every
///   request whether its account is still the signed-in one.
/// - A local write wakes the engine through `AccountStore.onSave`.
/// - The pull (M2-T17, `Puller`) runs in the engine's idle slot, so it never overlaps a
///   drain and the local writes go out first. It runs once the outbox is empty after a
///   sign-in (`switchTo(_:)`), after the app came to the foreground (`sceneBecameActive()`),
///   and after a drain that finished an operation. A failed pull is tried again at the next
///   of these.
/// - The label photo folders follow the account too (M2-T24, `LabelPhotoFolders`): leaving an
///   account deletes its screen photos and the queued files its store does not list; a sign-in
///   (also at app start) deletes every other account's files but their queued ones, the
///   account's own stale screen photos, and its queued files its store does not list. Queued
///   photos (M2-T25) belong to the account's store, which stays on the device after a sign-out,
///   so they stay with it and upload when the account signs in again.
/// - Brew photos (M2-T42, ADR 0033, `BrewPhotoFolders`) belong to the account's store and stay
///   with it across a sign-out and another account's sign-in. When a store is opened, its
///   sweep (`AccountStore.sweepBrewPhotos()`) deletes the photos of removed brews and the files
///   no record lists.
/// - The label photo queue (M2-T25, `LabelPhotoQueue`) runs in the engine's idle slot before
///   the pull, so the beans the drain created have their server ids.
/// - While an account deletion is recorded (M2-T31, `isHeld`), no store is open and no engine
///   runs, for any account: `holdForAccountDeletion()` closes the current one, and
///   `switchTo(_:)` opens none until the record is gone. A token refresh, a return to the
///   foreground or a restart cannot start one, so nothing more is sent.
@MainActor
@Observable
final class SyncHost {
    private(set) var account: AccountID?
    /// True once the engine stopped because the server refused the token, also after a
    /// refresh. `SyncHostModifier` then signs out, so the sign-in screen shows.
    private(set) var signInRequired = false
    /// The last pull that completed for the current account, nil before. `skippedItems`
    /// counts the items it left out (a later screen shows a note for them).
    private(set) var lastPull: PullReport?
    /// True when the last pull for the current account failed (offline, a server error, the
    /// store), false after one completed. Onboarding (M2-T29) uses it not to wait forever.
    private(set) var lastPullFailed = false

    /// What the current account's pulls said about `GET /profile` (M2-T29): the last completed
    /// pull's answer, else `unreachable` after a failed one, else `notYet`.
    var serverProfile: ServerProfileAnswer {
        if let lastPull {
            return lastPull.profileFound ? .found : .missing
        }
        return lastPullFailed ? .unreachable : .notYet
    }

    /// The signed-in account's store. Screens (M2-T18) read and write through it.
    @ObservationIgnored private(set) var store: AccountStore?
    @ObservationIgnored private(set) var engine: SyncEngine?
    @ObservationIgnored private let makeStore: @MainActor @Sendable (AccountID) throws -> AccountStore
    @ObservationIgnored private let makeEngine: @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine
    @ObservationIgnored private let makePuller: @MainActor @Sendable (AccountID, AccountStore) -> Puller?
    @ObservationIgnored private(set) var puller: Puller?
    @ObservationIgnored private let makeLabelPhotoQueue: @MainActor @Sendable (AccountID, AccountStore, LabelPhotoFileStore) -> LabelPhotoQueue?
    /// The signed-in account's label photo queue (M2-T25).
    @ObservationIgnored private(set) var labelPhotoQueue: LabelPhotoQueue?
    /// A pull is due at the next idle slot.
    @ObservationIgnored private var pullRequested = false
    /// `SyncEngine.finishedOperations` when the last pull started.
    @ObservationIgnored private var finishedAtLastPull = 0
    /// When the last pull completed, nil before.
    @ObservationIgnored private var lastPullCompletedAt: Date?
    /// A pull that only follows a drain waits until this long after the last completed pull;
    /// the drain's own answers are already stored. Sign-in and foreground always pull.
    @ObservationIgnored let drainPullInterval: TimeInterval
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let labelPhotos: LabelPhotoFolders
    /// True while an account deletion is recorded (M2-T31): no store is opened then.
    @ObservationIgnored private let isHeld: @MainActor @Sendable () -> Bool

    /// Nonisolated, so `CupmarkApp.init` can build it whatever its isolation.
    nonisolated init(
        makeStore: @escaping @MainActor @Sendable (AccountID) throws -> AccountStore,
        makeEngine: @escaping @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine,
        makePuller: @escaping @MainActor @Sendable (AccountID, AccountStore) -> Puller? = { _, _ in nil },
        makeLabelPhotoQueue: @escaping @MainActor @Sendable (AccountID, AccountStore, LabelPhotoFileStore) -> LabelPhotoQueue? = { _, _, _ in nil },
        drainPullInterval: TimeInterval = 30,
        now: @escaping @Sendable () -> Date = { Date() },
        labelPhotos: LabelPhotoFolders = .standard,
        isHeld: @escaping @MainActor @Sendable () -> Bool = { false }
    ) {
        self.makeStore = makeStore
        self.makeEngine = makeEngine
        self.makePuller = makePuller
        self.makeLabelPhotoQueue = makeLabelPhotoQueue
        self.drainPullInterval = drainPullInterval
        self.now = now
        self.labelPhotos = labelPhotos
        self.isHeld = isHeld
    }

    /// The host of the app: the account's file store, the app's client, the session's check
    /// (`maySend(as:)`, which is also false while an account deletion is recorded), and the
    /// deletion record (M2-T31).
    nonisolated static func live(client: APIClient, session: AuthSession, deletions: any AccountDeletionStore) -> SyncHost {
        SyncHost(
            makeStore: { account in try AccountStore.open(for: account) },
            makeEngine: { account, store in
                SyncEngine(store: store, client: client, isCurrentAccount: {
                    await session.maySend(as: account)
                })
            },
            makePuller: { account, store in
                Puller(store: store, client: client, isCurrentAccount: {
                    await session.maySend(as: account)
                })
            },
            makeLabelPhotoQueue: { account, store, files in
                LabelPhotoQueue(
                    store: store,
                    account: account,
                    files: files,
                    uploader: LabelPhotoUploader(api: client, files: files, isCurrentAccount: { candidate in
                        await session.maySend(as: candidate)
                    })
                )
            },
            isHeld: { deletions.holdsSending }
        )
    }

    /// Stops the current account's engine and, for a new account, opens its store and starts
    /// its engine. The same account again changes nothing. While an account deletion is
    /// recorded (`isHeld`) every account counts as nil: the current store is closed and none is
    /// opened (M2-T31).
    func switchTo(_ requested: AccountID?) {
        let held = isHeld()
        let next = held ? nil : requested
        guard next != account else {
            return
        }
        // While held nothing local is deleted before the deletion's 204 (ADR 0031): the screen
        // photos stay until the deletion removes the whole folder.
        if let previous = account, !held {
            // The screen's photos end with the session; queued ones stay with the store, as
            // far as the store lists them (nil: it could not be read, so nothing is dropped).
            let queued = try? store?.queuedLabelPhotoFileNames()
            labelPhotos.close(previous, keepingQueued: queued)
        }
        engine?.stop()
        engine?.onIdle = nil
        engine?.nextIdleWake = nil
        store?.onSave = nil
        engine = nil
        store = nil
        puller = nil
        labelPhotoQueue = nil
        account = next
        signInRequired = false
        lastPull = nil
        lastPullFailed = false
        finishedAtLastPull = 0
        lastPullCompletedAt = nil
        // A sign-in (or a new account) pulls once the outbox is empty.
        pullRequested = true
        guard let next else {
            return
        }
        labelPhotos.signedIn(as: next)
        let opened: AccountStore
        do {
            opened = try makeStore(next)
        } catch {
            // No store, so nothing to send; the screens show the store error (M2-T18).
            return
        }
        if let queued = try? opened.queuedLabelPhotoFileNames() {
            labelPhotos.removeUnqueued(of: next, keeping: queued)
        }
        // Brew photos (M2-T42, ADR 0033) stay with the store across sign-outs; at every open
        // the records of removed brews and the files no record lists go.
        opened.sweepBrewPhotos()
        // The device-backup setting (M2-T45) is applied again to the folder and its files.
        opened.applyBrewPhotoBackupSetting()
        let started = makeEngine(next, opened)
        started.onSignInRequired = { [weak self, weak started] in
            // Only the current engine speaks for the host; a stopped one may still finish.
            guard let self, let started, self.engine === started else {
                return
            }
            self.signInRequired = true
        }
        started.onIdle = { [weak self, weak started] in
            guard let self, let started, self.engine === started else {
                return .done
            }
            if let queue = self.labelPhotoQueue, await queue.run() == .signInRequired {
                return .signInRequired
            }
            guard self.engine === started else {
                return .done
            }
            return await self.pullIfDue(engine: started)
        }
        started.nextIdleWake = { [weak self] in
            self?.labelPhotoQueue?.nextAttempt()
        }
        opened.onSave = { [weak started] in
            Task { @MainActor in
                started?.kick()
            }
        }
        store = opened
        engine = started
        puller = makePuller(next, opened)
        labelPhotoQueue = makeLabelPhotoQueue(next, opened, labelPhotos.queue(for: next))
        started.start()
    }

    /// An account deletion started or resumed (M2-T31): stops the engine, so the request on its
    /// way is cancelled and nothing more is sent, and closes the store, whose files the deletion
    /// removes after its 204. No label photo is deleted here. The record of the deletion is saved before this is called, so
    /// `switchTo(_:)` opens no store until the deletion is done.
    func holdForAccountDeletion() {
        switchTo(nil)
    }

    /// Asks the engine to look at the outbox now (for example when the app comes back to the
    /// foreground).
    func kick() {
        engine?.kick()
    }

    /// Asks for a pull at the next idle slot and wakes the engine, so the outbox goes first.
    func requestPull() {
        pullRequested = true
        engine?.kick()
    }

    /// The app came to the foreground: send what is queued, then pull.
    func sceneBecameActive() {
        requestPull()
    }

    /// Runs in the engine's idle slot (`SyncEngine.onIdle`): pulls when one was asked for
    /// (sign-in, foreground, a failed pull), or when a drain finished an operation since the
    /// last pull and that pull completed at least `drainPullInterval` ago. A drain-only pull
    /// that is too soon stays due and runs at a later idle slot.
    func pullIfDue(engine: SyncEngine) async -> SyncEngine.IdleOutcome {
        let finished = engine.finishedOperations
        guard let puller, self.engine === engine else {
            return .done
        }
        if !pullRequested {
            guard finished != finishedAtLastPull else {
                return .done
            }
            if let completed = lastPullCompletedAt, now().timeIntervalSince(completed) < drainPullInterval {
                return .done
            }
        }
        pullRequested = false
        finishedAtLastPull = finished
        let result = await puller.pull()
        // The account may have changed during the requests; a replaced engine's pull says
        // nothing about the current account.
        guard self.engine === engine else {
            return .done
        }
        switch result {
        case .completed(let report):
            lastPull = report
            lastPullFailed = false
            lastPullCompletedAt = now()
            return .done
        case .signInRequired:
            pullRequested = true
            return .signInRequired
        case .failed, .storeFailed:
            pullRequested = true
            lastPullFailed = true
            return .done
        case .cancelled:
            pullRequested = true
            return .done
        }
    }
}

/// Connects a `SyncHost` to the sign-in state: every account change switches the host, and
/// a sign-in-required stop signs out.
struct SyncHostModifier: ViewModifier {
    let host: SyncHost?
    let auth: AuthModel?
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: auth?.accountID, initial: true) { _, account in
                host?.switchTo(account)
            }
            .onChange(of: scenePhase) { _, phase in
                // Back in the foreground: send, then pull (M2-T17).
                if phase == .active {
                    host?.sceneBecameActive()
                }
            }
            .onChange(of: host?.signInRequired ?? false) { _, required in
                // Only for the account the host syncs, and only while its session is still
                // saved (`signOutAfterServerRefusal(of:)`): the sign-in screen then says that
                // the account was deleted or its session ended (M2-T31).
                guard required, let auth, let host, let account = host.account, auth.accountID == account else {
                    return
                }
                Task {
                    await auth.signOutAfterServerRefusal(of: account)
                }
            }
    }
}

extension View {
    /// Runs the outbox of whoever is signed in (M2-T16).
    func syncHost(_ host: SyncHost?, auth: AuthModel?) -> some View {
        modifier(SyncHostModifier(host: host, auth: auth))
    }
}
