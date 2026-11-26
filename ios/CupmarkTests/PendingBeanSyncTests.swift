import SwiftData
import XCTest
@testable import Cupmark

/// Offline scan and pending beans (M2-T25): a barcode scanned offline is kept as a pending
/// bean, put on the shelf and brewed with at once; back online the outbox looks it up and, in
/// every case (known bean, Open Food Facts hit confirmed or rejected, miss), the brew ends up on
/// the server under the right shelf entry, which names the right bean. Against the real
/// `LookupModel`, `ShelfEntryEditorModel`, `PendingBeansModel`, `SyncEngine` and
/// `FakeSyncServer`, which is held for the whole test.
@MainActor
final class PendingBeanSyncTests: XCTestCase {
    private static let barcode = "4006381333931"

    private struct Harness {
        let store: AccountStore
        let server: FakeSyncServer
        let engine: SyncEngine
        let clock: TestClock
    }

    /// The pending bean, its shelf entry and its brew, all made offline.
    private struct Offline {
        let bean: StoredBean
        let entry: StoredShelfEntry
        let brew: StoredBrew
    }

    private func makeHarness() throws -> Harness {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let clock = TestClock()
        let engine = SyncEngine(
            store: store,
            client: server.client(),
            now: { clock.now },
            jitter: { 1 },
            sleep: { _ in }
        )
        return Harness(store: store, server: server, engine: engine, clock: clock)
    }

    private func id(_ n: Int) -> String {
        FakeSyncBackend.id(n)
    }

    /// Every request fails before it reaches the server, as without a network.
    private func goOffline(_ harness: Harness) {
        harness.server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
    }

    /// The network is back, and the look-up's wait has passed.
    private func comeOnline(_ harness: Harness) {
        harness.server.backend.setOverride(nil)
        harness.clock.advance(SyncBackoff().maximum + 1)
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    private func body<T: Decodable>(_ type: T.Type, of request: RecordedRequest?) throws -> T {
        try JSONDecoder().decode(type, from: XCTUnwrap(request?.body))
    }

    private func catalogueBean(_ beanID: String, barcode: String?) -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: barcode,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(),
            operatorAttributes: API.BeanAttributes()
        )
    }

    private var product: API.OpenFoodFactsProduct {
        API.OpenFoodFactsProduct(name: "Test Roast Espresso", brand: "Test Roastery", imageId: id(990))
    }

    /// The offline part of every case: the scan's lookup fails, the barcode is kept, the bag
    /// goes on the shelf and a brew is logged. A drain then sends nothing: the look-up waits
    /// for the network, and the shelf entry and brew wait for their bean.
    private func scanShelveAndBrewOffline(_ harness: Harness) async throws -> Offline {
        goOffline(harness)
        let barcode = try XCTUnwrap(CanonicalBarcode(PendingBeanSyncTests.barcode))
        let lookup = LookupModel(barcode: barcode, client: harness.server.client())
        await lookup.lookUp()
        XCTAssertEqual(lookup.state, .pickList(.unavailable))
        XCTAssertTrue(lookup.canKeepForLater)

        let beanID = try XCTUnwrap(lookup.keepForLater(in: harness.store))
        XCTAssertEqual(lookup.state, .pending(beanID))

        let editor = ShelfEntryEditorModel(mode: .addStored(beanID), store: harness.store)
        XCTAssertTrue(editor.canSave)
        let entryID = try XCTUnwrap(editor.save())
        let entry = try XCTUnwrap(harness.store.shelfEntry(localID: entryID))
        XCTAssertEqual(entry.bean?.localID, beanID)

        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try harness.store.addBrew(brew, shelfEntry: entry)
        XCTAssertEqual(try queue(harness.store), ["look_up bean", "create shelf_entry", "create brew"])

        // On the shelf at once, with the look-up still to come.
        let shelf = ShelfModel(store: harness.store)
        shelf.reload()
        XCTAssertEqual(shelf.rows.map(\.id), [entryID])
        XCTAssertEqual(shelf.rows.first?.pendingBean, .lookingUp)
        XCTAssertEqual(shelf.rows.first?.brewCount, 1)

        let before = harness.server.requests.count
        let result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["GET /barcodes/\(PendingBeanSyncTests.barcode)"])
        XCTAssertTrue(harness.server.backend.storedBeans.isEmpty)
        XCTAssertTrue(harness.server.backend.shelfEntries.isEmpty)
        XCTAssertTrue(harness.server.backend.storedBrews.isEmpty)
        XCTAssertEqual(try queue(harness.store), ["look_up bean", "create shelf_entry", "create brew"])
        let lookUp = try XCTUnwrap(harness.store.outboxOperations().first)
        XCTAssertGreaterThan(lookUp.nextAttemptAt, harness.clock.now)
        XCTAssertFalse(lookUp.parked)

        let bean = try XCTUnwrap(harness.store.bean(localID: beanID))
        XCTAssertNil(bean.serverID)
        return Offline(bean: bean, entry: entry, brew: brew)
    }

    /// The brew is on the server, under the entry, which names `beanID`; nothing is queued.
    private func assertBrewOnServer(_ harness: Harness, _ offline: Offline, beanID: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let entryID = try XCTUnwrap(offline.entry.serverID, file: file, line: line)
        let brewID = try XCTUnwrap(offline.brew.serverID, file: file, line: line)
        XCTAssertEqual(offline.bean.serverID, beanID, file: file, line: line)
        XCTAssertEqual(harness.server.backend.shelfEntries[entryID]?.beanId, beanID, file: file, line: line)
        XCTAssertEqual(harness.server.backend.storedBrews[brewID]?.shelfEntryId, entryID, file: file, line: line)
        XCTAssertEqual(harness.server.backend.storedBrews.count, 1, file: file, line: line)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty, file: file, line: line)
        XCTAssertEqual(
            [offline.bean.syncState, offline.entry.syncState, offline.brew.syncState],
            [.synced, .synced, .synced],
            file: file,
            line: line
        )
    }

    // MARK: - Each lookup result

    func testAKnownBarcodeUsesTheCatalogueBeanWithoutAsking() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        harness.server.backend.seed(bean: catalogueBean(id(901), barcode: PendingBeanSyncTests.barcode))
        comeOnline(harness)

        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), [
            "GET /barcodes/\(PendingBeanSyncTests.barcode)", "POST /shelf", "POST /brews",
        ])
        try assertBrewOnServer(harness, offline, beanID: id(901))
        XCTAssertTrue(offline.bean.verified)
        XCTAssertTrue(try harness.store.beansAwaitingConfirmation().isEmpty)
    }

    func testAConfirmedOpenFoodFactsHitIsCreatedAndTheWaitingEntryAndBrewFollow() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        harness.server.backend.seed(openFoodFacts: product, barcode: PendingBeanSyncTests.barcode)
        comeOnline(harness)

        var before = harness.server.requests.count
        var result = await harness.engine.drain()

        // The hit waits for the user; the entry and brew wait for the bean.
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), [
            "GET /barcodes/\(PendingBeanSyncTests.barcode)", "GET /barcodes/\(PendingBeanSyncTests.barcode)/open_food_facts",
        ])
        XCTAssertEqual(try queue(harness.store), ["await_confirmation bean", "create shelf_entry", "create brew"])
        XCTAssertTrue(harness.server.backend.storedBeans.isEmpty)
        // Not the bean's name before the user said so.
        XCTAssertNil(ShelfBeanSummary(offline.bean).name)
        let shelf = ShelfModel(store: harness.store)
        shelf.reload()
        XCTAssertEqual(shelf.rows.first?.pendingBean, .awaitingConfirmation)
        XCTAssertEqual(shelf.confirmationCount, 1)

        // A drain before the answer still waits.
        before = harness.server.requests.count
        result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.requests.count, before)

        // The next opening asks.
        let prompts = PendingBeansModel(store: harness.store)
        prompts.reload()
        XCTAssertEqual(prompts.current?.id, offline.bean.localID)
        XCTAssertEqual(prompts.current?.product, product)
        let species = try StoreFixtures.first(Vocabulary.Species.self)
        prompts.picks.species = species
        prompts.confirm()
        XCTAssertNil(prompts.current)
        XCTAssertFalse(prompts.failed)

        before = harness.server.requests.count
        result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["POST /beans", "POST /shelf", "POST /brews"])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertEqual(sent.openFoodFactsConfirmed, true)
        XCTAssertEqual(sent.attributes.species, species)
        let beanID = try XCTUnwrap(offline.bean.serverID)
        try assertBrewOnServer(harness, offline, beanID: beanID)
        XCTAssertEqual(harness.server.backend.storedBeans[beanID]?.openFoodFacts, product)
        XCTAssertEqual(ShelfBeanSummary(offline.bean).name, product.name)
    }

    func testARejectedOpenFoodFactsHitIsCreatedFromTheBarcodeAlone() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        harness.server.backend.seed(openFoodFacts: product, barcode: PendingBeanSyncTests.barcode)
        comeOnline(harness)
        _ = await harness.engine.drain()
        XCTAssertEqual(try queue(harness.store), ["await_confirmation bean", "create shelf_entry", "create brew"])

        let prompts = PendingBeansModel(store: harness.store)
        prompts.reload()
        XCTAssertEqual(prompts.current?.id, offline.bean.localID)
        prompts.reject()
        XCTAssertNil(prompts.current)

        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["POST /beans", "POST /shelf", "POST /brews"])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertNil(sent.openFoodFactsConfirmed)
        let beanID = try XCTUnwrap(offline.bean.serverID)
        try assertBrewOnServer(harness, offline, beanID: beanID)
        XCTAssertNil(harness.server.backend.storedBeans[beanID]?.openFoodFacts)
        XCTAssertNil(offline.bean.openFoodFactsName)
        XCTAssertFalse(offline.bean.hasOpenFoodFactsProduct)
    }

    func testAMissIsCreatedWithoutAsking() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        comeOnline(harness)

        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), [
            "GET /barcodes/\(PendingBeanSyncTests.barcode)",
            "GET /barcodes/\(PendingBeanSyncTests.barcode)/open_food_facts",
            "POST /beans",
            "POST /shelf",
            "POST /brews",
        ])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before + 2])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertNil(sent.openFoodFactsConfirmed)
        try assertBrewOnServer(harness, offline, beanID: try XCTUnwrap(offline.bean.serverID))
        XCTAssertTrue(try harness.store.beansAwaitingConfirmation().isEmpty)
    }

    // MARK: - The rest of the queue

    func testOtherWritesGoOutWhileABeanWaitsForTheUser() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        // A recipe made offline after the scan does not depend on the bean.
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters()))
        try harness.store.addRecipe(recipe)
        harness.server.backend.seed(openFoodFacts: product, barcode: PendingBeanSyncTests.barcode)
        comeOnline(harness)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertNotNil(recipe.serverID)
        XCTAssertEqual(harness.server.backend.storedRecipes.count, 1)
        XCTAssertNil(offline.entry.serverID)
        XCTAssertNil(offline.brew.serverID)
        XCTAssertEqual(try queue(harness.store), ["await_confirmation bean", "create shelf_entry", "create brew"])
    }

    func testTheDailyLookupCapWaitsAnHourWithoutHoldingTheQueue() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters()))
        try harness.store.addRecipe(recipe)
        comeOnline(harness)
        harness.server.backend.setOverride { request in
            request.path.hasSuffix("/open_food_facts") ? StubResponse(status: 429) : nil
        }

        var result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertNotNil(recipe.serverID)
        let lookUp = try XCTUnwrap(harness.store.outboxOperations().first)
        XCTAssertEqual(lookUp.action, .lookUp)
        XCTAssertEqual(lookUp.nextAttemptAt, harness.clock.now.addingTimeInterval(SyncEngine.lookUpLimitWait))
        XCTAssertEqual(try harness.store.nextLookUpAttempt(after: harness.clock.now), lookUp.nextAttemptAt)

        // An hour later the cap has room again: no product, so the bean is created.
        harness.server.backend.setOverride(nil)
        harness.clock.advance(SyncEngine.lookUpLimitWait + 1)
        result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        try assertBrewOnServer(harness, offline, beanID: try XCTUnwrap(offline.bean.serverID))
    }

    func testAScanOfABarcodeTheDeviceKnowsReusesItsBean() throws {
        let store = try AccountStore.inMemory()
        let barcode = try XCTUnwrap(CanonicalBarcode(PendingBeanSyncTests.barcode))
        let first = try store.pendingBean(barcode: barcode)
        let second = try store.pendingBean(barcode: barcode)

        XCTAssertEqual(first.localID, second.localID)
        XCTAssertEqual(try queue(store), ["look_up bean"])
    }

    // MARK: - A bean described offline

    func testAPickListBeanSavedOfflineIsCreatedWithoutAskingAndItsBrewFollows() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        let barcode = try XCTUnwrap(CanonicalBarcode(PendingBeanSyncTests.barcode))
        let entryModel = BeanEntryModel(barcode: barcode, client: harness.server.client(), offlineStore: harness.store)
        let process = try StoreFixtures.first(Vocabulary.Process.self)
        entryModel.picks.process = process

        await entryModel.save()

        guard case .savedOffline(let beanID) = entryModel.state else {
            return XCTFail("expected the bean to be saved on the device, got \(entryModel.state)")
        }
        XCTAssertEqual(try queue(harness.store), ["create bean"])
        let editor = ShelfEntryEditorModel(mode: .addStored(beanID), store: harness.store)
        let entryID = try XCTUnwrap(editor.save())
        let entry = try XCTUnwrap(harness.store.shelfEntry(localID: entryID))
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try harness.store.addBrew(brew, shelfEntry: entry)
        let bean = try XCTUnwrap(harness.store.bean(localID: beanID))

        // The catalogue has the barcode by now: the create's 409 adopts that bean.
        harness.server.backend.seed(bean: catalogueBean(id(902), barcode: PendingBeanSyncTests.barcode))
        comeOnline(harness)
        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), [
            "POST /beans", "GET /barcodes/\(PendingBeanSyncTests.barcode)", "POST /shelf", "POST /brews",
        ])
        XCTAssertEqual(try body(API.BeanCreate.self, of: harness.server.requests[before]).attributes.process, process)
        try assertBrewOnServer(harness, Offline(bean: bean, entry: entry, brew: brew), beanID: id(902))
    }

    func testAPickListBeanWithoutABarcodeIsCreatedOnceOnline() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        let entryModel = BeanEntryModel(barcode: nil, client: harness.server.client(), offlineStore: harness.store)

        await entryModel.save()

        guard case .savedOffline(let beanID) = entryModel.state else {
            return XCTFail("expected the bean to be saved on the device, got \(entryModel.state)")
        }
        let editor = ShelfEntryEditorModel(mode: .addStored(beanID), store: harness.store)
        let entry = try XCTUnwrap(harness.store.shelfEntry(localID: try XCTUnwrap(editor.save())))
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try harness.store.addBrew(brew, shelfEntry: entry)
        let bean = try XCTUnwrap(harness.store.bean(localID: beanID))
        comeOnline(harness)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        try assertBrewOnServer(harness, Offline(bean: bean, entry: entry, brew: brew), beanID: try XCTUnwrap(bean.serverID))
    }

    func testWithoutAStoreAFailedSaveStillOffersTryAgain() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let entryModel = BeanEntryModel(barcode: nil, client: server.client())

        await entryModel.save()

        XCTAssertEqual(entryModel.state, .failed(.retryable))
    }

    // MARK: - Durability

    func testAPendingBeanAndItsWaitingWritesSurviveARestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "PendingBeanSyncTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let account = AccountID(subject: AuthFixtures.subject)
        let barcode = try XCTUnwrap(CanonicalBarcode(PendingBeanSyncTests.barcode))
        let beanID: UUID
        do {
            let store = try AccountStore.open(for: account, in: directory)
            beanID = try store.pendingBean(barcode: barcode).localID
            let editor = ShelfEntryEditorModel(mode: .addStored(beanID), store: store)
            let entry = try XCTUnwrap(store.shelfEntry(localID: try XCTUnwrap(editor.save())))
            try store.addBrew(try StoredBrew(try StoreFixtures.brewInput()), shelfEntry: entry)
        }

        let reopened = try AccountStore.open(for: account, in: directory)

        XCTAssertEqual(try queue(reopened), ["look_up bean", "create shelf_entry", "create brew"])
        XCTAssertEqual(try reopened.shelfEntries().first?.bean?.localID, beanID)
        XCTAssertEqual(try reopened.pendingBeanStates()[beanID], .lookingUp)
    }
}
