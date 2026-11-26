import Security
import XCTest
@testable import Cupmark

/// Account deletion on the device (M2-T31, ADR 0017 and its Addendum, ADR 0031): the record
/// saved before the first request, the sync held, retries until a 204, no sign-out before it,
/// the local data and the sign-in removed after it, a restart, and a refresh that fails.
///
/// Each test runs the real `AuthModel`, `AuthSession`, `APIClient`, `SyncHost` and on-disk
/// stores in a temporary folder, with a fake token endpoint, a fake web sheet and a
/// `StubServer` for the API. Every `StubServer` is a local that the test reads after its last
/// request, so the stub registry (which holds servers weakly) keeps it for the whole test.
@MainActor
final class AccountDeletionTests: XCTestCase {
    private let account = AccountID(subject: AuthFixtures.subject)
    private let newAccount = AccountID(subject: AuthFixtures.otherSubject)
    private let bystander = AccountID(subject: "another-account-on-this-device")
    private let root = FileManager.default.temporaryDirectory.appending(path: "AccountDeletionTests-\(UUID().uuidString)", directoryHint: .isDirectory)

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private var stores: URL { root.appending(path: "Accounts", directoryHint: .isDirectory) }
    private var photos: LabelPhotoFolders { LabelPhotoFolders(root: root.appending(path: "LabelPhotos", directoryHint: .isDirectory)) }
    private var images: URL { root.appending(path: "CatalogueImages", directoryHint: .isDirectory) }
    private var exports: ExportFileStore { ExportFileStore(root: root.appending(path: "CupmarkExport", directoryHint: .isDirectory)) }
    private var localData: AccountLocalData {
        AccountLocalData(storesDirectory: stores, labelPhotos: photos, catalogueImages: images, exports: exports)
    }

    // MARK: - Harness

    /// One launch of the app: what `CupmarkApp` builds, with fakes at the edges.
    private struct Launch {
        let auth: AuthModel
        let session: AuthSession
        let endpoint: FakeTokenEndpoint
        let host: SyncHost
        let deletion: AccountDeletionModel
        let opened: DeletionCounter
    }

    private func launch(
        server: StubServer,
        credentials: FakeCredentialStore,
        records: FakeAccountDeletionStore,
        endpoint: FakeTokenEndpoint = FakeTokenEndpoint(),
        respond: @escaping (URL) throws -> URL = FakeWebAuthenticator.returningCode("code-2"),
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in }
    ) async throws -> Launch {
        let session = AuthSession(endpoint: endpoint, store: credentials, isSendingHeld: { records.holdsSending })
        let auth = AuthModel(
            hostedUI: try AuthFixtures.devHostedUI(),
            session: session,
            authenticator: FakeWebAuthenticator(respond: respond)
        )
        let client = APIClient(baseURL: server.baseURL, tokenProvider: session, session: server.makeSession(), imageCache: nil)
        let stores = self.stores
        let opened = DeletionCounter()
        let host = SyncHost(
            makeStore: { account in
                opened.increment()
                return try AccountStore.open(for: account, in: stores)
            },
            makeEngine: { account, store in
                SyncEngine(store: store, client: client, isCurrentAccount: {
                    await session.maySend(as: account)
                })
            },
            labelPhotos: photos,
            isHeld: { records.holdsSending }
        )
        let deletion = AccountDeletionModel(
            records: records,
            requests: .live(client: client, session: session),
            auth: auth,
            sync: host,
            localData: localData,
            jitter: { 0 },
            sleep: sleep
        )
        deletion.load()
        await auth.start()
        host.switchTo(auth.accountID)
        return Launch(auth: auth, session: session, endpoint: endpoint, host: host, deletion: deletion, opened: opened)
    }

    private func signedIn(_ account: AccountID, refreshToken: String = "refresh-1") -> FakeCredentialStore {
        FakeCredentialStore(StoredCredential(refreshToken: refreshToken, accountID: account))
    }

    /// The account's store with one recipe and its queued create, a screen photo, a queued
    /// photo, a cached catalogue image and an export file.
    private func seedLocalData(of account: AccountID) throws {
        do {
            let store = try AccountStore.open(for: account, in: stores)
            try store.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
            XCTAssertEqual(try store.outboxOperations().count, 1)
        }
        _ = try photos.store(for: account).write(LabelPhotoFixtures.jpeg)
        _ = try photos.queue(for: account).write(LabelPhotoFixtures.jpeg)
        try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
        try LabelPhotoFixtures.jpeg.write(to: images.appending(path: "01JDQ6Y8Z5W4V3T2S1R0P9N8M0.jpg", directoryHint: .notDirectory))
        _ = try exports.write(Data("record_type\n".utf8), on: Date())
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    private func assertLocalDataGone(of account: AccountID, file: StaticString = #filePath, line: UInt = #line) throws {
        for url in try localData.storeFiles(of: account) {
            XCTAssertFalse(exists(url), "the store file \(url.lastPathComponent) is gone", file: file, line: line)
        }
        XCTAssertFalse(exists(photos.store(for: account).directory), "the label photo folder is gone, Queued included", file: file, line: line)
        XCTAssertFalse(exists(images), "the cached images are gone", file: file, line: line)
        XCTAssertFalse(exists(exports.root), "the export files are gone", file: file, line: line)
    }

    private func revokes(_ endpoint: FakeTokenEndpoint) async -> [FakeTokenEndpoint.Call] {
        let calls = await endpoint.calls
        return calls.filter { call in
            if case .revoke = call {
                return true
            }
            return false
        }
    }

    /// Lets the status handler's main-actor hop run.
    private func settle() async {
        for _ in 0..<20 {
            await Task.yield()
        }
    }

    /// Waits on the main actor until `condition` holds, at most `timeout` seconds.
    private func waitUntil(timeout: TimeInterval = 10, _ message: String, _ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while try !condition() {
            guard Date() < deadline else {
                XCTFail("timed out: \(message)")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: - Acceptance

    func testThreeServerErrorsThenA204SignOutExactlyOnceAndLeaveTheStoreEmpty() async throws {
        let script = DeleteScript([500, 500, 500, 204])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        try seedLocalData(of: account)
        let delays = DelayRecorder()
        let app = try await launch(server: server, credentials: credentials, records: records, sleep: { seconds in delays.append(seconds) })
        XCTAssertEqual(app.auth.phase, .signedIn(account))
        XCTAssertNotNil(app.host.engine, "the outbox runs before the deletion")

        app.deletion.start()
        XCTAssertEqual(records.record, AccountDeletionRecord(phase: .requested, account: account, localAccounts: [account]), "saved before the first request")
        XCTAssertTrue(app.deletion.isActive)
        XCTAssertNil(app.host.engine, "the outbox stops")
        XCTAssertNil(app.host.store)
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(server.requests.map { "\($0.method) \($0.path)" }, Array(repeating: "DELETE /account", count: 4), "nothing but the deletion is sent")
        XCTAssertEqual(server.requests.map { $0.header("Authorization") }, Array(repeating: "Bearer access-2", count: 4))
        XCTAssertEqual(delays.count, 3, "each 500 backs off")
        XCTAssertEqual(delays.values, [1, 2, 4], "SyncBackoff with no jitter")
        let refreshes = await app.endpoint.refreshCount
        XCTAssertEqual(refreshes, 1, "the token is refreshed once, before the first DELETE /account")
        let revoked = await revokes(app.endpoint)
        XCTAssertEqual(revoked, [.revoke("refresh-1")], "signed out exactly once, after the 204")
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertEqual(app.auth.failure, .accountDeleted)
        XCTAssertNil(credentials.credential, "the sign-in is gone from the Keychain")
        XCTAssertNil(records.record, "the record goes last")
        XCTAssertFalse(app.deletion.isActive)
        XCTAssertEqual(app.deletion.state, .idle)
        try assertLocalDataGone(of: account)
    }

    func testNoSignOutOnA500() async throws {
        let script = DeleteScript([500])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        try seedLocalData(of: account)
        let delays = DelayRecorder()
        let app = try await launch(server: server, credentials: credentials, records: records, sleep: { seconds in
            delays.append(seconds)
            if delays.count >= 3 {
                try await Task.sleep(for: .seconds(3600))
            }
        })

        app.deletion.start()
        try await waitUntil("three failed attempts") { delays.count >= 3 }
        await settle()

        XCTAssertEqual(server.requests.count, 3)
        XCTAssertEqual(app.deletion.state, .waitingToRetry)
        XCTAssertTrue(app.deletion.isActive)
        XCTAssertEqual(app.auth.phase, .signedIn(account), "the user stays signed in until a 204")
        XCTAssertNil(app.auth.failure)
        XCTAssertEqual(credentials.credential?.accountID, account, "no token is discarded")
        let revoked = await revokes(app.endpoint)
        XCTAssertTrue(revoked.isEmpty)
        XCTAssertEqual(records.record?.phase, .requested)
        for url in try localData.storeFiles(of: account).prefix(1) {
            XCTAssertTrue(exists(url), "nothing local is deleted before the 204")
        }
        XCTAssertTrue(exists(images), "the cached images stay until the 204")
        app.deletion.stop()
    }

    func testTheDeletionResumesAfterARestart() async throws {
        let script = DeleteScript([500])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        try seedLocalData(of: account)
        let delays = DelayRecorder()
        do {
            let first = try await launch(server: server, credentials: credentials, records: records, sleep: { seconds in
                delays.append(seconds)
                try await Task.sleep(for: .seconds(3600))
            })
            first.deletion.start()
            try await waitUntil("the first attempt failed") { delays.count >= 1 }
            // The app is ended while it waits to retry.
            first.deletion.stop()
        }
        XCTAssertEqual(records.record, AccountDeletionRecord(phase: .requested, account: account, localAccounts: [account]))
        XCTAssertEqual(credentials.credential?.accountID, account, "still signed in")
        // A queued label photo of the account, on disk when the app starts again.
        let queued = try photos.queue(for: account).write(LabelPhotoFixtures.jpeg)

        script.setStatuses([204])
        let endpoint = FakeTokenEndpoint()
        let second = try await launch(server: server, credentials: credentials, records: records, endpoint: endpoint)
        XCTAssertEqual(second.auth.phase, .signedIn(account))
        XCTAssertTrue(second.deletion.isActive, "the progress is shown, not the shelf")
        XCTAssertNil(second.host.store, "no store is opened while the deletion is recorded")
        XCTAssertNil(second.host.engine)
        XCTAssertEqual(second.opened.count, 0)
        let maySend = await second.session.maySend(as: account)
        XCTAssertFalse(maySend)

        second.deletion.resume()
        await second.deletion.running?.value
        await settle()

        XCTAssertEqual(server.requests.map(\.path), ["/account", "/account"])
        let refreshes = await endpoint.refreshCount
        XCTAssertEqual(refreshes, 1, "after the restart the token is refreshed, then DELETE /account is sent")
        XCTAssertEqual(server.requests.last?.header("Authorization"), "Bearer access-2")
        let revoked = await revokes(endpoint)
        XCTAssertEqual(revoked, [.revoke("refresh-1")])
        XCTAssertEqual(second.auth.phase, .signedOut)
        XCTAssertNil(records.record)
        XCTAssertFalse(exists(queued))
        try assertLocalDataGone(of: account)
    }

    func testARefreshThatFailsAsksForSignInAndTheNewEmptyAccountIsDeletedToo() async throws {
        let script = DeleteScript([204])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        try seedLocalData(of: account)
        // Cognito had already deleted the user: the old refresh token is refused, and the same
        // Apple ID signs in as a new user with another `sub`.
        let endpoint = FakeTokenEndpoint(
            exchange: { try AuthFixtures.tokenResponse(access: "access-new", subject: AuthFixtures.otherSubject, refresh: "refresh-new") },
            refresh: { throw AuthError.invalidGrant }
        )
        let app = try await launch(server: server, credentials: credentials, records: records, endpoint: endpoint)

        app.deletion.start()
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(app.deletion.state, .signInRequired)
        XCTAssertTrue(server.requests.isEmpty, "no DELETE /account without a fresh token")
        XCTAssertEqual(app.auth.phase, .signedOut, "the session ended itself; the sign-in screen asks to sign in again")
        XCTAssertTrue(app.deletion.awaitsServerDeletion, "and says that signing in finishes the deletion")
        XCTAssertEqual(records.record?.account, account)
        let revokedBefore = await revokes(endpoint)
        XCTAssertTrue(revokedBefore.isEmpty, "the app signed nobody out")
        for url in try localData.storeFiles(of: account).prefix(1) {
            XCTAssertTrue(exists(url), "the local data waits for the 204")
        }

        await endpoint.setRefresh { try AuthFixtures.tokenResponse(access: "access-new-2", subject: AuthFixtures.otherSubject, refresh: nil) }
        await app.auth.signIn()
        XCTAssertEqual(app.auth.phase, .signedIn(newAccount))
        app.host.switchTo(newAccount)
        XCTAssertNil(app.host.store, "the new account's store is not opened during the deletion")
        app.deletion.resume()
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(server.requests.map { "\($0.method) \($0.path)" }, ["DELETE /account"])
        XCTAssertEqual(server.requests.first?.header("Authorization"), "Bearer access-new-2", "retried with the new token, refreshed first")
        let revoked = await revokes(endpoint)
        XCTAssertEqual(revoked, [.revoke("refresh-new")])
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertEqual(app.auth.failure, .accountDeleted)
        XCTAssertNil(credentials.credential)
        XCTAssertNil(records.record)
        try assertLocalDataGone(of: account)
        for url in try localData.storeFiles(of: newAccount) {
            XCTAssertFalse(exists(url), "nothing of the new account is left")
        }
    }

    func testARefreshThatFailsThenASignInAsTheSameAccountRetriesWithTheNewToken() async throws {
        let script = DeleteScript([204])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        let endpoint = FakeTokenEndpoint(
            exchange: { try AuthFixtures.tokenResponse(access: "access-again", refresh: "refresh-again") },
            refresh: { throw AuthError.invalidGrant }
        )
        let app = try await launch(server: server, credentials: credentials, records: records, endpoint: endpoint)
        app.deletion.start()
        await app.deletion.running?.value
        await settle()
        XCTAssertEqual(app.deletion.state, .signInRequired)

        await endpoint.setRefresh { try AuthFixtures.tokenResponse(access: "access-again-2", refresh: nil) }
        await app.auth.signIn()
        XCTAssertEqual(app.auth.phase, .signedIn(account))
        app.deletion.resume()
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(server.requests.map { $0.header("Authorization") }, ["Bearer access-again-2"])
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertNil(records.record)
    }

    // MARK: - Nothing more is sent

    func testNothingButTheDeletionIsSentOnceItStartedAlsoAfterAKickAForegroundOrASwitch() async throws {
        let script = DeleteScript([500])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore()
        try seedLocalData(of: account)
        let delays = DelayRecorder()
        let app = try await launch(server: server, credentials: credentials, records: records, sleep: { seconds in
            delays.append(seconds)
            try await Task.sleep(for: .seconds(3600))
        })
        XCTAssertNotNil(app.host.engine, "the recipe's create is queued and the engine runs")

        app.deletion.start()
        try await waitUntil("the first attempt failed") { delays.count >= 1 }
        // What would start the outbox again: a local save's kick, the foreground, an account change.
        app.host.kick()
        app.host.sceneBecameActive()
        app.host.switchTo(account)
        XCTAssertNil(app.host.engine)
        XCTAssertNil(app.host.store)
        let maySend = await app.session.maySend(as: account)
        XCTAssertFalse(maySend, "label photo uploads and any other sender are refused too")
        try await Task.sleep(for: .milliseconds(300))

        XCTAssertEqual(server.requests.map { "\($0.method) \($0.path)" }, ["DELETE /account"])
        XCTAssertEqual(app.opened.count, 1, "the store is not opened again")
        app.deletion.stop()
    }

    func testOtherFailuresAreRetriedUntilA204() async throws {
        let script = DeleteScript([429, 0, 503, 502, 204])
        let server = try StubServer { request in try script.respond(to: request) }
        let records = FakeAccountDeletionStore()
        let delays = DelayRecorder()
        let app = try await launch(server: server, credentials: signedIn(account), records: records, sleep: { seconds in delays.append(seconds) })

        app.deletion.start()
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(server.requests.count, 5)
        XCTAssertEqual(delays.count, 4)
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertNil(records.record)
    }

    func testARefreshThatFailsOfflineIsRetried() async throws {
        let script = DeleteScript([204])
        let server = try StubServer { request in try script.respond(to: request) }
        let records = FakeAccountDeletionStore()
        let endpoint = FakeTokenEndpoint(refresh: { throw APIError.transport(.notConnectedToInternet) })
        let delays = DelayRecorder()
        let app = try await launch(server: server, credentials: signedIn(account), records: records, endpoint: endpoint, sleep: { seconds in
            delays.append(seconds)
            await endpoint.setRefresh { try AuthFixtures.tokenResponse(access: "access-online", refresh: nil) }
        })

        app.deletion.start()
        await app.deletion.running?.value
        await settle()

        XCTAssertEqual(delays.count, 1, "a refresh without network backs off like a failed request")
        XCTAssertEqual(server.requests.map { $0.header("Authorization") }, ["Bearer access-online"])
        XCTAssertEqual(app.auth.phase, .signedOut)
    }

    func testARecordThatCannotBeSavedStartsNothing() async throws {
        let script = DeleteScript([204])
        let server = try StubServer { request in try script.respond(to: request) }
        let records = FakeAccountDeletionStore()
        records.failSaves(with: .keychain(-25308))
        let app = try await launch(server: server, credentials: signedIn(account), records: records)

        app.deletion.start()

        XCTAssertEqual(app.deletion.state, .couldNotStart)
        XCTAssertFalse(app.deletion.isActive)
        XCTAssertNil(app.deletion.running)
        XCTAssertNotNil(app.host.engine, "the outbox goes on")
        XCTAssertEqual(app.auth.phase, .signedIn(account))
        XCTAssertTrue(server.requests.isEmpty)
        app.host.switchTo(nil)
    }

    // MARK: - Interrupted after the 204

    func testACleanupInterruptedAfterThe204FinishesWithoutAnotherRequest() async throws {
        let script = DeleteScript([500])
        let server = try StubServer { request in try script.respond(to: request) }
        let credentials = signedIn(account)
        let records = FakeAccountDeletionStore(AccountDeletionRecord(phase: .serverDeleted, account: account, localAccounts: [account]))
        try seedLocalData(of: account)
        let app = try await launch(server: server, credentials: credentials, records: records)
        XCTAssertNil(app.host.store)

        app.deletion.resume()
        await app.deletion.running?.value
        await settle()

        XCTAssertTrue(server.requests.isEmpty, "the server already answered 204")
        let refreshes = await app.endpoint.refreshCount
        XCTAssertEqual(refreshes, 0)
        let revoked = await revokes(app.endpoint)
        XCTAssertEqual(revoked, [.revoke("refresh-1")])
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertNil(records.record)
        try assertLocalDataGone(of: account)
    }

    func testACleanupInterruptedAfterTheSignOutOnlyRemovesWhatIsLeft() async throws {
        let script = DeleteScript([500])
        let server = try StubServer { request in try script.respond(to: request) }
        let records = FakeAccountDeletionStore(AccountDeletionRecord(phase: .serverDeleted, account: account, localAccounts: [account]))
        let app = try await launch(server: server, credentials: FakeCredentialStore(), records: records)
        XCTAssertEqual(app.auth.phase, .signedOut)
        XCTAssertFalse(app.deletion.awaitsServerDeletion, "the sign-in screen does not ask to finish a deletion the server did")

        app.deletion.resume()
        await app.deletion.running?.value

        XCTAssertTrue(server.requests.isEmpty)
        let revoked = await revokes(app.endpoint)
        XCTAssertTrue(revoked.isEmpty, "nobody to sign out")
        XCTAssertNil(records.record)
        XCTAssertFalse(app.deletion.isActive)
    }

    // MARK: - Parts

    func testLocalDataRemovesTheAccountsStoreAndPhotosOnlyAndCanRunTwice() throws {
        try seedLocalData(of: account)
        let otherQueued = try photos.queue(for: bystander).write(LabelPhotoFixtures.jpeg)
        do {
            let other = try AccountStore.open(for: bystander, in: stores)
            try other.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
        }

        try localData.remove(account)
        try localData.remove(account)
        localData.removeCaches()

        try assertLocalDataGone(of: account)
        let reopened = try AccountStore.open(for: account, in: stores)
        XCTAssertTrue(try reopened.recipes().isEmpty)
        XCTAssertTrue(try reopened.outboxOperations().isEmpty, "the outbox went with the store")
        XCTAssertTrue(exists(otherQueued), "another account's photos stay")
        let other = try AccountStore.open(for: bystander, in: stores)
        XCTAssertEqual(try other.recipes().count, 1, "another account's store stays")
    }

    func testAHeldHostOpensNoStore() throws {
        let opened = DeletionCounter()
        let held = DeletionFlag()
        let host = SyncHost(
            makeStore: { _ in
                opened.increment()
                return try AccountStore.inMemory()
            },
            makeEngine: { _, store in
                SyncEngine(store: store, client: APIClient(baseURL: URL(filePath: "/"), tokenProvider: FakeTokenProvider(), imageCache: nil), sleep: { _ in })
            },
            labelPhotos: photos,
            isHeld: { held.value }
        )
        host.switchTo(account)
        let engine = try XCTUnwrap(host.engine)

        held.value = true
        host.holdForAccountDeletion()
        XCTAssertTrue(engine.isStopped)
        XCTAssertNil(host.store)
        host.switchTo(account)
        host.kick()
        XCTAssertNil(host.engine)
        XCTAssertEqual(opened.count, 1)

        held.value = false
        host.switchTo(account)
        XCTAssertNotNil(host.engine, "after the deletion record is gone a store opens again")
        XCTAssertEqual(opened.count, 2)
        host.switchTo(nil)
    }

    func testTheSessionSendsNothingWhileADeletionIsRecorded() async throws {
        let records = FakeAccountDeletionStore()
        let session = AuthSession(endpoint: FakeTokenEndpoint(), store: signedIn(account), isSendingHeld: { records.holdsSending })
        let before = await session.maySend(as: account)
        XCTAssertTrue(before)
        try records.save(AccountDeletionRecord(phase: .requested, account: account, localAccounts: []))
        let during = await session.maySend(as: account)
        let stillSignedIn = await session.isSignedIn(as: account)
        XCTAssertFalse(during)
        XCTAssertTrue(stillSignedIn, "still signed in")
        try records.delete()
        records.failLoads(with: .keychain(-25308))
        XCTAssertTrue(records.holdsSending, "a record that cannot be read holds too")
    }

    func testTheRecordAlwaysListsItsAccountAndRoundTrips() throws {
        let record = AccountDeletionRecord(phase: .requested, account: newAccount, localAccounts: [account])
        XCTAssertEqual(record.localAccounts, [account, newAccount])
        let decoded = try JSONDecoder().decode(AccountDeletionRecord.self, from: JSONEncoder().encode(record))
        XCTAssertEqual(decoded, record)
        XCTAssertEqual(KeychainAccountDeletionStore(stage: .dev).service, "app.cupmark.Cupmark.deletion.dev")
        XCTAssertEqual(KeychainAccountDeletionStore(stage: .prod).service, "app.cupmark.Cupmark.deletion.prod")
        XCTAssertNotEqual(KeychainAccountDeletionStore(stage: .dev).service, KeychainCredentialStore(stage: .dev).service, "removing the sign-in never removes the record")
    }

    func testTheKeychainRecordRoundTrip() throws {
        let store = KeychainAccountDeletionStore(service: "app.cupmark.Cupmark.deletion.test-\(UUID().uuidString)")
        defer { try? store.delete() }
        let unavailable: Set<OSStatus> = [errSecMissingEntitlement, errSecNotAvailable, errSecInteractionNotAllowed]
        let record = AccountDeletionRecord(phase: .requested, account: account, localAccounts: [account])
        do {
            // Outside an assertion, so an XCTSkip skips instead of failing the assertion.
            let initial = try store.load()
            XCTAssertNil(initial)
            try store.save(record)
        } catch AuthError.keychain(let status) where unavailable.contains(status) {
            throw XCTSkip("NOT RUN: real Keychain round trip skipped, SecItem returned OSStatus \(status); this test process has no Keychain access (unsigned simulator build). The deletion logic is covered with FakeAccountDeletionStore.")
        }
        XCTAssertEqual(try store.load(), record)
        var done = record
        done.phase = .serverDeleted
        try store.save(done)
        XCTAssertEqual(try store.load(), done)
        try store.delete()
        XCTAssertNil(try store.load())
        XCTAssertNoThrow(try store.delete())
    }
}

// MARK: - Fakes

/// An `AccountDeletionStore` in memory. One instance outlives a simulated restart, as the
/// Keychain item does.
final class FakeAccountDeletionStore: AccountDeletionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: AccountDeletionRecord?
    private var saveError: AuthError?
    private var loadError: AuthError?

    init(_ record: AccountDeletionRecord? = nil) {
        stored = record
    }

    var record: AccountDeletionRecord? {
        lock.withLock { stored }
    }

    func failSaves(with error: AuthError?) {
        lock.withLock { saveError = error }
    }

    func failLoads(with error: AuthError?) {
        lock.withLock { loadError = error }
    }

    func load() throws -> AccountDeletionRecord? {
        try lock.withLock {
            if let error = loadError {
                throw error
            }
            return stored
        }
    }

    func save(_ record: AccountDeletionRecord) throws {
        try lock.withLock {
            if let error = saveError {
                throw error
            }
            stored = record
        }
    }

    func delete() throws {
        lock.withLock { stored = nil }
    }
}

/// The answers of `DELETE /account`, in order; the last one repeats. 0 fails in transport. Any
/// other request answers 503 (and is recorded by the stub, so a test sees it).
final class DeleteScript: @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [Int]

    init(_ statuses: [Int]) {
        self.statuses = statuses
    }

    func setStatuses(_ statuses: [Int]) {
        lock.withLock { self.statuses = statuses }
    }

    func respond(to request: RecordedRequest) throws -> StubResponse {
        guard request.method == "DELETE", request.path == "/account" else {
            return StubResponse(status: 503)
        }
        let status: Int = lock.withLock {
            let next = statuses.first ?? 204
            if statuses.count > 1 {
                statuses.removeFirst()
            }
            return next
        }
        if status == 0 {
            throw URLError(.notConnectedToInternet)
        }
        return StubResponse(status: status)
    }
}

/// The waits a model asked for.
final class DelayRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [TimeInterval] = []

    func append(_ seconds: TimeInterval) {
        lock.withLock { recorded.append(seconds) }
    }

    var values: [TimeInterval] {
        lock.withLock { recorded }
    }

    var count: Int {
        values.count
    }
}

/// A count that closures on any thread can raise.
final class DeletionCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() {
        lock.withLock { value += 1 }
    }

    var count: Int {
        lock.withLock { value }
    }
}

/// A flag that `@Sendable` closures can read.
final class DeletionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var current = false

    var value: Bool {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
}
