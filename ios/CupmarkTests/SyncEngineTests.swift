import SwiftData
import XCTest
@testable import Cupmark

/// The outbox and `SyncEngine` (M2-T16, ADR 0025) against `FakeSyncServer`, with in-memory
/// stores (one on disk for the restart), a test clock and a fixed jitter: every status rule,
/// the order, the rewrite of references from bean to shelf entry to brew, the adoption after
/// an ambiguous create, sign-in required, stopping, and an outbox that survives a restart.
@MainActor
final class SyncEngineTests: XCTestCase {
    private struct Harness {
        let store: AccountStore
        let server: FakeSyncServer
        let engine: SyncEngine
        let clock: TestClock
        let tokens: FakeTokenProvider
    }

    private var folders: [URL] = []

    override func tearDownWithError() throws {
        for folder in folders {
            try? FileManager.default.removeItem(at: folder)
        }
        folders = []
        try super.tearDownWithError()
    }

    private func makeHarness(
        store: AccountStore? = nil,
        server: FakeSyncServer? = nil,
        tokens: FakeTokenProvider = FakeTokenProvider(),
        jitter: Double = 1,
        isCurrentAccount: @escaping @Sendable () async -> Bool = { true }
    ) throws -> Harness {
        let store = try store ?? AccountStore.inMemory()
        let server = try server ?? FakeSyncServer()
        let clock = TestClock()
        let engine = SyncEngine(
            store: store,
            client: server.client(tokens: tokens),
            now: { clock.now },
            jitter: { jitter },
            sleep: { _ in },
            isCurrentAccount: isCurrentAccount
        )
        return Harness(store: store, server: server, engine: engine, clock: clock, tokens: tokens)
    }

    // MARK: - Fixtures

    private func id(_ n: Int) -> String {
        FakeSyncBackend.id(n)
    }

    private func newBean(barcode: String? = "4006381333931") throws -> StoredBean {
        StoredBean(API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: barcode,
            attributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self))
        ))
    }

    private func serverBean(_ beanID: String) -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(),
            operatorAttributes: API.BeanAttributes()
        )
    }

    private func shelfValues(beanID: String) throws -> API.ShelfEntryInput {
        var values = try StoreFixtures.shelfEntryInput()
        values.beanId = beanID
        return values
    }

    private func brewValues(shelfEntryID: String, brewedAt: String = "2026-11-25T08:30:00.123Z") throws -> API.BrewInput {
        var values = try StoreFixtures.brewInput(brewedAt: brewedAt)
        values.shelfEntryId = shelfEntryID
        return values
    }

    private func recipeValues(dose: Int = 180) throws -> API.RecipeInput {
        var parameters = try StoreFixtures.parameters()
        parameters.doseDg = dose
        return API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters)
    }

    /// A bean and a shelf entry on the server, and the same, synced, on the device.
    private func syncedShelfEntry(_ harness: Harness, beanID: Int = 901, entryID: Int = 902) throws -> StoredShelfEntry {
        let bean = serverBean(id(beanID))
        let values = try shelfValues(beanID: id(beanID))
        harness.server.backend.seed(bean: bean)
        harness.server.backend.seed(shelfEntry: id(entryID), values)
        let local = StoredBean(bean)
        try harness.store.addBean(local, syncState: .synced)
        let entry = StoredShelfEntry(values, serverID: id(entryID))
        try harness.store.addShelfEntry(entry, bean: local, syncState: .synced)
        return entry
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    private func body<T: Decodable>(_ type: T.Type, of request: RecordedRequest?) throws -> T {
        try JSONDecoder().decode(type, from: XCTUnwrap(request?.body))
    }

    /// Counts calls across threads.
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0

        /// The count before this call.
        func next() -> Int {
            lock.withLock {
                defer { value += 1 }
                return value
            }
        }
    }

    // MARK: - Queueing

    func testEveryLocalWriteQueuesItsOperationInTheSameSave() throws {
        let store = try AccountStore.inMemory()
        let bean = try newBean()
        try store.addBean(bean)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try store.addShelfEntry(entry, bean: bean)
        try store.addBrew(try StoredBrew(try StoreFixtures.brewInput()), shelfEntry: entry)
        try store.addRecipe(StoredRecipe(try recipeValues()))
        try store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: false)))
        // Items read from the server queue nothing.
        try store.addRecipe(StoredRecipe(try recipeValues(), serverID: id(1)), syncState: .synced)

        XCTAssertEqual(try queue(store), ["create bean", "create shelf_entry", "create brew", "create recipe", "update profile"])
        XCTAssertEqual(try store.outboxOperations().map(\.sequence), [1, 2, 3, 4, 5])
        // Saved with the items: a second context on the same container reads them.
        let other = ModelContext(store.container)
        XCTAssertEqual(try other.fetch(FetchDescriptor<OutboxOperation>()).count, 5)
        XCTAssertEqual(try other.fetch(FetchDescriptor<StoredRecipe>()).count, 2)
    }

    func testEditsThatAreNotSentYetShareOneUpdate() throws {
        let store = try AccountStore.inMemory()
        let recipe = StoredRecipe(try recipeValues(), serverID: id(1))
        try store.addRecipe(recipe, syncState: .synced)
        recipe.doseDg = 190
        try store.markUpdated(recipe)
        recipe.doseDg = 200
        try store.markUpdated(recipe)
        XCTAssertEqual(try queue(store), ["update recipe"])

        // A create that is not sent yet carries the edit itself.
        let fresh = StoredRecipe(try recipeValues())
        try store.addRecipe(fresh)
        fresh.doseDg = 210
        try store.markUpdated(fresh)
        XCTAssertEqual(try queue(store), ["update recipe", "create recipe"])
    }

    func testDeletingACreateThatWasNeverSentRemovesItAndItsOperation() throws {
        let store = try AccountStore.inMemory()
        let recipe = StoredRecipe(try recipeValues())
        try store.addRecipe(recipe)
        try store.markDeleted(recipe)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertTrue(try store.context.fetch(FetchDescriptor<StoredRecipe>()).isEmpty)
    }

    func testDeletingACreateThatMayBeOnTheServerQueuesADeleteAfterIt() async throws {
        let harness = try makeHarness()
        let recipe = StoredRecipe(try recipeValues())
        try harness.store.addRecipe(recipe)
        // As if the app had sent the create and been ended before the answer.
        let pending = try XCTUnwrap(try harness.store.nextOutboxOperation())
        pending.sentWithoutAnswer = true
        try harness.store.save()

        try harness.store.markDeleted(recipe)
        XCTAssertEqual(recipe.syncState, .pendingDelete)
        XCTAssertEqual(try queue(harness.store), ["create recipe", "delete recipe"])

        let result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["GET /recipes", "POST /recipes", "DELETE /recipes/\(id(1))"])
        XCTAssertTrue(harness.server.backend.storedRecipes.isEmpty)
        XCTAssertTrue(try harness.store.context.fetch(FetchDescriptor<StoredRecipe>()).isEmpty)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    // MARK: - Order and references

    func testOperationsGoOutInOrderAndReferencesGetTheServerIDs() async throws {
        let harness = try makeHarness()
        let bean = try newBean()
        try harness.store.addBean(bean)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try harness.store.addShelfEntry(entry, bean: bean)
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try harness.store.addBrew(brew, shelfEntry: entry)
        let recipe = StoredRecipe(try recipeValues())
        try harness.store.addRecipe(recipe)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /beans", "POST /shelf", "POST /brews", "POST /recipes"])
        let beanID = try XCTUnwrap(bean.serverID)
        let entryID = try XCTUnwrap(entry.serverID)
        XCTAssertEqual(beanID, id(1))
        XCTAssertEqual(entryID, id(2))
        XCTAssertEqual(brew.serverID, id(3))
        XCTAssertEqual(recipe.serverID, id(4))
        // The shelf entry named the bean by its local relationship; the request carried the
        // server id the bean had by then. The same for the brew and its shelf entry.
        XCTAssertEqual(try body(API.ShelfEntryInput.self, of: harness.server.requests[1]).beanId, beanID)
        XCTAssertEqual(try body(API.BrewInput.self, of: harness.server.requests[2]).shelfEntryId, entryID)
        XCTAssertEqual([bean.syncState, entry.syncState, brew.syncState, recipe.syncState], [.synced, .synced, .synced, .synced])
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testAnOperationWhoseReferenceNeverGotAServerIDIsParked() async throws {
        let harness = try makeHarness()
        harness.server.backend.setOverride { request in
            request.path == "/beans" ? StubResponse(status: 400) : nil
        }
        let bean = try newBean()
        try harness.store.addBean(bean)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try harness.store.addShelfEntry(entry, bean: bean)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /beans"])
        let operations = try harness.store.outboxOperations()
        XCTAssertEqual(operations.map(\.parked), [true, true])
        XCTAssertEqual(operations.map(\.parkReason), [.rejected, .missingReference])
        XCTAssertEqual(bean.syncIssue, .rejected)
        XCTAssertEqual(entry.syncIssue, .rejected)
    }

    // MARK: - Status rules

    func testA2xxStoresTheServerIDAndValues() async throws {
        let harness = try makeHarness()
        let bean = try newBean()
        try harness.store.addBean(bean)
        try harness.store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: true)))

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /beans", "PUT /profile"])
        XCTAssertEqual(bean.serverID, id(1))
        // Values only the server has: `verified` and the operator attributes.
        XCTAssertFalse(bean.verified)
        XCTAssertEqual(bean.syncState, .synced)
        XCTAssertEqual(try harness.store.profile()?.syncState, .synced)
    }

    func testRetryableAnswersBackOffWithJitterAndHoldTheQueue() async throws {
        let harness = try makeHarness(jitter: 1)
        let posts = Counter()
        harness.server.backend.setOverride { request in
            guard request.method == "POST" else {
                return nil
            }
            switch posts.next() {
            case 0: return StubResponse(status: 429)
            case 1: return StubResponse(status: 429)
            case 2: throw URLError(.networkConnectionLost)
            default: return nil
            }
        }
        let first = StoredRecipe(try recipeValues(dose: 150))
        try harness.store.addRecipe(first)
        let second = StoredRecipe(try recipeValues(dose: 160))
        try harness.store.addRecipe(second)
        let start = harness.clock.now

        // 429: 2 s (attempt 1, full jitter), then 4 s.
        var result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(2)))
        result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(2)))
        XCTAssertEqual(harness.server.log, ["POST /recipes"], "nothing is sent before the backoff ends")

        harness.clock.advance(2)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(6)))

        // A transport failure: 8 s, and the create is checked before it is sent again.
        harness.clock.advance(4)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(14)))
        XCTAssertEqual(try harness.store.nextOutboxOperation()?.sentWithoutAnswer, true)

        harness.clock.advance(8)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /recipes", "POST /recipes", "POST /recipes", "GET /recipes", "POST /recipes", "POST /recipes"])
        XCTAssertEqual(try body(API.RecipeInput.self, of: harness.server.requests[4]).parameters.doseDg, 150)
        XCTAssertEqual(try body(API.RecipeInput.self, of: harness.server.requests[5]).parameters.doseDg, 160)
        XCTAssertEqual([first.syncState, second.syncState], [.synced, .synced])
    }

    func testServerErrorsAreRetried() async throws {
        for status in [500, 502, 503] {
            let harness = try makeHarness()
            let sent = Counter()
            harness.server.backend.setOverride { request in
                request.method == "PUT" && sent.next() == 0 ? StubResponse(status: status) : nil
            }
            let recipe = StoredRecipe(try recipeValues(), serverID: id(700))
            harness.server.backend.seed(recipe: id(700), try recipeValues())
            try harness.store.addRecipe(recipe, syncState: .synced)
            recipe.doseDg = 200
            try harness.store.markUpdated(recipe)

            let result = await harness.engine.drain()
            XCTAssertEqual(result, .waiting(until: harness.clock.now.addingTimeInterval(2)), "\(status)")
            harness.clock.advance(2)
            let retried = await harness.engine.drain()
            XCTAssertEqual(retried, .idle, "\(status)")
            XCTAssertEqual(harness.server.backend.storedRecipes[id(700)]?.parameters.doseDg, 200, "\(status)")
            XCTAssertEqual(recipe.syncState, .synced, "\(status)")
        }
    }

    func testA401IsRefreshedOnceAndSentAgain() async throws {
        let harness = try makeHarness()
        harness.server.backend.setOverride { request in
            request.header("Authorization") == "Bearer access-token-1" ? StubResponse(status: 401) : nil
        }
        let recipe = StoredRecipe(try recipeValues())
        try harness.store.addRecipe(recipe)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        let refreshes = await harness.tokens.refreshCount
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(harness.server.log, ["POST /recipes", "POST /recipes"])
        XCTAssertEqual(recipe.syncState, .synced)
    }

    func testA401AfterAFailedRefreshAsksForSignInAndKeepsTheOperations() async throws {
        let harness = try makeHarness(tokens: FakeTokenProvider(refreshFails: true))
        // Also what a write with the token of a deleted account gets (ADR 0017, Addendum).
        harness.server.backend.setOverride { _ in StubResponse(status: 401) }
        var asked = 0
        harness.engine.onSignInRequired = { asked += 1 }
        try harness.store.addRecipe(StoredRecipe(try recipeValues()))
        try harness.store.addRecipe(StoredRecipe(try recipeValues(dose: 200)))

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .signInRequired)
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(harness.server.log, ["POST /recipes"])
        let operations = try harness.store.outboxOperations()
        XCTAssertEqual(operations.count, 2)
        XCTAssertFalse(operations.contains(where: \.parked))
        // Stopped: nothing more is sent until a new engine starts after sign-in.
        let again = await harness.engine.drain()
        XCTAssertEqual(again, .signInRequired)
        XCTAssertEqual(harness.server.log.count, 1)
    }

    func testA400ParksTheOperationFlagsTheItemAndIsNeverRetried() async throws {
        let harness = try makeHarness()
        let posts = Counter()
        harness.server.backend.setOverride { request in
            request.method == "POST" && posts.next() == 0 ? StubResponse(status: 400) : nil
        }
        let rejected = StoredRecipe(try recipeValues(dose: 150))
        try harness.store.addRecipe(rejected)
        let accepted = StoredRecipe(try recipeValues(dose: 160))
        try harness.store.addRecipe(accepted)

        var result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        harness.clock.advance(86_400)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)

        XCTAssertEqual(harness.server.log, ["POST /recipes", "POST /recipes"])
        let operations = try harness.store.outboxOperations()
        XCTAssertEqual(operations.count, 1)
        XCTAssertEqual(operations.first?.parked, true)
        XCTAssertEqual(operations.first?.parkReason, .rejected)
        XCTAssertEqual(operations.first?.localID, rejected.localID)
        XCTAssertEqual(rejected.syncIssue, .rejected)
        XCTAssertEqual(rejected.syncState, .pendingCreate)
        XCTAssertEqual(accepted.syncState, .synced)
        // A parked item takes no more operations: an edit is not queued.
        rejected.doseDg = 170
        try harness.store.markUpdated(rejected)
        XCTAssertEqual(try harness.store.outboxOperations().count, 1)
    }

    func testA404OnADeleteCountsAsDone() async throws {
        let harness = try makeHarness()
        // On the device, no longer on the server.
        let recipe = StoredRecipe(try recipeValues(), serverID: id(700))
        try harness.store.addRecipe(recipe, syncState: .synced)
        try harness.store.markDeleted(recipe)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["DELETE /recipes/\(id(700))"])
        XCTAssertTrue(try harness.store.context.fetch(FetchDescriptor<StoredRecipe>()).isEmpty)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testA404OnAPutRemovesTheLocalItem() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        // A brew deleted on another device, edited here.
        let brew = try StoredBrew(try brewValues(shelfEntryID: id(902)), serverID: id(703))
        try harness.store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        brew.waterG = 320
        try harness.store.markUpdated(brew)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["PUT /brews/\(id(703))", "GET /brews/\(id(703))"])
        XCTAssertTrue(try harness.store.context.fetch(FetchDescriptor<StoredBrew>()).isEmpty)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testA404OnAPutForAnItemTheServerStillHasParksAndKeepsIt() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let values = try brewValues(shelfEntryID: id(902))
        harness.server.backend.seed(brew: id(703), values)
        // The server refuses a reference in the body (a gone shelf entry or bean) with 404.
        harness.server.backend.setOverride { request in
            request.method == "PUT" ? StubResponse(status: 404) : nil
        }
        let brew = try StoredBrew(values, serverID: id(703))
        try harness.store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        brew.waterG = 320
        try harness.store.markUpdated(brew)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["PUT /brews/\(id(703))", "GET /brews/\(id(703))"])
        XCTAssertEqual(try harness.store.brewsNewestFirst().map(\.localID), [brew.localID])
        XCTAssertEqual(brew.waterG, 320)
        XCTAssertEqual(brew.syncIssue, .rejected)
        let operations = try harness.store.outboxOperations()
        XCTAssertEqual(operations.map(\.parked), [true])
        XCTAssertEqual(operations.first?.parkReason, .rejected)
    }

    func testA404OnAPutWhoseReadFailsIsRetriedWithBackoff() async throws {
        let harness = try makeHarness()
        harness.server.backend.seed(recipe: id(700), try recipeValues())
        let reads = Counter()
        harness.server.backend.setOverride { request in
            if request.method == "PUT" {
                return StubResponse(status: 404)
            }
            if request.method == "GET", reads.next() == 0 {
                throw URLError(.networkConnectionLost)
            }
            return nil
        }
        let recipe = StoredRecipe(try recipeValues(), serverID: id(700))
        try harness.store.addRecipe(recipe, syncState: .synced)
        recipe.doseDg = 200
        try harness.store.markUpdated(recipe)

        let first = await harness.engine.drain()
        XCTAssertEqual(first, .waiting(until: harness.clock.now.addingTimeInterval(2)))
        XCTAssertEqual(try harness.store.recipes().count, 1, "a failed read removes nothing")
        harness.clock.advance(2)
        let second = await harness.engine.drain()

        XCTAssertEqual(second, .idle)
        XCTAssertEqual(harness.server.log, ["PUT /recipes/\(id(700))", "GET /recipes/\(id(700))", "PUT /recipes/\(id(700))", "GET /recipes/\(id(700))"])
        XCTAssertEqual(try harness.store.recipes().map(\.localID), [recipe.localID])
        XCTAssertEqual(try harness.store.outboxOperations().first?.parkReason, .rejected)
    }

    func testA409OnAShelfDeleteRestoresTheEntry() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        // A brew made on another device that this one has not pulled yet.
        harness.server.backend.seed(brew: id(950), try brewValues(shelfEntryID: id(902)))
        try harness.store.markDeleted(entry)
        XCTAssertTrue(try harness.store.shelfEntries().isEmpty)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["DELETE /shelf/\(id(902))"])
        XCTAssertEqual(try harness.store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(entry.syncIssue, .deleteRestored)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testA409OnAShelfPutRevertsTheBeanAndSendsTheOtherValues() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let oldBean = try XCTUnwrap(entry.bean)
        harness.server.backend.seed(brew: id(950), try brewValues(shelfEntryID: id(902)))
        let otherBean = StoredBean(serverBean(id(903)))
        harness.server.backend.seed(bean: serverBean(id(903)))
        try harness.store.addBean(otherBean, syncState: .synced)
        let newSize = try StoreFixtures.last(Vocabulary.BagSize.self)

        entry.bean = otherBean
        entry.bagSize = newSize
        try harness.store.markUpdated(entry)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["PUT /shelf/\(id(902))", "GET /shelf/\(id(902))", "PUT /shelf/\(id(902))"])
        XCTAssertEqual(entry.bean?.localID, oldBean.localID)
        XCTAssertEqual(entry.bagSize, newSize)
        XCTAssertEqual(entry.syncIssue, .beanChangeReverted)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(harness.server.backend.shelfEntries[id(902)]?.beanId, id(901))
        XCTAssertEqual(harness.server.backend.shelfEntries[id(902)]?.bagSize, newSize)
    }

    func testA409OnABeanCreateAdoptsTheCatalogueBeanForTheBarcode() async throws {
        let harness = try makeHarness()
        var existing = serverBean(id(904))
        existing.barcode = "4006381333931"
        harness.server.backend.seed(bean: existing)
        harness.server.backend.setOverride { request in
            request.method == "POST" && request.path == "/beans" ? StubResponse(status: 409) : nil
        }
        let bean = try newBean(barcode: "4006381333931")
        try harness.store.addBean(bean)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /beans", "GET /barcodes/4006381333931"])
        XCTAssertEqual(bean.serverID, id(904))
        XCTAssertEqual(bean.syncState, .synced)
    }

    // MARK: - Ambiguous creates

    func testABrewCreateWithoutAnAnswerIsAdoptedInsteadOfSentTwice() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let backend = harness.server.backend
        let posts = Counter()
        backend.setOverride { request in
            guard request.method == "POST", posts.next() == 0 else {
                return nil
            }
            // The server stores the brew, then the answer is lost.
            _ = try backend.respond(request)
            throw URLError(.networkConnectionLost)
        }
        let brew = try StoredBrew(try brewValues(shelfEntryID: id(902)))
        try harness.store.addBrew(brew, shelfEntry: entry)
        // Another brew on the same entry at another time must not be taken for it.
        backend.seed(brew: id(960), try brewValues(shelfEntryID: id(902), brewedAt: "2026-11-24T07:00:00.000Z"))

        let first = await harness.engine.drain()
        XCTAssertEqual(first, .waiting(until: harness.clock.now.addingTimeInterval(2)))
        harness.clock.advance(2)
        let second = await harness.engine.drain()

        XCTAssertEqual(second, .idle)
        XCTAssertEqual(harness.server.log, ["POST /brews", "GET /brews"])
        XCTAssertEqual(backend.storedBrews.count, 2)
        XCTAssertEqual(brew.serverID, id(1))
        XCTAssertEqual(brew.syncState, .synced)
    }

    func testAFailingCheckBacksOffLikeASend() async throws {
        let harness = try makeHarness(jitter: 1)
        let posts = Counter()
        let lists = Counter()
        harness.server.backend.setOverride { request in
            if request.method == "POST", posts.next() == 0 {
                throw URLError(.timedOut)
            }
            if request.method == "GET", lists.next() < 2 {
                return StubResponse(status: 503)
            }
            return nil
        }
        try harness.store.addRecipe(StoredRecipe(try recipeValues()))
        let start = harness.clock.now

        var result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(2)))
        harness.clock.advance(2)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(6)), "the failed check is attempt 2: 4 s")
        harness.clock.advance(4)
        result = await harness.engine.drain()
        XCTAssertEqual(result, .waiting(until: start.addingTimeInterval(14)), "attempt 3: 8 s")
        harness.clock.advance(8)
        result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /recipes", "GET /recipes", "GET /recipes", "GET /recipes", "POST /recipes"])
        XCTAssertEqual(harness.server.backend.storedRecipes.count, 1)
    }

    func testAnEditAfterALostAnswerDoesNotMakeADuplicate() async throws {
        let harness = try makeHarness()
        let backend = harness.server.backend
        let posts = Counter()
        backend.setOverride { request in
            guard request.method == "POST", posts.next() == 0 else {
                return nil
            }
            _ = try backend.respond(request)
            throw URLError(.networkConnectionLost)
        }
        let recipe = StoredRecipe(try recipeValues(dose: 150))
        try harness.store.addRecipe(recipe)
        let first = await harness.engine.drain()
        XCTAssertEqual(first, .waiting(until: harness.clock.now.addingTimeInterval(2)))

        // Edited while the create's answer is unknown: matched against what was sent.
        recipe.doseDg = 160
        try harness.store.markUpdated(recipe)
        XCTAssertEqual(try queue(harness.store), ["create recipe", "update recipe"])
        harness.clock.advance(2)
        let second = await harness.engine.drain()

        XCTAssertEqual(second, .idle)
        XCTAssertEqual(harness.server.log, ["POST /recipes", "GET /recipes", "PUT /recipes/\(id(1))"])
        XCTAssertEqual(backend.storedRecipes.count, 1)
        XCTAssertEqual(backend.storedRecipes[id(1)]?.parameters.doseDg, 160)
        XCTAssertEqual(recipe.serverID, id(1))
        XCTAssertEqual(recipe.doseDg, 160)
        XCTAssertEqual(recipe.syncState, .synced)
    }

    func testAConnectionThatWasNeverMadeNeedsNoCheck() async throws {
        let harness = try makeHarness()
        let posts = Counter()
        harness.server.backend.setOverride { request in
            if request.method == "POST", posts.next() == 0 {
                throw URLError(.notConnectedToInternet)
            }
            return nil
        }
        try harness.store.addRecipe(StoredRecipe(try recipeValues()))

        _ = await harness.engine.drain()
        XCTAssertEqual(try harness.store.nextOutboxOperation()?.sentWithoutAnswer, false)
        harness.clock.advance(2)
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["POST /recipes", "POST /recipes"])
    }

    func testAServerItemWithALocalCounterpartIsNotAdopted() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let values = try brewValues(shelfEntryID: id(902))
        harness.server.backend.seed(brew: id(960), values)
        try harness.store.addBrew(try StoredBrew(values, serverID: id(960)), shelfEntry: entry, syncState: .synced)
        // A second brew at the same moment, whose create was sent before the app was ended.
        let twin = try StoredBrew(values)
        try harness.store.addBrew(twin, shelfEntry: entry)
        let pending = try XCTUnwrap(try harness.store.nextOutboxOperation())
        pending.sentWithoutAnswer = true
        try harness.store.save()

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["GET /brews", "POST /brews"])
        XCTAssertEqual(twin.serverID, id(1))
        XCTAssertEqual(harness.server.backend.storedBrews.count, 2)
    }

    func testAmbiguousShelfEntryAndRecipeCreatesAreAdopted() async throws {
        let harness = try makeHarness()
        let bean = StoredBean(serverBean(id(901)))
        harness.server.backend.seed(bean: serverBean(id(901)))
        try harness.store.addBean(bean, syncState: .synced)
        let entry = StoredShelfEntry(try shelfValues(beanID: id(901)))
        try harness.store.addShelfEntry(entry, bean: bean)
        let recipe = StoredRecipe(try recipeValues(dose: 175))
        try harness.store.addRecipe(recipe)
        // The lost requests had created both: same bean and values, same parameters.
        harness.server.backend.seed(shelfEntry: id(980), try shelfValues(beanID: id(901)))
        harness.server.backend.seed(recipe: id(981), try recipeValues(dose: 175))
        // And an unrelated recipe that must not be taken.
        harness.server.backend.seed(recipe: id(979), try recipeValues(dose: 120))
        for operation in try harness.store.outboxOperations() {
            operation.sentWithoutAnswer = true
        }
        try harness.store.save()

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["GET /shelf", "GET /recipes"])
        XCTAssertEqual(entry.serverID, id(980))
        XCTAssertEqual(recipe.serverID, id(981))
        XCTAssertEqual([entry.syncState, recipe.syncState], [.synced, .synced])
    }

    // MARK: - Restart, stop and account

    func testTheOutboxSurvivesARestart() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "SyncEngineTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        folders.append(folder)
        let account = StoreAccountID(stableID: "restart-account")

        do {
            let store = try AccountStore.open(for: account, in: folder)
            try store.addRecipe(StoredRecipe(try recipeValues(dose: 150)))
            try store.addRecipe(StoredRecipe(try recipeValues(dose: 160)))
            // Ended while the first create was on its way.
            let first = try XCTUnwrap(try store.nextOutboxOperation())
            first.attemptCount = 1
            first.sentWithoutAnswer = true
            try store.save()
        }

        let reopened = try AccountStore.open(for: account, in: folder)
        let operations = try reopened.outboxOperations()
        XCTAssertEqual(operations.map(\.sequence), [1, 2])
        XCTAssertEqual(operations.map(\.sentWithoutAnswer), [true, false])
        XCTAssertEqual(operations.first?.attemptCount, 1)

        let harness = try makeHarness(store: reopened)
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.log, ["GET /recipes", "POST /recipes", "POST /recipes"])
        XCTAssertTrue(try reopened.outboxOperations().isEmpty)
        XCTAssertEqual(try reopened.recipes().map(\.syncState), [.synced, .synced])
    }

    func testAStoppedEngineSendsNothing() async throws {
        let harness = try makeHarness()
        try harness.store.addRecipe(StoredRecipe(try recipeValues()))
        harness.engine.stop()

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .stopped)
        XCTAssertTrue(harness.server.log.isEmpty)
        XCTAssertEqual(try harness.store.outboxOperations().count, 1)
    }

    func testAnEngineWhoseAccountIsNoLongerSignedInStopsBeforeSending() async throws {
        let harness = try makeHarness(isCurrentAccount: { false })
        try harness.store.addRecipe(StoredRecipe(try recipeValues()))

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .stopped)
        XCTAssertTrue(harness.engine.isStopped)
        XCTAssertTrue(harness.server.log.isEmpty)
        let operation = try XCTUnwrap(try harness.store.nextOutboxOperation())
        XCTAssertEqual(operation.attemptCount, 0)
        XCTAssertFalse(operation.sentWithoutAnswer)
    }

    func testTheSessionSaysWhichAccountIsSignedIn() async throws {
        let account = AccountID(subject: AuthFixtures.subject)
        let other = AccountID(subject: AuthFixtures.otherSubject)
        let session = AuthSession(
            endpoint: FakeTokenEndpoint(),
            store: FakeCredentialStore(StoredCredential(refreshToken: "refresh-1", accountID: account))
        )
        let signedIn = await session.isSignedIn(as: account)
        let otherSignedIn = await session.isSignedIn(as: other)
        XCTAssertTrue(signedIn)
        XCTAssertFalse(otherSignedIn)
        await session.signOut()
        let afterSignOut = await session.isSignedIn(as: account)
        XCTAssertFalse(afterSignOut)
    }

    func testTheHostIgnoresSignInRequiredFromAnEngineItReplaced() throws {
        let server = try FakeSyncServer()
        let host = SyncHost(
            makeStore: { _ in try AccountStore.inMemory() },
            makeEngine: { _, store in SyncEngine(store: store, client: server.client(), sleep: { _ in }) }
        )
        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let old = try XCTUnwrap(host.engine)
        host.switchTo(AccountID(subject: AuthFixtures.otherSubject))
        let current = try XCTUnwrap(host.engine)

        old.onSignInRequired?()
        XCTAssertFalse(host.signInRequired)
        current.onSignInRequired?()
        XCTAssertTrue(host.signInRequired)
    }

    func testTheHostStopsTheEngineWhenTheAccountChanges() throws {
        let server = try FakeSyncServer()
        let host = SyncHost(
            makeStore: { _ in try AccountStore.inMemory() },
            makeEngine: { _, store in SyncEngine(store: store, client: server.client(), sleep: { _ in }) }
        )
        let account = AccountID(subject: AuthFixtures.subject)
        host.switchTo(account)
        let engine = try XCTUnwrap(host.engine)
        XCTAssertFalse(engine.isStopped)

        host.switchTo(nil)
        XCTAssertTrue(engine.isStopped)
        XCTAssertNil(host.engine)
        XCTAssertNil(host.store)
    }

    // MARK: - Backoff

    func testTheBackoffDoublesUpToItsMaximumAndJitterHalvesAtMost() {
        let backoff = SyncBackoff(base: 2, maximum: 300)
        XCTAssertEqual(backoff.delay(afterAttempt: 1, jitter: 1), 2)
        XCTAssertEqual(backoff.delay(afterAttempt: 2, jitter: 1), 4)
        XCTAssertEqual(backoff.delay(afterAttempt: 3, jitter: 1), 8)
        XCTAssertEqual(backoff.delay(afterAttempt: 1, jitter: 0), 1)
        XCTAssertEqual(backoff.delay(afterAttempt: 3, jitter: 0.5), 6)
        XCTAssertEqual(backoff.delay(afterAttempt: 20, jitter: 1), 300)
        XCTAssertEqual(backoff.delay(afterAttempt: 10_000, jitter: 0), 150)
        XCTAssertEqual(backoff.delay(afterAttempt: 1, jitter: 7), 2)
        XCTAssertEqual(backoff.delay(afterAttempt: 1, jitter: -1), 1)
    }

    func testOnlyAnswersThatSayNothingWasWrittenSkipTheCheck() {
        XCTAssertTrue(SyncEngine.mayHaveActed(.transport(.timedOut)))
        XCTAssertTrue(SyncEngine.mayHaveActed(.transport(.networkConnectionLost)))
        for code in [URLError.Code.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed] {
            XCTAssertFalse(SyncEngine.mayHaveActed(.transport(code)), "\(code)")
        }
        XCTAssertTrue(SyncEngine.mayHaveActed(.server(status: 500)))
        XCTAssertTrue(SyncEngine.mayHaveActed(.serviceUnavailable))
        XCTAssertFalse(SyncEngine.mayHaveActed(.tooManyRequests))
        XCTAssertFalse(SyncEngine.mayHaveActed(.badRequest))
        XCTAssertFalse(SyncEngine.mayHaveActed(.unauthorized))
        XCTAssertFalse(SyncEngine.mayHaveActed(.conflict))
        XCTAssertFalse(SyncEngine.mayHaveActed(.notFound))
    }
}
