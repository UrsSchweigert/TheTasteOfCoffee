import SwiftData
import XCTest
@testable import Cupmark

/// The shelf list and the shelf entry editor (M2-T18) on an in-memory store: adding after a
/// found bean, the rows, editing, removal, and the disabled bean change and removal while
/// brews reference the entry (D14, ADR 0012). No network: everything is local and queued.
@MainActor
final class ShelfModelTests: XCTestCase {
    private let otherBeanID = "01JD00000000000000000BEAN2"

    private func today() throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-25T10:00:00Z"))
    }

    private func calendar() throws -> Calendar {
        try StoreFixtures.calendar("Europe/Berlin")
    }

    private func editor(_ mode: ShelfEntryEditorModel.Mode, _ store: AccountStore) throws -> ShelfEntryEditorModel {
        let now = try today()
        return ShelfEntryEditorModel(mode: mode, store: store, now: { now }, calendar: try calendar())
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    /// A catalogue bean with only picked attributes and no Open Food Facts product.
    private func pickedBean(_ beanID: String) throws -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self)),
            operatorAttributes: API.BeanAttributes()
        )
    }

    @discardableResult
    private func addBrew(to entry: StoredShelfEntry, in store: AccountStore) throws -> StoredBrew {
        let brew = try StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    // MARK: - Adding (F1 step 5)

    func testAddingAfterAFoundBeanSavesTheEntryLocallyAndQueuesOnlyItsCreate() throws {
        let store = try AccountStore.inMemory()
        let bean = try StoreFixtures.bean()
        let model = try editor(.add(bean), store)
        XCTAssertTrue(model.isAdding)
        XCTAssertEqual(model.draft.purchaseDate, try StoreFixtures.day("2026-11-25"), "purchased today by default")
        XCTAssertEqual(model.bean.name, bean.openFoodFacts?.name)
        XCTAssertTrue(model.canSave)
        model.setHasRoastDate(true)
        model.draft.roastDate = try StoreFixtures.day("2026-11-10")
        model.draft.bagSize = try StoreFixtures.first(Vocabulary.BagSize.self)
        model.draft.priceBand = try StoreFixtures.last(Vocabulary.PriceBand.self)
        XCTAssertEqual(model.daysSinceRoast, 15)

        let localID = try XCTUnwrap(model.save())

        let entries = try store.shelfEntries()
        XCTAssertEqual(entries.map(\.localID), [localID])
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.syncState, .pendingCreate)
        XCTAssertEqual(entry.bean?.serverID, bean.beanId)
        XCTAssertEqual(entry.bean?.syncState, .synced, "the catalogue bean is a cached copy, never created again")
        XCTAssertEqual(try entry.apiInput(), model.draft.input(beanID: bean.beanId))
        XCTAssertEqual(try queue(store), ["create shelf_entry"])
        XCTAssertNil(model.failure)
    }

    func testAddingReusesTheCachedBeanInsteadOfASecondCopy() throws {
        let store = try AccountStore.inMemory()
        let existing = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try editor(.add(try StoreFixtures.bean()), store)

        XCTAssertNotNil(model.save())

        let cached = try XCTUnwrap(existing.bean)
        XCTAssertEqual(try store.beans().map(\.localID), [cached.localID])
        let entries = try store.shelfEntries()
        XCTAssertEqual(entries.count, 2)
        XCTAssertTrue(entries.allSatisfy { entry in entry.bean?.localID == cached.localID })
    }

    func testANewEntryHasNoBeanChangeAndNoRemoval() throws {
        let store = try AccountStore.inMemory()
        let model = try editor(.add(try pickedBean(otherBeanID)), store)
        XCTAssertFalse(model.canChangeBean)
        XCTAssertFalse(model.canDelete)
        XCTAssertFalse(model.delete())
        XCTAssertNil(model.bean.name)
        XCTAssertEqual(model.bean.attributes.map(\.field), [.process])
    }

    // MARK: - Disabled while brews reference the entry (D14, ADR 0012)

    func testWithABrewTheBeanChangeAndTheRemovalAreDisabledWithAReason() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(to: entry, in: store)
        let other = StoredBean(try pickedBean(otherBeanID))
        try store.addBean(other, syncState: .synced)

        let model = try editor(.edit(entry.localID), store)

        XCTAssertEqual(model.brewCount, 1)
        XCTAssertEqual(model.lockReason, .hasBrews)
        XCTAssertFalse(model.canChangeBean)
        XCTAssertFalse(model.canDelete)
        model.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))
        XCTAssertEqual(model.beanLocalID, entry.bean?.localID, "the choice is ignored")
        XCTAssertFalse(model.delete())
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(try queue(store), [])

        // The dates, the bag and the price still change.
        model.draft.bagSize = try StoreFixtures.last(Vocabulary.BagSize.self)
        XCTAssertTrue(model.canSave)
        XCTAssertNotNil(model.save())
        XCTAssertEqual(entry.bagSize, try StoreFixtures.last(Vocabulary.BagSize.self))
        XCTAssertEqual(entry.bean?.serverID, StoreFixtures.beanID)
        XCTAssertEqual(try queue(store), ["update shelf_entry"])
    }

    func testABeanChangeIsRefusedOnSaveIfABrewWasAddedMeanwhile() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let other = StoredBean(try pickedBean(otherBeanID))
        try store.addBean(other, syncState: .synced)
        let model = try editor(.edit(entry.localID), store)
        XCTAssertTrue(model.canChangeBean)
        model.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))

        try addBrew(to: entry, in: store)

        XCTAssertNil(model.save())
        XCTAssertEqual(model.failure, .hasBrews)
        XCTAssertEqual(entry.bean?.serverID, StoreFixtures.beanID)
        XCTAssertFalse(model.canChangeBean)
        XCTAssertEqual(try queue(store), [])
    }

    func testARemovalIsRefusedIfABrewWasAddedMeanwhile() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try editor(.edit(entry.localID), store)
        XCTAssertTrue(model.canDelete)

        try addBrew(to: entry, in: store)

        XCTAssertFalse(model.delete())
        XCTAssertEqual(model.failure, .hasBrews)
        XCTAssertEqual(model.brewCount, 1)
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
    }

    func testABrewRemovedOnTheDeviceDoesNotCount() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try addBrew(to: entry, in: store)
        try store.markDeleted(brew)
        XCTAssertEqual(brew.syncState, .pendingDelete)

        let model = try editor(.edit(entry.localID), store)

        XCTAssertEqual(model.brewCount, 0)
        XCTAssertNil(model.lockReason)
        XCTAssertTrue(model.canChangeBean)
        XCTAssertTrue(model.canDelete)
    }

    func testRefreshReadsANewBrewCount() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try editor(.edit(entry.localID), store)
        XCTAssertTrue(model.canDelete)
        try addBrew(to: entry, in: store)
        model.refresh()
        XCTAssertEqual(model.brewCount, 1)
        XCTAssertFalse(model.canDelete)
        XCTAssertFalse(model.canChangeBean)
    }

    // MARK: - Editing and removing without brews

    func testChangingTheBeanAndTheValuesQueuesOneUpdate() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let other = StoredBean(try pickedBean(otherBeanID))
        try store.addBean(other, syncState: .synced)
        let model = try editor(.edit(entry.localID), store)
        XCTAssertFalse(model.canSave, "nothing changed yet")
        XCTAssertEqual(Set(model.beanChoices().map(\.id)), Set([entry.bean?.localID, other.localID].compactMap { $0 }))

        model.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))
        model.setHasRoastDate(false)
        XCTAssertTrue(model.canSave)
        XCTAssertNotNil(model.save())

        XCTAssertEqual(entry.bean?.localID, other.localID)
        XCTAssertNil(entry.roastDate)
        XCTAssertEqual(entry.syncState, .pendingUpdate)
        XCTAssertEqual(try entry.apiInput(), model.draft.input(beanID: otherBeanID))
        XCTAssertEqual(try queue(store), ["update shelf_entry"])
        XCTAssertFalse(model.canSave, "saved")
    }

    func testRemovingAnEntryWithoutBrewsHidesItAndQueuesTheDelete() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try editor(.edit(entry.localID), store)

        XCTAssertTrue(model.delete())

        XCTAssertEqual(entry.syncState, .pendingDelete)
        XCTAssertTrue(try store.shelfEntries().isEmpty)
        XCTAssertEqual(try queue(store), ["delete shelf_entry"])
    }

    func testAnEntryThatIsGoneCannotBeEdited() throws {
        let store = try AccountStore.inMemory()
        let model = try editor(.edit(UUID()), store)
        XCTAssertEqual(model.failure, .notFound)
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.canChangeBean)
        XCTAssertFalse(model.canDelete)
        XCTAssertNil(model.save())
    }

    // MARK: - The list

    func testRowsShowTheBeanTheRoastDateDaysSinceRoastAndTheBrewCount() throws {
        let store = try AccountStore.inMemory()
        let named = try StoreFixtures.syncedShelfEntry(in: store, roastDate: "2026-11-18")
        try addBrew(to: named, in: store)
        let picked = StoredBean(try pickedBean(otherBeanID))
        try store.addBean(picked, syncState: .synced)
        let unroasted = StoredShelfEntry(API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: otherBeanID,
            purchaseDate: try StoreFixtures.day("2026-11-24")
        ))
        try store.addShelfEntry(unroasted, bean: picked)
        let now = try today()
        let model = ShelfModel(store: store, now: { now }, calendar: try calendar())

        model.reload()

        XCTAssertFalse(model.loadFailed)
        // Latest purchase first.
        XCTAssertEqual(model.rows.map(\.id), [unroasted.localID, named.localID])
        let first = try XCTUnwrap(model.rows.first)
        XCTAssertNil(first.bean.name)
        XCTAssertNil(first.bean.brand)
        XCTAssertFalse(first.bean.hasOpenFoodFactsText)
        XCTAssertEqual(first.bean.attributes.map(\.field), [.process])
        XCTAssertNil(first.roastDate)
        XCTAssertNil(first.daysSinceRoast)
        XCTAssertEqual(first.brewCount, 0)
        let second = try XCTUnwrap(model.rows.last)
        XCTAssertEqual(second.bean.name, "Bohne")
        XCTAssertEqual(second.bean.brand, "Röster")
        XCTAssertEqual(second.roastDate, try StoreFixtures.day("2026-11-18"))
        XCTAssertEqual(second.daysSinceRoast, 7)
        XCTAssertEqual(second.brewCount, 1)
        XCTAssertEqual(model.issueCount, 0)
    }

    func testRemovedEntriesAreHiddenAndFlaggedOnesCounted() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = ShelfModel(store: store)
        model.reload()
        XCTAssertEqual(model.rows.count, 1)

        entry.syncIssue = .deleteRestored
        try store.save()
        model.reload()
        XCTAssertEqual(model.rows.first?.issue, .deleteRestored)
        XCTAssertEqual(model.issueCount, 1)

        try store.markDeleted(entry)
        model.reload()
        XCTAssertEqual(model.rows, [])
    }

    func testOpenFoodFactsTextThatIsOnlyWhiteSpaceFallsBackToTheAttributes() {
        let summary = ShelfBeanSummary(name: "  ", brand: "\n", attributes: [])
        XCTAssertNil(summary.name)
        XCTAssertNil(summary.brand)
        XCTAssertFalse(summary.hasOpenFoodFactsText)
    }

    func testEverySaveOfTheStorePostsItsNotification() throws {
        let store = try AccountStore.inMemory()
        let saved = expectation(forNotification: AccountStore.didSaveNotification, object: store)
        // One save for the bean, one for the entry.
        saved.expectedFulfillmentCount = 2
        saved.assertForOverFulfill = true
        _ = try StoreFixtures.syncedShelfEntry(in: store)
        wait(for: [saved], timeout: 1)
    }
}
