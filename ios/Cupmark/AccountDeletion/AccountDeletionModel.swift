import Foundation
import Observation

/// The two requests account deletion makes (M2-T31). `live` uses the app's `AuthSession` and
/// `APIClient`; tests can use the same with stubs.
struct AccountDeletionRequests: Sendable {
    /// Gets a new access token (`TokenProvider.refresh()`).
    var refreshToken: @Sendable () async throws -> Void
    /// `DELETE /account` (contracts `deleteAccount`): 204, or an `APIError`.
    var deleteAccount: @Sendable () async throws -> Void

    static func live(client: APIClient, session: AuthSession) -> AccountDeletionRequests {
        AccountDeletionRequests(
            refreshToken: { try await session.refresh() },
            deleteAccount: { try await client.deleteAccount() }
        )
    }
}

/// Deletes the signed-in account (M2-T31; docs/04 Non-functional, account deletion in the app;
/// ADR 0017 and its Addendum; ADR 0031). One model for the app, built by `CupmarkApp`, so a
/// deletion goes on whatever screen is shown and after a restart.
///
/// 1. `start()`, the second confirmation: the record (`AccountDeletionRecord`, `requested`) is
///    saved in the Keychain first. If that fails nothing is done. Then the sync host is held
///    (`SyncHost.holdForAccountDeletion()`): the engine stops and the store closes, and from
///    now on nothing but `DELETE /account` is sent, for any account
///    (`AuthSession.maySend(as:)` and `SyncHost` read the record).
/// 2. The token is refreshed, then `DELETE /account` is sent. A 500, 429, any other failure
///    and a network failure (also of the refresh) are retried with `SyncBackoff` until a 204.
///    Later attempts of the same run use the token as it is (the client still refreshes it
///    when it is about to expire or on a 401), so a retry after a deletion that finished on
///    the server but lost its answer is still authorised (ADR 0017: a repeated `DELETE` with an
///    old token answers 204). Until the 204 the user stays signed in: nothing here signs out or
///    discards a token before it.
/// 3. If the token cannot be refreshed (`unauthorized`), the user is asked to sign in again:
///    a session that ended itself (`invalid_grant`) shows the sign-in screen, with the note
///    that signing in finishes the deletion; a session that is still saved is renewed with
///    `AuthModel.signInAgain()`, without a sign-out. The deletion then goes on with the new
///    token. A sign-in that gives another account (Cognito had already deleted the user, so the
///    same Apple ID is a new, empty account) moves the deletion to it, and its 204 leaves
///    nothing (ADR 0031).
/// 4. After the 204 the record becomes `serverDeleted`; then the local data of every account in
///    the record goes (`AccountLocalData`: the store with the outbox, the label photo folder
///    with its queued photos, the cached images, export files), then the sign-out (the Keychain
///    sign-in, `AuthModel.signOut(reason: .accountDeleted)`), and last the record itself. Every
///    step is safe to repeat, so a deletion interrupted after the 204 finishes at the next
///    start without another request.
@MainActor
@Observable
final class AccountDeletionModel {
    enum State: Equatable, Sendable {
        /// No deletion runs, or one is about to go on.
        case idle
        /// Refreshing the token, waiting for `DELETE /account`, or removing the local data.
        case deleting
        /// The last attempt failed (no network, 500, 429, ...). The next one runs by itself
        /// after the backoff; `resume()` runs it now.
        case waitingToRetry
        /// The token could not be refreshed: the user signs in again to go on.
        case signInRequired
        /// The local data could not all be removed after the 204. `resume()` tries again, and
        /// so does the next start.
        case cleanupFailed
        /// The record could not be saved, so the deletion did not start and nothing was sent.
        case couldNotStart
    }

    private(set) var state: State = .idle
    /// The running deletion's record, nil when none runs. Mirrors the Keychain item.
    private(set) var record: AccountDeletionRecord?

    /// True while a deletion runs: the app shows its progress instead of the shelf, and no
    /// sign-out button.
    var isActive: Bool {
        record != nil
    }

    /// True while `DELETE /account` has not answered 204: a sign-in now finishes the deletion,
    /// which the sign-in screen says.
    var awaitsServerDeletion: Bool {
        record?.phase == .requested
    }

    @ObservationIgnored private let records: any AccountDeletionStore
    @ObservationIgnored private let requests: AccountDeletionRequests
    @ObservationIgnored private let auth: AuthModel
    @ObservationIgnored private let sync: SyncHost?
    @ObservationIgnored private let localData: AccountLocalData
    @ObservationIgnored private let backoff: SyncBackoff
    @ObservationIgnored private let jitter: @Sendable () -> Double
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private var loaded = false
    /// The token is refreshed once per run, before its first `DELETE /account`.
    @ObservationIgnored private var tokenRefreshed = false
    @ObservationIgnored private var failedAttempts = 0
    /// The running deletion, nil when none runs. Tests await it.
    @ObservationIgnored private(set) var running: Task<Void, Never>?
    @ObservationIgnored private var nap: Task<Void, Never>?
    /// Counts the runs, so a run that ended only clears its own `running`.
    @ObservationIgnored private var runNumber = 0

    /// Nonisolated, so `CupmarkApp.init` can build it whatever its isolation. Reads nothing:
    /// `load()` reads the record.
    nonisolated init(
        records: any AccountDeletionStore,
        requests: AccountDeletionRequests,
        auth: AuthModel,
        sync: SyncHost?,
        localData: AccountLocalData = AccountLocalData(),
        backoff: SyncBackoff = SyncBackoff(),
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in try await Task.sleep(for: .seconds(seconds)) }
    ) {
        self.records = records
        self.requests = requests
        self.auth = auth
        self.sync = sync
        self.localData = localData
        self.backoff = backoff
        self.jitter = jitter
        self.sleep = sleep
    }

    /// Reads the record once. A Keychain that cannot be read yet (before the first unlock) is
    /// read again at the next call.
    func load() {
        guard !loaded else {
            return
        }
        do {
            record = try records.load()
            loaded = true
        } catch {
            record = nil
        }
    }

    /// The second confirmation's action: saves the record, holds the sync, then deletes. Only
    /// while signed in and no deletion runs.
    func start() {
        load()
        guard loaded, record == nil, running == nil, case .signedIn(let account) = auth.phase else {
            return
        }
        let started = AccountDeletionRecord(phase: .requested, account: account, localAccounts: [account])
        do {
            // Before anything is stopped or sent: a deletion is resumed only from this record.
            try records.save(started)
        } catch {
            state = .couldNotStart
            return
        }
        record = started
        state = .deleting
        tokenRefreshed = false
        failedAttempts = 0
        sync?.holdForAccountDeletion()
        launch()
    }

    /// Goes on with a recorded deletion: at launch, on every change of the signed-in account
    /// (`AccountDeletionModifier`), when the app comes to the foreground, and from the buttons
    /// of the progress screen. A retry that waits runs now. Without a record it does nothing.
    func resume() {
        load()
        guard record != nil else {
            return
        }
        sync?.holdForAccountDeletion()
        if running != nil {
            nap?.cancel()
            return
        }
        launch()
    }

    /// The progress screen's "Sign In Again" while the session is still saved but its token
    /// cannot be refreshed: a new sign-in without a sign-out (`AuthModel.signInAgain()`), then
    /// the deletion goes on.
    func signInAgain() async {
        guard await auth.signInAgain() else {
            return
        }
        resume()
    }

    /// Ends the running attempt and any wait without touching the record, as an ended app
    /// would; `resume()` goes on. The app never stops a deletion; tests do.
    func stop() {
        running?.cancel()
        running = nil
        nap?.cancel()
        nap = nil
    }

    // MARK: - Running

    private enum AttemptOutcome {
        case deleted
        case retry
        case signInRequired
        case cancelled
    }

    private func launch() {
        runNumber += 1
        let number = runNumber
        running = Task { [weak self] in
            await self?.proceed()
            // A run that `stop()` ended must not clear the run started after it.
            guard let self, self.runNumber == number else {
                return
            }
            self.running = nil
        }
    }

    private func proceed() async {
        while !Task.isCancelled, let current = record {
            // Restoring the sign-in at launch, or a sign-in under way: `resume()` is called again
            // when the account changes.
            if auth.phase == .restoring || auth.phase == .signingIn {
                return
            }
            switch current.phase {
            case .serverDeleted:
                await finish(current)
                return
            case .requested:
                guard case .signedIn(let signedIn) = auth.phase else {
                    // The session ended itself (the refresh failed): the sign-in screen asks
                    // for a new sign-in, which finishes the deletion.
                    state = .signInRequired
                    return
                }
                let target = retargeted(current, to: signedIn)
                state = .deleting
                switch await attempt() {
                case .deleted:
                    var done = target
                    done.phase = .serverDeleted
                    // If this save fails, a restart sends `DELETE /account` once more, which
                    // answers 204 again (ADR 0017, Addendum), and then cleans up.
                    try? records.save(done)
                    record = done
                    failedAttempts = 0
                case .retry:
                    failedAttempts += 1
                    state = .waitingToRetry
                    await rest(for: backoff.delay(afterAttempt: failedAttempts, jitter: jitter()))
                case .signInRequired:
                    state = .signInRequired
                    return
                case .cancelled:
                    return
                }
            }
        }
    }

    /// The record for the signed-in account. The same account keeps it. Another one is only
    /// possible after the sign-in this deletion asked for (the progress screen replaces every
    /// other screen and offers no sign-out): Cognito had deleted the user, so the same Apple ID
    /// came back as a new account, and the deletion goes on with it (ADR 0031). The local data
    /// of both goes after the 204.
    private func retargeted(_ current: AccountDeletionRecord, to signedIn: AccountID) -> AccountDeletionRecord {
        guard current.account != signedIn else {
            return current
        }
        let next = AccountDeletionRecord(phase: .requested, account: signedIn, localAccounts: current.localAccounts)
        // A failed save is repeated by the next run: the record still names the old account,
        // and the sign-in is still the new one.
        try? records.save(next)
        record = next
        tokenRefreshed = false
        return next
    }

    /// One attempt: the token is refreshed first once per run, then `DELETE /account`.
    private func attempt() async -> AttemptOutcome {
        do {
            if !tokenRefreshed {
                try await requests.refreshToken()
                tokenRefreshed = true
            }
            try await requests.deleteAccount()
            return .deleted
        } catch {
            if Task.isCancelled || error is CancellationError {
                return .cancelled
            }
            // A failed refresh is `unauthorized` only when the user must sign in again; a
            // network failure, a Cognito 5xx or 429 is retried (`APIClient.tokenFailure`).
            let failure = (error as? APIError) ?? APIClient.tokenFailure(error)
            return failure == .unauthorized ? .signInRequired : .retry
        }
    }

    /// Waits `seconds`, or until `resume()` or `stop()` ends the wait.
    private func rest(for seconds: TimeInterval) async {
        let sleep = self.sleep
        let nap = Task<Void, Never> {
            _ = try? await sleep(seconds)
        }
        self.nap = nap
        await nap.value
        self.nap = nil
    }

    /// After the 204: the local data, the sign-out, then the record. Safe to repeat.
    private func finish(_ current: AccountDeletionRecord) async {
        state = .deleting
        sync?.holdForAccountDeletion()
        do {
            for account in current.localAccounts {
                try localData.remove(account)
            }
        } catch {
            state = .cleanupFailed
            return
        }
        localData.removeCaches()
        // Only an account of this deletion is signed out; once it is signed out, nobody is.
        if let signedIn = auth.accountID, current.localAccounts.contains(signedIn) {
            await auth.signOut(reason: .accountDeleted)
        }
        do {
            try records.delete()
        } catch {
            // Left for the next start, which runs the steps above again and finds nothing to do.
        }
        record = nil
        state = .idle
        // An account that is not part of this deletion and signed in while the cleanup waited
        // (signed out, after a failed cleanup) gets its store back once the record is gone. While
        // the record could not be removed, `SyncHost` still opens none.
        sync?.switchTo(auth.accountID)
    }
}
