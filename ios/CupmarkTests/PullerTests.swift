import SwiftData
import XCTest
@testable import Cupmark

/// The pull and merge (M2-T17) against `FakeSyncServer`, with in-memory stores: a full copy
/// on an empty store over several pages, the merge rules (insert, remove, keep pending), the
/// bean fetches, an undecodable item, a profile 404, and how `SyncHost` runs the pull after
/// the outbox and never during a drain.
@MainActor
final class PullerTests: XCTestCase {
    // MARK: - Fixtures

    private func id(_ n: Int) -> String {
        FakeSyncBackend.id(n)
    }

    private func serverBean(_ beanID: String, verified: Bool = true) -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: verified,
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

    /// A brew on `shelfEntryID`, `minute` minutes after a fixed moment, with `dose`.
    private func brewValues(shelfEntryID: String, minute: Int = 0, dose: Int = 180) throws -> API.BrewInput {
        var values = try StoreFixtures.brewInput()
        values.shelfEntryId = shelfEntryID
        let base = values.brewedAt.millisecondsSince1970
        values.brewedAt = try XCTUnwrap(API.Timestamp(millisecondsSince1970: base + Int64(minute) * 60_000))
        values.parameters.doseDg = dose
        return values
    }

    private func recipeValues(dose: Int = 180) throws -> API.RecipeInput {
        var parameters = try StoreFixtures.parameters()
        parameters.doseDg = dose
        return API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters)
    }

    private func profileValues(consent: Bool = true) -> API.Profile {
        API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: consent))
    }

    private func puller(_ store: AccountStore, _ server: FakeSyncServer, tokens: FakeTokenProvider = FakeTokenProvider()) -> Puller {
        Puller(store: store, client: server.client(tokens: tokens))
    }

    private struct PullDidNotComplete: Error {}

    /// The report of a completed pull; fails the test otherwise.
    private func completed(_ result: Puller.Result, file: StaticString = #filePath, line: UInt = #line) throws -> PullReport {
        guard case .completed(let summary) = result else {
            XCTFail("pull did not complete: \(result)", file: file, line: line)
            throw PullDidNotComplete()
        }
        return summary
    }

    private func all<Model: PersistentModel>(_ type: Model.Type, in store: AccountStore) throws -> [Model] {
        try store.context.fetch(FetchDescriptor<Model>())
    }

    /// A bean and a shelf entry on the server, and the same, synced, on the device.
    @discardableResult
    private func syncedShelfEntry(_ store: AccountStore, _ server: FakeSyncServer, beanID: Int = 901, entryID: Int = 902) throws -> StoredShelfEntry {
        let bean = serverBean(id(beanID))
        let values = try shelfValues(beanID: id(beanID))
        server.backend.seed(bean: bean)
        server.backend.seed(shelfEntry: id(entryID), values)
        let local: StoredBean
        if let cached = try store.bean(serverID: id(beanID)) {
            local = cached
        } else {
            local = StoredBean(bean)
            try store.addBean(local, syncState: .synced)
        }
        let entry = StoredShelfEntry(values, serverID: id(entryID))
        try store.addShelfEntry(entry, bean: local, syncState: .synced)
        return entry
    }

    /// A brew on the server, and the same, synced, on the device.
    @discardableResult
    private func syncedBrew(_ store: AccountStore, _ server: FakeSyncServer, on entry: StoredShelfEntry, brewID: Int, minute: Int) throws -> StoredBrew {
        let values = try brewValues(shelfEntryID: try XCTUnwrap(entry.serverID), minute: minute)
        server.backend.seed(brew: id(brewID), values)
        let brew = try StoredBrew(values, serverID: id(brewID))
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    private func count(_ request: String, in server: FakeSyncServer) -> Int {
        server.log.filter { line in line == request }.count
    }

    // MARK: - A full copy

    func testAnEmptyStoreGetsAFullCopyWith250BrewsOverThreePages() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let beanID = id(901)
        let entryID = id(902)
        server.backend.seed(bean: serverBean(beanID))
        server.backend.seed(shelfEntry: entryID, try shelfValues(beanID: beanID))
        for n in 0..<250 {
            server.backend.seed(brew: id(1000 + n), try brewValues(shelfEntryID: entryID, minute: n))
        }
        server.backend.seed(recipe: id(903), try recipeValues())
        server.backend.seed(profile: profileValues())

        let report = try completed(await puller(store, server).pull())

        // Three pages of at most 100, the next two with the cursor of the page before.
        let brewPages = server.requests.filter { request in request.method == "GET" && request.path == "/brews" }
        XCTAssertEqual(brewPages.count, 3)
        XCTAssertEqual(brewPages.map { request in request.queryItems.first { item in item.name == "cursor" }?.value }, [nil, "o100", "o200"])
        XCTAssertEqual(count("GET /beans/\(beanID)", in: server), 1)

        let brews = try all(StoredBrew.self, in: store)
        XCTAssertEqual(brews.count, 250)
        XCTAssertEqual(Set(brews.compactMap(\.serverID)).count, 250)
        XCTAssertTrue(brews.allSatisfy { brew in brew.syncState == .synced && brew.shelfEntry?.serverID == entryID })
        XCTAssertEqual(try store.brewsNewestFirst().first?.serverID, id(1249))

        let entry = try XCTUnwrap(try store.shelfEntries().first)
        XCTAssertEqual(entry.serverID, entryID)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(entry.bean?.serverID, beanID)
        XCTAssertEqual(entry.bean?.syncState, .synced)
        XCTAssertEqual(try store.recipes().map(\.serverID), [id(903)])
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(profile.contributeToAggregates)

        // Read from the server, so nothing is queued to go back.
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertEqual(report.inserted, 1 + 250 + 1 + 1)
        XCTAssertEqual(report.beansFetched, 1)
        XCTAssertEqual(report.removed, 0)
        XCTAssertEqual(report.skippedItems, 0)
        XCTAssertTrue(report.profileFound)

        // A second pull finds the same values: nothing changes and the verified bean is cached.
        let again = try completed(await puller(store, server).pull())
        XCTAssertEqual(again.inserted, 0)
        XCTAssertEqual(again.updated, 0)
        XCTAssertEqual(again.removed, 0)
        XCTAssertEqual(again.beansFetched, 0)
        XCTAssertEqual(count("GET /beans/\(beanID)", in: server), 1)
        XCTAssertEqual(try all(StoredBrew.self, in: store).count, 250)
    }

    // MARK: - Merge rules

    func testTheMergeInsertsRemovesUpdatesAndKeepsPendingItems() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let entry = try syncedShelfEntry(store, server, beanID: 901, entryID: 902)
        let entryID = try XCTUnwrap(entry.serverID)

        // Changed on another device: takes the server's values.
        let changed = try syncedBrew(store, server, on: entry, brewID: 10, minute: 1)
        server.backend.seed(brew: id(10), try brewValues(shelfEntryID: entryID, minute: 1, dose: 200))
        // Deleted on another device: removed.
        let deleted = try syncedBrew(store, server, on: entry, brewID: 11, minute: 2)
        server.backend.remove(brew: id(11))
        // Edited here and not sent yet, changed there too: keeps the local edit.
        let edited = try syncedBrew(store, server, on: entry, brewID: 12, minute: 3)
        edited.doseDg = 150
        try store.markUpdated(edited)
        server.backend.seed(brew: id(12), try brewValues(shelfEntryID: entryID, minute: 3, dose: 210))
        // Removed here, delete not sent, and already gone there: stays until the delete is answered.
        let removing = try syncedBrew(store, server, on: entry, brewID: 13, minute: 4)
        try store.markDeleted(removing)
        server.backend.remove(brew: id(13))
        // Only on the server: inserted.
        server.backend.seed(brew: id(14), try brewValues(shelfEntryID: entryID, minute: 5))
        // Made here, never sent: not on the server and not removed.
        let local = try StoredBrew(try brewValues(shelfEntryID: entryID, minute: 6))
        try store.addBrew(local, shelfEntry: entry)

        // A shelf entry gone on the server and without brews is removed; one gone there that
        // still has a brew waiting to be sent stays.
        let emptyEntry = try syncedShelfEntry(store, server, beanID: 901, entryID: 903)
        server.backend.remove(shelfEntry: id(903))
        let busyEntry = try syncedShelfEntry(store, server, beanID: 901, entryID: 904)
        server.backend.remove(shelfEntry: id(904))
        let waiting = try StoredBrew(try brewValues(shelfEntryID: id(904), minute: 7))
        try store.addBrew(waiting, shelfEntry: busyEntry)

        // Recipes: one gone on the server, one made here.
        let recipe = StoredRecipe(try recipeValues(), serverID: id(20))
        try store.addRecipe(recipe, syncState: .synced)
        let newRecipe = StoredRecipe(try recipeValues(dose: 160))
        try store.addRecipe(newRecipe)

        let changedID = changed.localID
        let deletedID = deleted.localID
        let editedID = edited.localID
        let removingID = removing.localID
        let localID = local.localID
        let emptyEntryID = emptyEntry.localID
        let busyEntryID = busyEntry.localID
        let recipeID = recipe.localID
        let newRecipeID = newRecipe.localID
        let queuedBefore = try store.outboxOperations().count

        let report = try completed(await puller(store, server).pull())

        let updated = try XCTUnwrap(try store.brew(localID: changedID))
        XCTAssertEqual(updated.doseDg, 200)
        XCTAssertEqual(updated.syncState, .synced)
        XCTAssertNil(try store.brew(localID: deletedID))

        let kept = try XCTUnwrap(try store.brew(localID: editedID))
        XCTAssertEqual(kept.doseDg, 150)
        XCTAssertEqual(kept.syncState, .pendingUpdate)
        XCTAssertEqual(try store.brew(localID: removingID)?.syncState, .pendingDelete)
        XCTAssertEqual(try store.brew(localID: localID)?.syncState, .pendingCreate)

        let inserted = try XCTUnwrap(try store.brew(serverID: id(14)))
        XCTAssertEqual(inserted.syncState, .synced)
        XCTAssertEqual(inserted.shelfEntry?.localID, entry.localID)

        XCTAssertNil(try store.shelfEntry(localID: emptyEntryID))
        XCTAssertNotNil(try store.shelfEntry(localID: busyEntryID))
        XCTAssertEqual(try store.brew(localID: waiting.localID)?.shelfEntry?.localID, busyEntryID)
        XCTAssertNotNil(try store.shelfEntry(localID: entry.localID))

        XCTAssertNil(try store.recipe(localID: recipeID))
        XCTAssertEqual(try store.recipe(localID: newRecipeID)?.syncState, .pendingCreate)

        // The pull queues nothing and drops nothing from the outbox.
        XCTAssertEqual(try store.outboxOperations().count, queuedBefore)

        XCTAssertEqual(report.inserted, 1)
        XCTAssertEqual(report.updated, 1)
        // Brew 11, the empty shelf entry and the recipe.
        XCTAssertEqual(report.removed, 3)
        XCTAssertEqual(report.keptPending, 1)
        XCTAssertFalse(report.profileFound)
    }

    // MARK: - Beans

    func testShelfBeansAreFetchedWhenNotCachedAndAgainWhileUnverified() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let uncached = id(901)
        let unverified = id(902)
        let verified = id(903)
        let missing = id(904)

        // Not cached here.
        server.backend.seed(bean: serverBean(uncached))
        server.backend.seed(shelfEntry: id(911), try shelfValues(beanID: uncached))
        // Cached unverified; verified on the server since, with operator attributes.
        var reviewed = serverBean(unverified, verified: true)
        reviewed.operatorAttributes = API.BeanAttributes(origin: try StoreFixtures.last(Vocabulary.Origin.self))
        server.backend.seed(bean: reviewed)
        let stale = StoredBean(serverBean(unverified, verified: false))
        try store.addBean(stale, syncState: .synced)
        let staleEntry = StoredShelfEntry(try shelfValues(beanID: unverified), serverID: id(912))
        try store.addShelfEntry(staleEntry, bean: stale, syncState: .synced)
        server.backend.seed(shelfEntry: id(912), try shelfValues(beanID: unverified))
        // Cached and verified: not fetched again.
        server.backend.seed(bean: serverBean(verified))
        try store.addBean(StoredBean(serverBean(verified)), syncState: .synced)
        server.backend.seed(shelfEntry: id(913), try shelfValues(beanID: verified))
        // A bean the server does not return: its entry is left out and counted.
        server.backend.seed(shelfEntry: id(914), try shelfValues(beanID: missing))

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(count("GET /beans/\(uncached)", in: server), 1)
        XCTAssertEqual(count("GET /beans/\(unverified)", in: server), 1)
        XCTAssertEqual(count("GET /beans/\(verified)", in: server), 0)
        XCTAssertEqual(count("GET /beans/\(missing)", in: server), 1)

        let fetched = try XCTUnwrap(try store.bean(serverID: uncached))
        XCTAssertEqual(fetched.syncState, .synced)
        XCTAssertEqual(try store.shelfEntry(serverID: id(911))?.bean?.serverID, uncached)

        let refreshed = try XCTUnwrap(try store.bean(serverID: unverified))
        XCTAssertEqual(refreshed.localID, stale.localID)
        XCTAssertTrue(refreshed.verified)
        XCTAssertEqual(refreshed.operatorAttributes.origin, try StoreFixtures.last(Vocabulary.Origin.self))

        XCTAssertEqual(try store.shelfEntry(serverID: id(913))?.bean?.serverID, verified)
        XCTAssertNil(try store.shelfEntry(serverID: id(914)))
        XCTAssertNil(try store.bean(serverID: missing))

        XCTAssertEqual(report.beansFetched, 2)
        XCTAssertEqual(report.unresolvedItems, 1)
        XCTAssertEqual(report.skippedItems, 1)
        XCTAssertEqual(report.inserted, 2)
    }

    // MARK: - Undecodable items

    func testAnUndecodableItemIsSkippedAndCountedAndBlocksRemovalsOfItsList() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let entry = try syncedShelfEntry(store, server)
        let entryID = try XCTUnwrap(entry.serverID)
        // Synced here, and not in the server's list as it decodes: it may be the item that
        // does not decode, so it stays.
        let synced = try StoredBrew(try brewValues(shelfEntryID: entryID, minute: 9), serverID: id(30))
        try store.addBrew(synced, shelfEntry: entry, syncState: .synced)

        // A page with two brews, the second with a method from a newer vocabulary.
        let good = API.Brew(brewId: id(31), values: try brewValues(shelfEntryID: entryID, minute: 1))
        let newer = API.Brew(brewId: id(32), values: try brewValues(shelfEntryID: entryID, minute: 2))
        let encoded = try JSONEncoder().encode(API.BrewPage(items: [good, newer]))
        var page = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        var items = try XCTUnwrap(page["items"] as? [[String: Any]])
        var values = try XCTUnwrap(items[1]["values"] as? [String: Any])
        var parameters = try XCTUnwrap(values["parameters"] as? [String: Any])
        parameters["method"] = "method_from_a_newer_vocabulary"
        values["parameters"] = parameters
        items[1]["values"] = values
        page["items"] = items
        let body = try JSONSerialization.data(withJSONObject: page)
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/brews" ? StubResponse(status: 200, body: body) : nil
        }

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(report.undecodableItems, 1)
        XCTAssertEqual(report.skippedItems, 1)
        XCTAssertEqual(report.inserted, 1)
        XCTAssertEqual(report.removed, 0)
        XCTAssertNotNil(try store.brew(serverID: id(31)))
        XCTAssertNil(try store.brew(serverID: id(32)))
        XCTAssertNotNil(try store.brew(localID: synced.localID))
        XCTAssertNotNil(try store.shelfEntry(localID: entry.localID))
    }

    func testAnUndecodableBeanIsSkippedAndCountedAndKeepsItsCachedCopy() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let cachedID = id(901)
        let uncachedID = id(902)
        // Cached and unverified, so it is fetched again; the answer does not decode.
        let cached = StoredBean(serverBean(cachedID, verified: false))
        try store.addBean(cached, syncState: .synced)
        server.backend.seed(bean: serverBean(cachedID, verified: true))
        server.backend.seed(shelfEntry: id(911), try shelfValues(beanID: cachedID))
        // Not cached, and its answer does not decode either: its entry stays out.
        server.backend.seed(bean: serverBean(uncachedID))
        server.backend.seed(shelfEntry: id(912), try shelfValues(beanID: uncachedID))
        let unreadable = Data(#"{"bean_id":"not a bean"}"#.utf8)
        server.backend.setOverride { request in
            request.method == "GET" && request.path.hasPrefix("/beans/") ? StubResponse(status: 200, body: unreadable) : nil
        }

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(report.undecodableItems, 2)
        XCTAssertEqual(report.unresolvedItems, 1)
        XCTAssertEqual(report.skippedItems, 3)
        XCTAssertEqual(report.beansFetched, 0)
        let kept = try XCTUnwrap(try store.bean(serverID: cachedID))
        XCTAssertEqual(kept.localID, cached.localID)
        XCTAssertFalse(kept.verified)
        XCTAssertEqual(try store.shelfEntry(serverID: id(911))?.bean?.localID, cached.localID)
        XCTAssertNil(try store.shelfEntry(serverID: id(912)))
        XCTAssertNil(try store.bean(serverID: uncachedID))
    }

    // MARK: - Profile

    func testAnUndecodableProfileIsSkippedAndCountedAndTheLocalOneStays() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let local = StoredProfile(profileValues(consent: false))
        local.syncState = .synced
        store.context.insert(local)
        try store.save()
        let newer = Data(#"{"locale":"zz_newer_language","consent":{"contribute_to_aggregates":true}}"#.utf8)
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/profile" ? StubResponse(status: 200, body: newer) : nil
        }

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(report.undecodableItems, 1)
        XCTAssertEqual(report.skippedItems, 1)
        // Not a 404: the server has a profile this build cannot read.
        XCTAssertTrue(report.profileFound)
        XCTAssertEqual(report.updated, 0)
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.localID, local.localID)
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.syncState, .synced)
    }

    // MARK: - Unchanged values and parked operations

    func testFlavourNotesInAnotherOrderAreNotAChange() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let entry = try syncedShelfEntry(store, server)
        let brew = try syncedBrew(store, server, on: entry, brewID: 40, minute: 1)
        var reordered = try brewValues(shelfEntryID: try XCTUnwrap(entry.serverID), minute: 1)
        let notes = try XCTUnwrap(reordered.rating?.flavourNotes)
        XCTAssertGreaterThan(Set(notes).count, 1, "the fixture needs two different notes")
        reordered.rating?.flavourNotes = Array(notes.reversed())
        server.backend.seed(brew: id(40), reordered)
        let before = brew.rating?.flavourNotes

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(report.updated, 0)
        XCTAssertEqual(try store.brew(localID: brew.localID)?.rating?.flavourNotes, before)
        XCTAssertTrue(Puller.sameValues(try brew.apiInput(), reordered))
    }

    func testASyncedItemWithAParkedOperationKeepsItsValues() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let recipe = StoredRecipe(try recipeValues(dose: 180), serverID: id(50))
        try store.addRecipe(recipe, syncState: .synced)
        server.backend.seed(recipe: id(50), try recipeValues(dose: 200))
        // A local edit whose update was refused and parked; the item is synced again, as a
        // screen might leave it, but the parked operation still protects it.
        recipe.doseDg = 150
        try store.markUpdated(recipe)
        let operation = try XCTUnwrap(try store.outboxOperations(for: recipe.localID).first)
        operation.parked = true
        operation.parkReason = .rejected
        recipe.syncState = .synced
        try store.save()

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(report.keptPending, 1)
        XCTAssertEqual(report.updated, 0)
        XCTAssertEqual(try store.recipe(localID: recipe.localID)?.doseDg, 150)
        XCTAssertEqual(try store.outboxOperations(for: recipe.localID).first?.parked, true)
    }

    func testAProfile404CreatesNoProfile() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        server.backend.seed(profile: nil)

        let report = try completed(await puller(store, server).pull())

        XCTAssertEqual(count("GET /profile", in: server), 1)
        XCTAssertFalse(report.profileFound)
        XCTAssertNil(try store.profile())
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertFalse(server.log.contains("PUT /profile"))
    }

    func testAProfileEditedHereKeepsItsValuesAndASyncedOneTakesTheServers() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: true))
        try store.setProfile(profileValues(consent: false))

        let pending = try completed(await puller(store, server).pull())
        XCTAssertEqual(pending.keptPending, 1)
        XCTAssertEqual(try store.profile()?.contributeToAggregates, false)

        // Once the edit is answered (here: the operation removed and the profile synced), the
        // server's values win again.
        let answered = try XCTUnwrap(try store.profile())
        try store.removeOutboxOperations(for: answered.localID)
        answered.syncState = .synced
        try store.save()
        let synced = try completed(await puller(store, server).pull())
        XCTAssertEqual(synced.updated, 1)
        XCTAssertEqual(try store.profile()?.contributeToAggregates, true)
    }

    // MARK: - Failures

    func testAFailedRequestWritesNothing() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        server.backend.seed(recipe: id(20), try recipeValues())
        server.backend.setOverride { request in
            request.path == "/profile" ? StubResponse(status: 500) : nil
        }

        let result = await puller(store, server).pull()

        XCTAssertEqual(result, .failed(.server(status: 500)))
        XCTAssertTrue(try store.recipes().isEmpty)
    }

    func testAPullRefusedAfterARefreshAsksForSignIn() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in StubResponse(status: 401) }

        let result = await puller(store, server, tokens: FakeTokenProvider(refreshFails: true)).pull()

        XCTAssertEqual(result, .signInRequired)
    }

    // MARK: - SyncHost

    private func makeHost(_ server: FakeSyncServer, tokens: FakeTokenProvider = FakeTokenProvider(), clock: TestClock = TestClock()) -> SyncHost {
        let client = server.client(tokens: tokens)
        return SyncHost(
            makeStore: { _ in try AccountStore.inMemory() },
            makeEngine: { _, store in SyncEngine(store: store, client: client) },
            makePuller: { _, store in Puller(store: store, client: client) },
            now: { clock.now }
        )
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

    func testTheHostPullsAfterSignInOnceTheOutboxHasDrained() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(recipe: id(500), try recipeValues(dose: 200))
        let host = makeHost(server)
        defer { host.switchTo(nil) }

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let store = try XCTUnwrap(host.store)
        try store.addRecipe(StoredRecipe(try recipeValues(dose: 150)))

        try await waitUntil("first pull") { host.lastPull != nil }

        let log = server.log
        let post = try XCTUnwrap(log.firstIndex(of: "POST /recipes"))
        let pull = try XCTUnwrap(log.firstIndex(of: "GET /shelf"))
        XCTAssertLessThan(post, pull, "the outbox goes before the pull")
        let recipes = try store.recipes()
        XCTAssertEqual(recipes.count, 2)
        XCTAssertTrue(recipes.allSatisfy { recipe in recipe.syncState == .synced && recipe.serverID != nil })
        XCTAssertEqual(host.lastPull?.skippedItems, 0)
    }

    func testADrainIsBusyWhileAPullRunsAndTheForegroundPullsAgain() async throws {
        let server = try FakeSyncServer()
        let emptyPage = try JSONEncoder().encode(API.ShelfEntryPage(items: []))
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/shelf" ? StubResponse(status: 200, body: emptyPage, delay: 0.5) : nil
        }
        let host = makeHost(server)
        defer { host.switchTo(nil) }
        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let engine = try XCTUnwrap(host.engine)

        try await waitUntil("pull started") { server.log.contains("GET /shelf") }
        XCTAssertNil(host.lastPull)
        let during = await engine.drain()
        XCTAssertEqual(during, .busy)

        try await waitUntil("pull finished") { host.lastPull != nil }
        XCTAssertEqual(count("GET /shelf", in: server), 1)

        host.sceneBecameActive()
        try await waitUntil("foreground pull") { self.count("GET /shelf", in: server) == 2 }
    }

    func testDrainPullsWaitForTheIntervalButTheForegroundAlwaysPulls() async throws {
        let server = try FakeSyncServer()
        let clock = TestClock()
        let host = makeHost(server, clock: clock)
        defer { host.switchTo(nil) }
        XCTAssertEqual(host.drainPullInterval, 30)

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let store = try XCTUnwrap(host.store)
        try await waitUntil("sign-in pull") { host.lastPull != nil }
        XCTAssertEqual(count("GET /shelf", in: server), 1)

        // A drain right after the pull: no second pull within the interval.
        let recipe = StoredRecipe(try recipeValues())
        try store.addRecipe(recipe)
        try await waitUntil("recipe sent") { recipe.syncState == .synced }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(count("GET /shelf", in: server), 1)

        // Later, the next idle slot runs the pull the drain left due.
        clock.advance(31)
        host.kick()
        try await waitUntil("drain pull after the interval") { self.count("GET /shelf", in: server) == 2 }

        // The foreground does not wait for the interval (the clock has not moved since).
        host.sceneBecameActive()
        try await waitUntil("foreground pull") { self.count("GET /shelf", in: server) == 3 }
    }

    func testAPullThatNeedsSignInStopsTheEngine() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in StubResponse(status: 401) }
        let host = makeHost(server, tokens: FakeTokenProvider(refreshFails: true))
        defer { host.switchTo(nil) }

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let engine = try XCTUnwrap(host.engine)

        try await waitUntil("sign-in required") { host.signInRequired }
        XCTAssertTrue(engine.needsSignIn)
        XCTAssertNil(host.lastPull)
    }
}
