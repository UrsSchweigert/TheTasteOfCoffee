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
    /// Not `StoreFixtures`' bean barcode, so a scan here never matches the synced fixture bean.
    private static let barcode = "5901234123457"

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

    private var scanned: CanonicalBarcode {
        get throws { try XCTUnwrap(CanonicalBarcode(PendingBeanSyncTests.barcode)) }
    }

    /// The offline part of every case: the scan's lookup fails, the bag goes on the shelf
    /// (which saves the pending bean with the entry) and a brew is logged. A drain then sends
    /// nothing: the look-up waits for the network, and the entry and brew wait for their bean.
    private func scanShelveAndBrewOffline(_ harness: Harness) async throws -> Offline {
        goOffline(harness)
        let lookup = LookupModel(barcode: try scanned, client: harness.server.client())
        await lookup.lookUp()
        XCTAssertEqual(lookup.state, .pickList(.unavailable))
        XCTAssertTrue(lookup.canKeepForLater)
        lookup.keepForLater()
        XCTAssertEqual(lookup.state, .keptForLater)
        // Nothing is stored before the form is saved.
        XCTAssertTrue(try harness.store.beans().isEmpty)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)

        let editor = ShelfEntryEditorModel(mode: .addScanned(try scanned), store: harness.store)
        XCTAssertTrue(editor.canSave)
        let entryID = try XCTUnwrap(editor.save())
        let entry = try XCTUnwrap(harness.store.shelfEntry(localID: entryID))
        let bean = try XCTUnwrap(entry.bean)
        XCTAssertEqual(bean.barcode, PendingBeanSyncTests.barcode)

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
        XCTAssertNil(bean.serverID)
        return Offline(bean: bean, entry: entry, brew: brew)
    }

    /// Online, the look-up finds nothing the user accepted: the bean waits for a description
    /// and nothing that names it is sent.
    private func reachDescription(_ harness: Harness, _ offline: Offline, after expected: [String]) async throws -> PendingBeansModel {
        let before = harness.server.requests.count
        let result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), expected)
        XCTAssertEqual(try queue(harness.store), ["await_description bean", "create shelf_entry", "create brew"])
        XCTAssertTrue(harness.server.backend.storedBeans.isEmpty)
        let shelf = ShelfModel(store: harness.store)
        shelf.reload()
        XCTAssertEqual(shelf.rows.first?.pendingBean, .awaitingDescription)
        XCTAssertEqual(shelf.questionCount, 1)
        let prompts = PendingBeansModel(store: harness.store)
        prompts.reload()
        XCTAssertEqual(prompts.current?.beanID, offline.bean.localID)
        XCTAssertEqual(prompts.current?.kind, .describe)
        XCTAssertEqual(prompts.current?.barcode, try scanned)
        return prompts
    }

    /// The user describes the bean with the pick-list entry, as online.
    private func describe(_ harness: Harness, _ offline: Offline) async throws -> Vocabulary.Process {
        let entry = BeanEntryModel(
            barcode: try scanned,
            client: harness.server.client(),
            offlineStore: harness.store,
            describing: offline.bean.localID
        )
        let process = try StoreFixtures.first(Vocabulary.Process.self)
        entry.picks.process = process
        let before = harness.server.requests.count
        await entry.save()
        XCTAssertEqual(entry.state, .savedOffline(offline.bean.localID))
        XCTAssertEqual(harness.server.requests.count, before, "describing sends nothing itself")
        XCTAssertEqual(try queue(harness.store), ["create bean", "create shelf_entry", "create brew"])
        return process
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

    private var lookUpRequests: [String] {
        ["GET /barcodes/\(PendingBeanSyncTests.barcode)", "GET /barcodes/\(PendingBeanSyncTests.barcode)/open_food_facts"]
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
        XCTAssertTrue(try harness.store.pendingBeanQuestions().isEmpty)
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
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), lookUpRequests)
        XCTAssertEqual(try queue(harness.store), ["await_confirmation bean", "create shelf_entry", "create brew"])
        XCTAssertTrue(harness.server.backend.storedBeans.isEmpty)
        // Not the bean's name before the user said so.
        XCTAssertNil(ShelfBeanSummary(offline.bean).name)
        let shelf = ShelfModel(store: harness.store)
        shelf.reload()
        XCTAssertEqual(shelf.rows.first?.pendingBean, .awaitingConfirmation)
        XCTAssertEqual(shelf.questionCount, 1)

        // A drain before the answer still waits.
        before = harness.server.requests.count
        result = await harness.engine.drain()
        XCTAssertEqual(result, .idle)
        XCTAssertEqual(harness.server.requests.count, before)

        // The next opening asks.
        let prompts = PendingBeansModel(store: harness.store)
        prompts.reload()
        XCTAssertEqual(prompts.current?.beanID, offline.bean.localID)
        XCTAssertEqual(prompts.current?.kind, .confirm(product))
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

    func testARejectedHitAsksForADescriptionAndTheDescribedBeanIsCreated() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        harness.server.backend.seed(openFoodFacts: product, barcode: PendingBeanSyncTests.barcode)
        comeOnline(harness)
        _ = await harness.engine.drain()
        let confirmations = PendingBeansModel(store: harness.store)
        confirmations.reload()
        XCTAssertEqual(confirmations.current?.kind, .confirm(product))

        confirmations.reject()

        // The same bean is asked about again, now for a description (F1 step 4).
        XCTAssertEqual(confirmations.current?.beanID, offline.bean.localID)
        XCTAssertEqual(confirmations.current?.kind, .describe)
        XCTAssertFalse(offline.bean.hasOpenFoodFactsProduct)
        XCTAssertEqual(try queue(harness.store), ["await_description bean", "create shelf_entry", "create brew"])
        var before = harness.server.requests.count
        _ = await harness.engine.drain()
        XCTAssertEqual(harness.server.requests.count, before, "nothing goes out before the description")

        let process = try await describe(harness, offline)

        before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["POST /beans", "POST /shelf", "POST /brews"])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertNil(sent.openFoodFactsConfirmed)
        XCTAssertEqual(sent.attributes.process, process)
        let beanID = try XCTUnwrap(offline.bean.serverID)
        try assertBrewOnServer(harness, offline, beanID: beanID)
        XCTAssertNil(harness.server.backend.storedBeans[beanID]?.openFoodFacts)
        XCTAssertNil(offline.bean.openFoodFactsName)
    }

    func testAMissAsksForADescriptionAndTheDescribedBeanIsCreated() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        comeOnline(harness)
        _ = try await reachDescription(harness, offline, after: lookUpRequests)

        let process = try await describe(harness, offline)
        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["POST /beans", "POST /shelf", "POST /brews"])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertNil(sent.openFoodFactsConfirmed)
        XCTAssertEqual(sent.attributes.process, process)
        try assertBrewOnServer(harness, offline, beanID: try XCTUnwrap(offline.bean.serverID))
        XCTAssertTrue(try harness.store.pendingBeanQuestions().isEmpty)
    }

    func testAMissTheUserSkipsIsCreatedFromItsBarcode() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        comeOnline(harness)
        let prompts = try await reachDescription(harness, offline, after: lookUpRequests)

        prompts.skip()
        XCTAssertNil(prompts.current)
        let before = harness.server.requests.count
        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(Array(harness.server.log.dropFirst(before)), ["POST /beans", "POST /shelf", "POST /brews"])
        let sent = try body(API.BeanCreate.self, of: harness.server.requests[before])
        XCTAssertEqual(sent.barcode, PendingBeanSyncTests.barcode)
        XCTAssertEqual(sent.attributes, API.BeanAttributes())
        try assertBrewOnServer(harness, offline, beanID: try XCTUnwrap(offline.bean.serverID))
    }

    func testADescriptionWithAPhotoQueuesItForTheBean() async throws {
        let harness = try makeHarness()
        let root = LabelPhotoFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let folders = LabelPhotoFolders(root: root)
        let offline = try await scanShelveAndBrewOffline(harness)
        comeOnline(harness)
        _ = try await reachDescription(harness, offline, after: lookUpRequests)
        let entry = BeanEntryModel(
            barcode: try scanned,
            client: harness.server.client(),
            labelPhotos: LabelPhotoFixtures.photoAccount(files: folders.store(for: LabelPhotoFixtures.account)),
            offlineStore: harness.store,
            describing: offline.bean.localID
        )
        await entry.labelPhoto.attach(LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 40, height: 20), orientation: .up))

        await entry.save()

        XCTAssertEqual(entry.state, .savedOffline(offline.bean.localID))
        let queued = try XCTUnwrap(harness.store.queuedLabelPhotos().first)
        XCTAssertEqual(queued.beanLocalID, offline.bean.localID)
        XCTAssertEqual(folders.queue(for: LabelPhotoFixtures.account).files().map(\.lastPathComponent), [queued.fileName])
    }

    // MARK: - Pending beans without a shelf entry

    func testACancelledShelfFormLeavesNothing() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        let lookup = LookupModel(barcode: try scanned, client: harness.server.client())
        await lookup.lookUp()
        lookup.keepForLater()
        // The form opens and is closed without saving.
        _ = ShelfEntryEditorModel(mode: .addScanned(try scanned), store: harness.store)

        XCTAssertTrue(try harness.store.beans().isEmpty)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
        comeOnline(harness)
        let before = harness.server.requests.count
        _ = await harness.engine.drain()
        XCTAssertEqual(harness.server.requests.count, before)
    }

    func testRemovingTheLastShelfEntryOfAPendingBeanRemovesTheBeanAndItsQueue() throws {
        let store = try AccountStore.inMemory()
        let first = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store).save())
        let second = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store).save())
        let firstEntry = try XCTUnwrap(store.shelfEntry(localID: first))
        let beanID = try XCTUnwrap(firstEntry.bean?.localID)
        XCTAssertEqual(try store.shelfEntry(localID: second)?.bean?.localID, beanID, "one bean per barcode")
        store.queueLabelPhoto(fileName: "label.jpg", beanLocalID: beanID)
        try store.save()

        try store.markDeleted(firstEntry)
        XCTAssertNotNil(try store.bean(localID: beanID), "still on the other entry")

        try store.markDeleted(try XCTUnwrap(store.shelfEntry(localID: second)))

        XCTAssertNil(try store.bean(localID: beanID))
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
    }

    func testTheEngineDropsAPendingBeanWithoutAShelfEntry() async throws {
        let harness = try makeHarness()
        // As a form that was saved and its entry removed by a path that left the bean.
        let bean = try harness.store.pendingBean(barcode: try scanned)
        let beanID = bean.localID
        try harness.store.save()
        comeOnline(harness)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertTrue(harness.server.requests.isEmpty)
        XCTAssertNil(try harness.store.bean(localID: beanID))
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testQuestionsSkipBeansWithoutAShelfEntry() async throws {
        let harness = try makeHarness()
        let offline = try await scanShelveAndBrewOffline(harness)
        comeOnline(harness)
        _ = try await reachDescription(harness, offline, after: lookUpRequests)
        // The brew and then the entry go (both were never sent): the bean goes with them.
        try harness.store.markDeleted(offline.brew)
        try harness.store.markDeleted(offline.entry)

        XCTAssertTrue(try harness.store.pendingBeanQuestions().isEmpty)
        let shelf = ShelfModel(store: harness.store)
        shelf.reload()
        XCTAssertEqual(shelf.questionCount, 0)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
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

    func testAnEarlierEntryMovedToAPendingBeanWaitsForItsLookUp() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        // An entry made offline on a cached catalogue bean (sequence 1)...
        let cached = StoredBean(catalogueBean(id(905), barcode: nil))
        try harness.store.addBean(cached, syncState: .synced)
        harness.server.backend.seed(bean: catalogueBean(id(905), barcode: nil))
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try harness.store.addShelfEntry(entry, bean: cached)
        // ...then a pending scan with an entry of its own (sequences 2 and 3)...
        let otherID = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: harness.store).save())
        let pending = try XCTUnwrap(harness.store.shelfEntry(localID: otherID)?.bean)
        // ...and the first entry moved to the pending bean before anything was sent.
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: harness.store)
        editor.chooseBean(ShelfBeanChoice(id: pending.localID, summary: ShelfBeanSummary(pending)))
        XCTAssertNotNil(editor.save())
        XCTAssertEqual(try queue(harness.store), ["create shelf_entry", "look_up bean", "create shelf_entry"])
        harness.server.backend.seed(bean: catalogueBean(id(906), barcode: PendingBeanSyncTests.barcode))
        comeOnline(harness)

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        // The look-up went first, so the entry carried the bean's server id and was not parked.
        XCTAssertEqual(harness.server.log, ["GET /barcodes/\(PendingBeanSyncTests.barcode)", "POST /shelf", "POST /shelf"])
        let entryID = try XCTUnwrap(entry.serverID)
        XCTAssertEqual(harness.server.backend.shelfEntries[entryID]?.beanId, id(906))
        XCTAssertNil(entry.syncIssue)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testADeleteOfAnEntryMovedToAPendingBeanDoesNotWaitForTheBean() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        // An entry the server has, on a synced bean.
        let synced = try StoreFixtures.syncedShelfEntry(in: harness.store)
        harness.server.backend.seed(bean: catalogueBean(StoreFixtures.beanID, barcode: nil))
        harness.server.backend.seed(shelfEntry: StoreFixtures.shelfEntryID, try StoreFixtures.shelfEntryInput())
        // A pending scan on the shelf, then the synced entry moved to it and removed, offline.
        let otherID = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: harness.store).save())
        let pending = try XCTUnwrap(harness.store.shelfEntry(localID: otherID)?.bean)
        let editor = ShelfEntryEditorModel(mode: .edit(synced.localID), store: harness.store)
        editor.chooseBean(ShelfBeanChoice(id: pending.localID, summary: ShelfBeanSummary(pending)))
        XCTAssertNotNil(editor.save())
        try harness.store.markDeleted(synced)
        XCTAssertEqual(try queue(harness.store), ["look_up bean", "create shelf_entry", "delete shelf_entry"])
        harness.server.backend.seed(openFoodFacts: product, barcode: PendingBeanSyncTests.barcode)
        comeOnline(harness)

        _ = await harness.engine.drain()

        // The bean waits for the user; the delete went all the same.
        XCTAssertNil(harness.server.backend.shelfEntries[StoreFixtures.shelfEntryID])
        XCTAssertEqual(try queue(harness.store), ["await_confirmation bean", "create shelf_entry"])
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

        let result = await harness.engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertNotNil(recipe.serverID)
        let lookUp = try XCTUnwrap(harness.store.outboxOperations().first)
        XCTAssertEqual(lookUp.action, .lookUp)
        XCTAssertEqual(lookUp.nextAttemptAt, harness.clock.now.addingTimeInterval(SyncEngine.lookUpLimitWait))
        XCTAssertEqual(try harness.store.nextLookUpAttempt(after: harness.clock.now), lookUp.nextAttemptAt)

        // An hour later the cap has room again: no product, so the user is asked to describe it.
        harness.server.backend.setOverride(nil)
        harness.clock.advance(SyncEngine.lookUpLimitWait + 1)
        let prompts = try await reachDescription(harness, offline, after: lookUpRequests)
        prompts.skip()
        _ = await harness.engine.drain()
        try assertBrewOnServer(harness, offline, beanID: try XCTUnwrap(offline.bean.serverID))
    }

    func testAScanOfABarcodeTheDeviceKnowsReusesItsBean() throws {
        let store = try AccountStore.inMemory()
        let first = try store.pendingBean(barcode: try scanned)
        try store.save()
        let second = try store.pendingBean(barcode: try scanned)

        XCTAssertEqual(first.localID, second.localID)
        XCTAssertEqual(try queue(store), ["look_up bean"])
    }

    // MARK: - A bean described offline

    func testAPickListBeanSavedOfflineIsCreatedWithoutAskingAndItsBrewFollows() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        let entryModel = BeanEntryModel(barcode: try scanned, client: harness.server.client(), offlineStore: harness.store)
        let process = try StoreFixtures.first(Vocabulary.Process.self)
        entryModel.picks.process = process

        await entryModel.save()

        guard case .savedOffline(let beanID) = entryModel.state else {
            return XCTFail("expected the bean to be saved on the device, got \(entryModel.state)")
        }
        XCTAssertFalse(entryModel.picksNotKept)
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

    func testASecondOfflineDescriptionFoldsItsPicksIntoTheUnsentCreate() async throws {
        let harness = try makeHarness()
        goOffline(harness)
        let first = BeanEntryModel(barcode: try scanned, client: harness.server.client(), offlineStore: harness.store)
        await first.save()
        let second = BeanEntryModel(barcode: try scanned, client: harness.server.client(), offlineStore: harness.store)
        let process = try StoreFixtures.first(Vocabulary.Process.self)
        second.picks.process = process

        await second.save()

        XCTAssertEqual(first.state, second.state)
        XCTAssertFalse(second.picksNotKept)
        XCTAssertEqual(try queue(harness.store), ["create bean"])
        XCTAssertEqual(try harness.store.beans().first?.pickedAttributes.process, process)
    }

    func testAnOfflineDescriptionOfACatalogueBeanSaysThePicksWereNotKept() async throws {
        let harness = try makeHarness()
        try harness.store.addBean(StoredBean(catalogueBean(id(908), barcode: PendingBeanSyncTests.barcode)), syncState: .synced)
        goOffline(harness)
        let entryModel = BeanEntryModel(barcode: try scanned, client: harness.server.client(), offlineStore: harness.store)
        entryModel.picks.process = try StoreFixtures.first(Vocabulary.Process.self)

        await entryModel.save()

        guard case .savedOffline = entryModel.state else {
            return XCTFail("expected the bean to be saved on the device, got \(entryModel.state)")
        }
        XCTAssertTrue(entryModel.picksNotKept)
        XCTAssertTrue(try harness.store.outboxOperations().isEmpty)
    }

    func testWithoutAStoreAFailedSaveStillOffersTryAgain() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let entryModel = BeanEntryModel(barcode: nil, client: server.client())

        await entryModel.save()

        withExtendedLifetime(server) {
            XCTAssertEqual(entryModel.state, .failed(.retryable))
        }
    }

    // MARK: - Durability

    func testAPendingBeanAndItsWaitingWritesSurviveARestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "PendingBeanSyncTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let account = AccountID(subject: AuthFixtures.subject)
        let beanID: UUID
        do {
            let store = try AccountStore.open(for: account, in: directory)
            let editor = ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store)
            let entry = try XCTUnwrap(store.shelfEntry(localID: try XCTUnwrap(editor.save())))
            beanID = try XCTUnwrap(entry.bean?.localID)
            try store.addBrew(try StoredBrew(try StoreFixtures.brewInput()), shelfEntry: entry)
        }

        let reopened = try AccountStore.open(for: account, in: directory)

        XCTAssertEqual(try queue(reopened), ["look_up bean", "create shelf_entry", "create brew"])
        XCTAssertEqual(try reopened.shelfEntries().first?.bean?.localID, beanID)
        XCTAssertEqual(try reopened.pendingBeanStates()[beanID], .lookingUp)
    }
}
