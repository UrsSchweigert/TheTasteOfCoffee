import Foundation
import Observation

/// The two requests account deletion makes (M2-T31), each for one account, and the check of
/// the saved sign-in. `live` uses the app's `AuthSession` and `APIClient`; tests can use the
/// same with stubs.
struct AccountDeletionRequests: Sendable {
    /// Gets a new access token for this account (`AuthSession.refresh(for:)`); throws when
    /// another account is signed in before or after.
    var refreshToken: @Sendable (AccountID) async throws -> Void
    /// `DELETE /account` (contracts `deleteAccount`) with this account's token only
    /// (`AccountTokenProvider`): 204, or an `APIError` (`unauthorized` when another account
    /// signed in meanwhile).
    var deleteAccount: @Sendable (AccountID) async throws -> Void
    /// The account of the saved sign-in, nil when nobody is signed in.
    var signedInAccount: @Sendable () async -> AccountID?

    static func live(client: APIClient, session: AuthSession) -> AccountDeletionRequests {
        AccountDeletionRequests(
            refreshToken: { account in try await session.refresh(for: account) },
            deleteAccount: { account in try await client.deleteAccount(tokens: AccountTokenProvider(session: session, account: account)) },
            signedInAccount: { await session.signedInAccount() }
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
///    (`AuthSession.maySend(as:)` and `SyncHost` read the record). Nothing local is deleted.
/// 2. Each run (the start, every resume) refreshes the token once, then sends
///    `DELETE /account`. A 500, 429, any other failure and a network failure (also of the
///    refresh) are retried with `SyncBackoff` until a 204. Later attempts of the same run use
///    the token as it is (the client still refreshes it when it is about to expire or on a
///    401), so a retry after a deletion that finished on the server but lost its answer is
///    still authorised (ADR 0017: a repeated `DELETE` with an old token answers 204). Until the
///    204 the user stays signed in: nothing here signs out or discards a token before it.
/// 3. If the token cannot be refreshed (`unauthorized`), the user is asked to sign in again:
///    a session that ended itself (`invalid_grant`) shows the sign-in screen; a session that is
///    still saved is renewed with `AuthModel.signInAgain()`, without a sign-out. The same
///    account goes on at once. A different account is never deleted without the user's tap
///    (`confirmDifferentAccount`, ADR 0031): the app cannot tell a new Cognito user made for
///    the same Apple ID (the old one already deleted) from another Apple ID. "Delete This
///    Account" moves the record to it; "Sign Out" signs that session out and keeps the record.
///    The prompt is derived from the saved sign-in and the record, so a restart shows it again.
///    A record that cannot be decoded asks the same before the signed-in account is deleted.
/// 4. After the 204 the record becomes `serverDeleted`; then the local data of every account in
///    the record goes (`AccountLocalData`: the store with the outbox, the label photo folder
///    with its queued photos, the brew photo folder (M2-T42), the cached images, export files),
///    then the sign-out (the Keychain
///    sign-in, with `accountDeleted`, or `otherAccountDeleted` when the record was moved), and
///    last the record itself. Every step is safe to repeat.
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
        /// Signed in with another account than the one being deleted. Nothing is sent until the
        /// user taps "Delete This Account" or "Sign Out".
        case confirmDifferentAccount
        /// The saved record cannot be decoded. Nothing is sent until the user taps "Delete
        /// This Account" (the signed-in one) or "Sign Out".
        case confirmUnreadableRecord
        /// The local data could not all be removed after the 204. `resume()` tries again, and
        /// so does the next start.
        case cleanupFailed
        /// The record could not be saved, so the deletion did not start and nothing was sent.
        case couldNotStart
    }

    private(set) var state: State = .idle
    /// The running deletion's record, nil when none runs or when it cannot be decoded.
    /// Mirrors the Keychain item.
    private(set) var record: AccountDeletionRecord?
    /// True when a record is saved but cannot be decoded (`AccountDeletionStoreError`). It is
    /// never deleted for that; it holds sync like any record.
    private(set) var recordUnreadable = false
    /// Why the last "Sign In Again" failed, nil after a success or a new try.
    private(set) var signInAgainFailure: AuthModel.Failure?
    /// The signed-in account the confirmation (`confirmDifferentAccount`,
    /// `confirmUnreadableRecord`) was worked out for. "Delete This Account" deletes only that
    /// account.
    private(set) var confirmationAccount: AccountID?

    /// True while a deletion runs: the app shows its progress instead of the shelf, and no
    /// sign-out button.
    var isActive: Bool {
        record != nil || recordUnreadable
    }

    /// True while `DELETE /account` has not answered 204: a sign-in now finishes the deletion,
    /// which the sign-in screen says.
    var awaitsServerDeletion: Bool {
        record?.phase == .requested || recordUnreadable
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
    /// Set at the start of every run: the token is refreshed before its first `DELETE /account`.
    @ObservationIgnored private var tokenRefreshed = false
    @ObservationIgnored private var failedAttempts = 0
    /// The running deletion, nil when none runs. Tests await it.
    @ObservationIgnored private(set) var running: Task<Void, Never>?
    @ObservationIgnored private var nap: Task<Void, Never>?
    /// Counts the runs, so a run that ended only clears its own `running`.
    @ObservationIgnored private var runNumber = 0
    /// `resume()` was called while a run was under way (for example the scene became active
    /// again after the web sheet): one more run follows when it ends, so a state it saw too
    /// early (a sign-in that had not finished) is never the last word.
    @ObservationIgnored private var runAgain = false

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
    /// read again at the next call. A record that cannot be decoded is kept and counts as a
    /// running deletion (`recordUnreadable`).
    func load() {
        guard !loaded else {
            return
        }
        do {
            record = try records.load()
            recordUnreadable = false
            loaded = true
        } catch AccountDeletionStoreError.unreadableRecord {
            record = nil
            recordUnreadable = true
            loaded = true
        } catch {
            record = nil
        }
    }

    /// The second confirmation's action: saves the record, holds the sync, then deletes. Only
    /// while signed in and no deletion runs.
    func start() {
        load()
        guard loaded, !isActive, running == nil, case .signedIn(let account) = auth.phase else {
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
        failedAttempts = 0
        runAgain = false
        sync?.holdForAccountDeletion()
        launch()
    }

    /// Goes on with a recorded deletion: at launch, on every change of the signed-in account
    /// (`AccountDeletionModifier`), when the app comes to the foreground, and from the buttons
    /// of the progress screen. A retry that waits runs now; a run under way is followed by
    /// another one. Without a record it does nothing.
    func resume() {
        load()
        guard isActive else {
            return
        }
        sync?.holdForAccountDeletion()
        // A sign-in under way (also "Sign In Again" while signed in) may still replace the
        // session; `signInAgain()` resumes when it succeeded, an account change resumes too.
        if auth.isSigningInAgain || auth.phase == .signingIn {
            return
        }
        if running != nil {
            runAgain = true
            nap?.cancel()
            return
        }
        launch()
    }

    /// The progress screen's "Sign In Again" while the session is still saved but its token
    /// cannot be refreshed: a new sign-in without a sign-out (`AuthModel.signInAgain()`), then
    /// the deletion goes on. A failure is kept for the screen (`signInAgainFailure`).
    func signInAgain() async {
        signInAgainFailure = nil
        switch await auth.signInAgain() {
        case .succeeded:
            resume()
        case .failed(let failure):
            signInAgainFailure = failure
        case .cancelled, .notAvailable:
            break
        }
    }

    /// "Delete This Account" (`confirmDifferentAccount`, `confirmUnreadableRecord`): the user
    /// chose to delete the account signed in now. The record moves to it (its local data and
    /// the old account's go after the 204), or, for an unreadable record, a new record for it
    /// replaces that one. Only now may `DELETE /account` be sent for this account.
    func deleteSignedInAccount() {
        guard state == .confirmDifferentAccount || state == .confirmUnreadableRecord,
              case .signedIn(let signedIn) = auth.phase, !auth.isSigningInAgain else {
            return
        }
        guard signedIn == confirmationAccount else {
            // The session changed since the prompt was shown: work it out again for the
            // account signed in now, and wait for a new tap.
            resume()
            return
        }
        let next: AccountDeletionRecord
        if let record {
            next = AccountDeletionRecord(phase: .requested, account: signedIn, localAccounts: record.localAccounts)
        } else {
            next = AccountDeletionRecord(phase: .requested, account: signedIn, localAccounts: [signedIn])
        }
        // If the save fails, the deletion goes on in memory; a restart reads the old record and
        // asks again, so nothing is deleted without a tap.
        try? records.save(next)
        record = next
        recordUnreadable = false
        confirmationAccount = nil
        state = .deleting
        failedAttempts = 0
        resume()
    }

    /// "Sign Out" (`confirmDifferentAccount`, `confirmUnreadableRecord`): signs out of the
    /// session signed in now, which is not the account being deleted, and deletes nothing. The
    /// record stays, so the sign-in screen still asks to finish the deletion.
    func signOutOfSignedInAccount() async {
        guard state == .confirmDifferentAccount || state == .confirmUnreadableRecord else {
            return
        }
        await auth.signOut()
        signInAgainFailure = nil
        confirmationAccount = nil
        state = .signInRequired
    }

    /// Ends the running attempt and any wait without touching the record, as an ended app
    /// would; `resume()` goes on. The app never stops a deletion; tests do.
    func stop() {
        runAgain = false
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
        /// Another account's session was saved during the attempt: nothing was sent for it.
        case accountChanged
        case cancelled
    }

    private func launch() {
        runNumber += 1
        let number = runNumber
        runAgain = false
        running = Task { [weak self] in
            await self?.proceed()
            // A run that `stop()` ended must not clear the run started after it.
            guard let self, self.runNumber == number else {
                return
            }
            self.running = nil
            if self.runAgain, !Task.isCancelled {
                self.launch()
            }
        }
    }

    private func proceed() async {
        // Every run refreshes the token before its first request (ADR 0031, point 3).
        tokenRefreshed = false
        // A sign-in under way may still replace the session: no run until it ends.
        if auth.isSigningInAgain {
            return
        }
        if recordUnreadable {
            switch auth.phase {
            case .signedIn(let signedIn):
                confirmationAccount = signedIn
                state = .confirmUnreadableRecord
            case .signedOut:
                state = .signInRequired
            case .restoring, .signingIn:
                break
            }
            return
        }
        while !Task.isCancelled, let current = record {
            // Restoring the sign-in at launch, or a sign-in under way: `resume()` is called again
            // when the account changes.
            if auth.phase == .restoring || auth.phase == .signingIn || auth.isSigningInAgain {
                return
            }
            switch current.phase {
            case .serverDeleted:
                await finish(current)
                return
            case .requested:
                guard case .signedIn(let signedIn) = auth.phase else {
                    // The session ended itself (the refresh failed): the sign-in screen asks
                    // for a new sign-in.
                    state = .signInRequired
                    return
                }
                guard signedIn == current.account else {
                    // Another account: never deleted without the user's tap.
                    confirmationAccount = signedIn
                    state = .confirmDifferentAccount
                    return
                }
                state = .deleting
                switch await attempt(for: current.account) {
                case .deleted:
                    var done = current
                    done.phase = .serverDeleted
                    // If this save fails, the record still says `requested`. A restart then
                    // refreshes and sends `DELETE /account` again: within the old token's
                    // lifetime that answers 204 (ADR 0017, Addendum), but the refresh for a
                    // user Cognito deleted fails, so the user is asked to sign in again, and a
                    // new sign-in is a different account, which is only deleted after a tap.
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
                case .accountChanged:
                    // A sign-in landed during the attempt. Nothing was sent for that account.
                    // The prompt is shown, but its account is not known for sure yet (the
                    // model may not have seen the new session), so "Delete This Account" only
                    // works it out again (`confirmationAccount` nil) and needs another tap.
                    confirmationAccount = nil
                    state = .confirmDifferentAccount
                    return
                case .cancelled:
                    return
                }
            }
        }
    }

    /// One attempt for `target` (the record's account): the token is refreshed first once per
    /// run, then `DELETE /account`. Right before the request the saved sign-in is checked again,
    /// and the request itself only takes `target`'s token (`AccountTokenProvider`), so a sign-in
    /// of another account that lands during the attempt never gets its account deleted.
    private func attempt(for target: AccountID) async -> AttemptOutcome {
        do {
            if !tokenRefreshed {
                try await requests.refreshToken(target)
                tokenRefreshed = true
            }
            if let changed = await accountChange(from: target) {
                return changed
            }
            try await requests.deleteAccount(target)
            return .deleted
        } catch {
            if Task.isCancelled || error is CancellationError {
                return .cancelled
            }
            // A failed refresh is `unauthorized` only when the user must sign in again; a
            // network failure, a Cognito 5xx or 429 is retried (`APIClient.tokenFailure`).
            let failure = (error as? APIError) ?? APIClient.tokenFailure(error)
            guard failure == .unauthorized else {
                return .retry
            }
            return await accountChange(from: target) ?? .signInRequired
        }
    }

    /// `accountChanged` when another account's sign-in is saved now, `signInRequired` when none
    /// is, nil while `target` is still the signed-in account.
    private func accountChange(from target: AccountID) async -> AttemptOutcome? {
        guard let current = await requests.signedInAccount() else {
            return .signInRequired
        }
        return current == target ? nil : .accountChanged
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
        // The note says which account was deleted: never the original one when it was moved.
        if let signedIn = auth.accountID, current.localAccounts.contains(signedIn) {
            await auth.signOut(reason: current.wasMovedToAnotherAccount ? .otherAccountDeleted : .accountDeleted)
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
