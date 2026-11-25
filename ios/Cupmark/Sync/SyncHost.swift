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
@MainActor
@Observable
final class SyncHost {
    private(set) var account: AccountID?
    /// True once the engine stopped because the server refused the token, also after a
    /// refresh. `SyncHostModifier` then signs out, so the sign-in screen shows.
    private(set) var signInRequired = false

    /// The signed-in account's store. Screens (M2-T18) read and write through it.
    @ObservationIgnored private(set) var store: AccountStore?
    @ObservationIgnored private(set) var engine: SyncEngine?
    @ObservationIgnored private let makeStore: @MainActor @Sendable (AccountID) throws -> AccountStore
    @ObservationIgnored private let makeEngine: @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine

    /// Nonisolated, so `CupmarkApp.init` can build it whatever its isolation.
    nonisolated init(
        makeStore: @escaping @MainActor @Sendable (AccountID) throws -> AccountStore,
        makeEngine: @escaping @MainActor @Sendable (AccountID, AccountStore) -> SyncEngine
    ) {
        self.makeStore = makeStore
        self.makeEngine = makeEngine
    }

    /// The host of the app: the account's file store, the app's client, the session's check.
    nonisolated static func live(client: APIClient, session: AuthSession) -> SyncHost {
        SyncHost(
            makeStore: { account in try AccountStore.open(for: account) },
            makeEngine: { account, store in
                SyncEngine(store: store, client: client, isCurrentAccount: {
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
        store?.onSave = nil
        engine = nil
        store = nil
        account = next
        signInRequired = false
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
        opened.onSave = { [weak started] in
            Task { @MainActor in
                started?.kick()
            }
        }
        store = opened
        engine = started
        started.start()
    }

    /// Asks the engine to look at the outbox now (for example when the app comes back to the
    /// foreground).
    func kick() {
        engine?.kick()
    }
}

/// Connects a `SyncHost` to the sign-in state: every account change switches the host, and
/// a sign-in-required stop signs out.
struct SyncHostModifier: ViewModifier {
    let host: SyncHost?
    let auth: AuthModel?

    func body(content: Content) -> some View {
        content
            .onChange(of: auth?.accountID, initial: true) { _, account in
                host?.switchTo(account)
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
