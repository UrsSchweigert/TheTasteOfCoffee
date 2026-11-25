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

    /// The signed-in account's store. Screens (M2-T18) read and write through it.
    @ObservationIgnored private(set) var store: AccountStore?
    @ObservationIgnored private(set) var engine: SyncEngine?
    @ObservationIgnored private let makeStore: @MainActor @Sendable (AccountID) throws -> AccountStore
    @ObservationIgnored private let makeEngine: @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine
    @ObservationIgnored private let makePuller: @MainActor @Sendable (AccountID, AccountStore) -> Puller?
    @ObservationIgnored private(set) var puller: Puller?
    /// A pull is due at the next idle slot.
    @ObservationIgnored private var pullRequested = false
    /// `SyncEngine.finishedOperations` when the last pull started.
    @ObservationIgnored private var finishedAtLastPull = 0

    /// Nonisolated, so `CupmarkApp.init` can build it whatever its isolation.
    nonisolated init(
        makeStore: @escaping @MainActor @Sendable (AccountID) throws -> AccountStore,
        makeEngine: @escaping @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine,
        makePuller: @escaping @MainActor @Sendable (AccountID, AccountStore) -> Puller? = { _, _ in nil }
    ) {
        self.makeStore = makeStore
        self.makeEngine = makeEngine
        self.makePuller = makePuller
    }

    /// The host of the app: the account's file store, the app's client, the session's check.
    nonisolated static func live(client: APIClient, session: AuthSession) -> SyncHost {
        SyncHost(
            makeStore: { account in try AccountStore.open(for: account) },
            makeEngine: { account, store in
                SyncEngine(store: store, client: client, isCurrentAccount: {
                    await session.isSignedIn(as: account)
                })
            },
            makePuller: { account, store in
                Puller(store: store, client: client, isCurrentAccount: {
                    await session.isSignedIn(as: account)
                })
            }
        )
    }

    /// Stops the current account's engine and, for a new account, opens its store and starts
    /// its engine. The same account again changes nothing.
    func switchTo(_ next: AccountID?) {
        guard next != account else {
            return
        }
        engine?.stop()
        engine?.onIdle = nil
        store?.onSave = nil
        engine = nil
        store = nil
        puller = nil
        account = next
        signInRequired = false
        lastPull = nil
        finishedAtLastPull = 0
        // A sign-in (or a new account) pulls once the outbox is empty.
        pullRequested = true
        guard let next else {
            return
        }
        let opened: AccountStore
        do {
            opened = try makeStore(next)
        } catch {
            // No store, so nothing to send; the screens show the store error (M2-T18).
            return
        }
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
            return await self.pullIfDue(engine: started)
        }
        opened.onSave = { [weak started] in
            Task { @MainActor in
                started?.kick()
            }
        }
        store = opened
        engine = started
        puller = makePuller(next, opened)
        started.start()
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

    /// Runs in the engine's idle slot (`SyncEngine.onIdle`): pulls when one was asked for or
    /// a drain finished an operation since the last pull.
    func pullIfDue(engine: SyncEngine) async -> SyncEngine.IdleOutcome {
        let finished = engine.finishedOperations
        guard let puller, self.engine === engine, pullRequested || finished != finishedAtLastPull else {
            return .done
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
            return .done
        case .signInRequired:
            pullRequested = true
            return .signInRequired
        case .failed, .storeFailed, .cancelled:
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
                // saved: a session that ended itself already shows "session expired", and a
                // sign-out now would replace that note.
                guard required, let auth, let host, let account = host.account, auth.accountID == account else {
                    return
                }
                Task {
                    guard auth.accountID == account, await auth.session.isSignedIn(as: account) else {
                        return
                    }
                    await auth.signOut()
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
