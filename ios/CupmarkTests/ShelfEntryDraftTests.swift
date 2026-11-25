import XCTest
@testable import Cupmark

/// The shelf entry draft (M2-T18): the mapping to `ShelfEntryInput`, the dates of the pickers,
/// days since roast on the shelf, and unknown ids kept.
final class ShelfEntryDraftTests: XCTestCase {
    private let beanID = StoreFixtures.beanID

    // MARK: - Mapping to ShelfEntryInput

    func testAFullDraftMapsToEveryPropertyWithTheBundledVersion() throws {
        let draft = ShelfEntryDraft(
            purchaseDate: try StoreFixtures.day("2026-11-20"),
            roastDate: try StoreFixtures.day("2026-11-12"),
            bagSize: try StoreFixtures.last(Vocabulary.BagSize.self),
            priceBand: try StoreFixtures.first(Vocabulary.PriceBand.self)
        )

        let input = try XCTUnwrap(draft.input(beanID: beanID))

        XCTAssertEqual(input, API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: beanID,
            purchaseDate: try StoreFixtures.day("2026-11-20"),
            roastDate: try StoreFixtures.day("2026-11-12"),
            bagSize: try StoreFixtures.last(Vocabulary.BagSize.self),
            priceBand: try StoreFixtures.first(Vocabulary.PriceBand.self)
        ))
        // On the wire: exactly the contract's properties, ids as the vocabulary has them.
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), API.ShelfEntryInput.propertyNames)
        XCTAssertEqual(object["purchase_date"] as? String, "2026-11-20")
        XCTAssertEqual(object["roast_date"] as? String, "2026-11-12")
        XCTAssertEqual(object["bag_size"] as? String, try StoreFixtures.last(Vocabulary.BagSize.self).rawValue)
        XCTAssertEqual(object["price_band"] as? String, try StoreFixtures.first(Vocabulary.PriceBand.self).rawValue)
        XCTAssertEqual(object["vocabulary_version"] as? Int, Vocabulary.version)
        XCTAssertEqual(object["bean_id"] as? String, beanID)
    }

    func testANewDraftIsBoughtTodayWithNothingElseAndSendsOnlyTheRequiredProperties() throws {
        let calendar = try StoreFixtures.calendar("Europe/Berlin")
        // 23:30 UTC on 24 November is already 25 November in Berlin: the device's day counts.
        let lateEvening = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-24T23:30:00Z"))
        let draft = ShelfEntryDraft.new(today: lateEvening, calendar: calendar)

        XCTAssertEqual(draft.purchaseDate, try StoreFixtures.day("2026-11-25"))
        XCTAssertNil(draft.roastDate)
        XCTAssertNil(draft.bagSize)
        XCTAssertNil(draft.priceBand)
        let input = try XCTUnwrap(draft.input(beanID: beanID))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["vocabulary_version", "bean_id", "purchase_date"])
    }

    func testADraftWithoutAPurchaseDateIsIncompleteAndMapsToNothing() {
        let draft = ShelfEntryDraft(purchaseDate: nil)
        XCTAssertFalse(draft.isComplete)
        XCTAssertNil(draft.input(beanID: beanID))
    }

    func testApplyingTheDraftMakesTheStoredEntrySendTheSameInput() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        var draft = ShelfEntryDraft(entry)
        XCTAssertEqual(draft.input(beanID: beanID), try entry.apiInput())

        draft.purchaseDate = try StoreFixtures.day("2026-11-22")
        draft.roastDate = nil
        draft.bagSize = try StoreFixtures.last(Vocabulary.BagSize.self)
        draft.priceBand = nil
        draft.apply(to: entry)

        XCTAssertEqual(try entry.apiInput(), draft.input(beanID: beanID))
        XCTAssertNil(entry.roastDateRaw)
        XCTAssertNil(entry.priceBandID)
    }

    func testAnUnknownStoredIdIsKeptUnlessTheUserPicksAValue() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        entry.bagSizeID = "a_size_from_a_newer_vocabulary"
        entry.vocabularyVersion = Vocabulary.version + 1

        var draft = ShelfEntryDraft(entry)
        XCTAssertNil(draft.bagSize)
        XCTAssertTrue(draft.keepsUnknownIDs)
        draft.roastDate = nil
        draft.apply(to: entry)
        XCTAssertEqual(entry.bagSizeID, "a_size_from_a_newer_vocabulary")
        XCTAssertEqual(entry.vocabularyVersion, Vocabulary.version + 1)

        draft.bagSize = try StoreFixtures.first(Vocabulary.BagSize.self)
        XCTAssertFalse(draft.keepsUnknownIDs)
        draft.apply(to: entry)
        XCTAssertEqual(entry.bagSizeID, try StoreFixtures.first(Vocabulary.BagSize.self).rawValue)
        XCTAssertEqual(entry.vocabularyVersion, Vocabulary.version)
    }

    func testTheRoastDateToggleStartsAtThePurchaseDateAndClears() throws {
        var draft = ShelfEntryDraft(purchaseDate: try StoreFixtures.day("2026-11-20"))
        draft.setHasRoastDate(true)
        XCTAssertEqual(draft.roastDate, try StoreFixtures.day("2026-11-20"))
        draft.roastDate = try StoreFixtures.day("2026-11-10")
        draft.setHasRoastDate(true)
        XCTAssertEqual(draft.roastDate, try StoreFixtures.day("2026-11-10"), "turning it on again keeps the date")
        draft.setHasRoastDate(false)
        XCTAssertNil(draft.roastDate)
    }

    // MARK: - Picker dates

    func testAPickerDateAndItsDayRoundTripInEveryTimeZone() throws {
        for zone in ["Europe/Berlin", "Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"] {
            let calendar = try StoreFixtures.calendar(zone)
            for text in ["2026-03-29", "2026-10-25", "2024-02-29", "2026-12-31"] {
                let day = try StoreFixtures.day(text)
                let date = try XCTUnwrap(ShelfDates.date(of: day, calendar: calendar), "\(zone) \(text)")
                XCTAssertEqual(ShelfDates.day(of: date, calendar: calendar), day, "\(zone) \(text)")
            }
        }
    }

    // MARK: - Days since roast on the shelf

    func testDaysSinceRoastCountsCalendarDaysToToday() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store, roastDate: "2026-11-18")
        let calendar = try StoreFixtures.calendar("Europe/Berlin")

        let roastDay = try XCTUnwrap(ShelfDates.date(of: try StoreFixtures.day("2026-11-18"), calendar: calendar))
        XCTAssertEqual(entry.daysSinceRoast(on: roastDay, calendar: calendar), 0)
        let aWeekLater = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-25T07:00:00Z"))
        XCTAssertEqual(entry.daysSinceRoast(on: aWeekLater, calendar: calendar), 7)
        // Just after midnight in Berlin is already the next day there.
        let afterMidnight = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-25T23:30:00Z"))
        XCTAssertEqual(entry.daysSinceRoast(on: afterMidnight, calendar: calendar), 8)
        // Across the end of daylight saving time (25 October 2026 in Berlin).
        // The store is kept in a local, so its models stay readable.
        let otherStore = try AccountStore.inMemory()
        let october = try StoreFixtures.syncedShelfEntry(in: otherStore, roastDate: "2026-10-24")
        let afterChange = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-26T10:00:00Z"))
        XCTAssertEqual(october.daysSinceRoast(on: afterChange, calendar: calendar), 2)
    }

    func testDaysSinceRoastIsNilWithoutARoastDateOrBeforeIt() throws {
        let store = try AccountStore.inMemory()
        let calendar = try StoreFixtures.calendar("Europe/Berlin")
        let today = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-25T10:00:00Z"))
        let unknown = try StoreFixtures.syncedShelfEntry(in: store, roastDate: nil)
        XCTAssertNil(unknown.daysSinceRoast(on: today, calendar: calendar))
        let otherStore = try AccountStore.inMemory()
        let future = try StoreFixtures.syncedShelfEntry(in: otherStore, roastDate: "2026-11-26")
        XCTAssertNil(future.daysSinceRoast(on: today, calendar: calendar))
    }
}
