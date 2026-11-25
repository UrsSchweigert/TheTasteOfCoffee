import SwiftData
import XCTest
@testable import Cupmark

/// The local store on an in-memory container: schema version, create, update, delete,
/// order and sync state (M2-T15).
final class AccountStoreTests: XCTestCase {
    // MARK: - Schema

    func testTheSchemaStartsAtVersion1AndThePlanHasNoStagesYet() {
        XCTAssertEqual(CupmarkSchemaV1.versionIdentifier, Schema.Version(1, 0, 0))
        XCTAssertEqual(CupmarkMigrationPlan.schemas.count, 1)
        XCTAssertTrue(CupmarkMigrationPlan.schemas.first == CupmarkSchemaV1.self)
        XCTAssertTrue(CupmarkMigrationPlan.stages.isEmpty)
        let names = Set(CupmarkSchemaV1.models.map { model in String(describing: model) })
        XCTAssertEqual(names, ["StoredBean", "StoredShelfEntry", "StoredBrew", "StoredRecipe", "StoredProfile"])
    }

    // MARK: - Create

    func testCreatingABeanAShelfEntryAndABrewLinksThemAndMarksThemPending() throws {
        let store = try AccountStore.inMemory()
        let bean = StoredBean(API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: "4006381333931",
            attributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self))
        ))
        try store.addBean(bean)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try store.addShelfEntry(entry, bean: bean)
        let brew = StoredBrew(try StoreFixtures.brewInput())
        try store.addBrew(brew, shelfEntry: entry)

        let brews = try store.brewsNewestFirst()
        XCTAssertEqual(brews.map(\.localID), [brew.localID])
        let stored = try XCTUnwrap(brews.first)
        XCTAssertEqual(stored.syncState, .pendingCreate)
        XCTAssertEqual(stored.syncStateRaw, "pending_create")
        XCTAssertNil(stored.serverID)
        XCTAssertEqual(stored.vocabularyVersion, Vocabulary.version)
        XCTAssertEqual(stored.shelfEntry?.localID, entry.localID)
        XCTAssertEqual(stored.shelfEntry?.bean?.localID, bean.localID)
        XCTAssertEqual(entry.brews.map(\.localID), [brew.localID])
        XCTAssertEqual(bean.shelfEntries.map(\.localID), [entry.localID])
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(try store.bean(barcode: "4006381333931")?.localID, bean.localID)
        XCTAssertNil(try store.bean(barcode: "0000000000000"))
    }

    func testItemsReadFromTheServerAreSynced() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(entry.serverID, StoreFixtures.shelfEntryID)
        XCTAssertEqual(try store.bean(serverID: StoreFixtures.beanID)?.syncState, .synced)
    }

    // MARK: - Update

    func testEditingASyncedItemMakesItAPendingUpdate() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)

        brew.waterG = 320
        try store.markUpdated(brew)

        let stored = try XCTUnwrap(try store.brewsNewestFirst().first)
        XCTAssertEqual(stored.waterG, 320)
        XCTAssertEqual(stored.syncState, .pendingUpdate)
        XCTAssertEqual(stored.serverID, StoreFixtures.brewID)
    }

    func testEditingAnItemTheServerNeverHadKeepsItACreate() throws {
        let store = try AccountStore.inMemory()
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters()))
        try store.addRecipe(recipe)

        recipe.doseDg = 200
        try store.markUpdated(recipe)

        XCTAssertEqual(try store.recipes().first?.doseDg, 200)
        XCTAssertEqual(recipe.syncState, .pendingCreate)
    }

    // MARK: - Delete

    func testDeletingAnItemTheServerNeverHadRemovesIt() throws {
        let store = try AccountStore.inMemory()
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters()))
        try store.addRecipe(recipe)

        try store.markDeleted(recipe)

        XCTAssertTrue(try store.recipes().isEmpty)
        XCTAssertTrue(try store.context.fetch(FetchDescriptor<StoredRecipe>()).isEmpty)
    }

    func testDeletingASyncedItemKeepsItAsAPendingDeleteAndHidesIt() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)

        try store.markDeleted(brew)

        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
        XCTAssertTrue(entry.liveBrewsNewestFirst.isEmpty)
        let all = try store.context.fetch(FetchDescriptor<StoredBrew>())
        XCTAssertEqual(all.map(\.syncState), [.pendingDelete])
        XCTAssertEqual(all.first?.serverID, StoreFixtures.brewID)
    }

    func testAShelfEntryWithBrewsCannotBeDeleted() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)

        XCTAssertThrowsError(try store.markDeleted(entry)) { error in
            XCTAssertEqual(error as? LocalStoreError, .shelfEntryHasBrews)
        }
        XCTAssertEqual(entry.syncState, .synced)

        try store.markDeleted(brew)
        try store.markDeleted(entry)
        XCTAssertTrue(try store.shelfEntries().isEmpty)
        XCTAssertEqual(entry.syncState, .pendingDelete)
    }

    // MARK: - Order

    func testBrewsComeNewestFirst() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let times = [
            "2026-11-24T07:00:00.000Z",
            "2026-11-25T07:00:00.001Z",
            "2026-11-23T21:00:00.000Z",
            "2026-11-25T07:00:00.000Z",
        ]
        for time in times {
            try store.addBrew(StoredBrew(try StoreFixtures.brewInput(brewedAt: time)), shelfEntry: entry)
        }

        let order = try store.brewsNewestFirst().map(\.brewedAtMilliseconds)
        let expected = try times.map { time in try StoreFixtures.timestamp(time).millisecondsSince1970 }.sorted(by: >)
        XCTAssertEqual(order, expected)
        XCTAssertEqual(entry.liveBrewsNewestFirst.map(\.brewedAtMilliseconds), expected)
    }

    func testShelfEntriesComeLatestPurchaseFirst() throws {
        let store = try AccountStore.inMemory()
        let bean = StoredBean(try StoreFixtures.bean())
        try store.addBean(bean, syncState: .synced)
        for day in ["2026-10-01", "2026-11-20", "2025-12-31"] {
            var input = try StoreFixtures.shelfEntryInput()
            input.purchaseDate = try StoreFixtures.day(day)
            try store.addShelfEntry(StoredShelfEntry(input), bean: bean)
        }
        XCTAssertEqual(try store.shelfEntries().map(\.purchaseDateRaw), ["2026-11-20", "2026-10-01", "2025-12-31"])
    }

    // MARK: - Profile

    func testTheProfileIsOnePerStore() throws {
        let store = try AccountStore.inMemory()
        XCTAssertNil(try store.profile())
        let language = try XCTUnwrap(VocabularyLanguage.allCases.first)

        let created = try store.setProfile(API.Profile(locale: language, consent: API.Consent(contributeToAggregates: false)))
        XCTAssertEqual(created.syncState, .pendingCreate)
        created.syncState = .synced
        try store.save()

        let edited = try store.setProfile(API.Profile(locale: language, consent: API.Consent(contributeToAggregates: true)))
        XCTAssertEqual(edited.localID, created.localID)
        XCTAssertEqual(edited.syncState, .pendingUpdate)
        XCTAssertTrue(edited.contributeToAggregates)
        XCTAssertEqual(try store.context.fetch(FetchDescriptor<StoredProfile>()).count, 1)
    }

    // MARK: - Isolation

    func testTwoInMemoryStoresShareNothing() throws {
        let first = try AccountStore.inMemory()
        let second = try AccountStore.inMemory()
        try first.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
        XCTAssertEqual(try first.recipes().count, 1)
        XCTAssertTrue(try second.recipes().isEmpty)
    }

    // MARK: - Sync state

    func testSyncStateTransitions() {
        XCTAssertEqual(SyncState.synced.afterLocalEdit, .pendingUpdate)
        XCTAssertEqual(SyncState.pendingUpdate.afterLocalEdit, .pendingUpdate)
        XCTAssertEqual(SyncState.pendingCreate.afterLocalEdit, .pendingCreate)
        XCTAssertEqual(SyncState.pendingDelete.afterLocalEdit, .pendingDelete)
        XCTAssertEqual(SyncState.pendingCreate.localDelete, .removeNow)
        XCTAssertEqual(SyncState.synced.localDelete, .markPendingDelete)
        XCTAssertEqual(SyncState.pendingUpdate.localDelete, .markPendingDelete)
        XCTAssertEqual(SyncState.pendingDelete.localDelete, .markPendingDelete)
    }

    func testSyncStateIsStoredAsItsRawValue() {
        let recipe = StoredRecipe(methodID: "anything")
        for state in SyncState.allCases {
            recipe.syncState = state
            XCTAssertEqual(recipe.syncStateRaw, state.rawValue)
            XCTAssertEqual(recipe.syncState, state)
        }
        recipe.syncStateRaw = "garbage"
        XCTAssertEqual(recipe.syncState, .pendingUpdate)
    }
}
