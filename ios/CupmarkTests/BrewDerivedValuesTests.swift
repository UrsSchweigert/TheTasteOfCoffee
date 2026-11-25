import XCTest
@testable import Cupmark

/// Ratio and days since roast (docs/04 F2), computed only in `BrewDerivedValues`.
final class BrewDerivedValuesTests: XCTestCase {
    // MARK: - Ratio

    func testRatioIsWaterOverDoseInGrams() throws {
        // 300 g of water on 18.0 g of coffee (180 dg, ADR 0004).
        let ratio = try XCTUnwrap(BrewDerivedValues.ratio(doseDg: 180, waterG: 300))
        XCTAssertEqual(ratio, 300.0 / 18.0, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(BrewDerivedValues.ratio(doseDg: 50, waterG: 1000)), 200, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(BrewDerivedValues.ratio(doseDg: 185, waterG: 37)), 2, accuracy: 1e-12)
    }

    func testRatioNeedsBothValuesAndAPositiveDose() {
        XCTAssertNil(BrewDerivedValues.ratio(doseDg: nil, waterG: 300))
        XCTAssertNil(BrewDerivedValues.ratio(doseDg: 180, waterG: nil))
        XCTAssertNil(BrewDerivedValues.ratio(doseDg: 0, waterG: 300))
        XCTAssertNil(BrewDerivedValues.ratio(doseDg: -10, waterG: 300))
    }

    func testBrewsAndRecipesUseTheSameRatio() throws {
        let input = try StoreFixtures.brewInput()
        let brew = try StoredBrew(input)
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: input.parameters))
        let expected = BrewDerivedValues.ratio(doseDg: input.parameters.doseDg, waterG: input.parameters.waterG)
        XCTAssertNotNil(expected)
        XCTAssertEqual(brew.ratio, expected)
        XCTAssertEqual(recipe.ratio, expected)
        brew.doseDg = nil
        XCTAssertNil(brew.ratio)
    }

    // MARK: - Days since roast

    func testDaysSinceRoastCountsCalendarDays() throws {
        let utc = try StoreFixtures.calendar("UTC")
        let roast = try StoreFixtures.day("2026-11-20")
        let sameDay = try StoreFixtures.timestamp("2026-11-20T23:59:59.999Z").date
        let nextDay = try StoreFixtures.timestamp("2026-11-21T00:00:00.000Z").date
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: sameDay, calendar: utc), 0)
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: nextDay, calendar: utc), 1)
    }

    func testDaysSinceRoastAcrossMonthYearAndLeapDay() throws {
        let utc = try StoreFixtures.calendar("UTC")
        let leap = try StoreFixtures.timestamp("2024-03-01T12:00:00Z").date
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: try StoreFixtures.day("2024-02-28"), brewedAt: leap, calendar: utc), 2)
        let newYear = try StoreFixtures.timestamp("2027-01-02T12:00:00Z").date
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: try StoreFixtures.day("2026-12-30"), brewedAt: newYear, calendar: utc), 3)
    }

    func testDaysSinceRoastFollowsTheDeviceTimeZoneWhenItChanges() throws {
        // 00:30 in Berlin on 25 November is still 24 November in New York and Los Angeles.
        let roast = try StoreFixtures.day("2026-11-20")
        let brewedAt = try StoreFixtures.timestamp("2026-11-25T00:30:00+01:00").date
        let berlin = try StoreFixtures.calendar("Europe/Berlin")
        let newYork = try StoreFixtures.calendar("America/New_York")
        let tokyo = try StoreFixtures.calendar("Asia/Tokyo")
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: brewedAt, calendar: berlin), 5)
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: brewedAt, calendar: newYork), 4)
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: brewedAt, calendar: tokyo), 5)
    }

    func testDaysSinceRoastIsNotShiftedByADaylightSavingChange() throws {
        // Berlin moves to summer time on 29 March 2026: the two days hold only 47 hours,
        // and 47.5 hours lie between the roast day's midnight and the brew. Still two days.
        let berlin = try StoreFixtures.calendar("Europe/Berlin")
        let roast = try StoreFixtures.day("2026-03-28")
        let brewedAt = try StoreFixtures.timestamp("2026-03-30T00:30:00+02:00").date
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: roast, brewedAt: brewedAt, calendar: berlin), 2)
        // And back to winter time on 25 October 2026.
        let autumnRoast = try StoreFixtures.day("2026-10-24")
        let autumnBrew = try StoreFixtures.timestamp("2026-10-26T23:30:00+01:00").date
        XCTAssertEqual(BrewDerivedValues.daysSinceRoast(roastDate: autumnRoast, brewedAt: autumnBrew, calendar: berlin), 2)
    }

    func testDaysSinceRoastIsNilWithoutARoastDateOrForARoastAfterTheBrew() throws {
        let utc = try StoreFixtures.calendar("UTC")
        let brewedAt = try StoreFixtures.timestamp("2026-11-25T08:00:00Z").date
        XCTAssertNil(BrewDerivedValues.daysSinceRoast(roastDate: nil, brewedAt: brewedAt, calendar: utc))
        XCTAssertNil(BrewDerivedValues.daysSinceRoast(roastDate: try StoreFixtures.day("2026-11-26"), brewedAt: brewedAt, calendar: utc))
    }

    func testDayNumberMatchesTheUnixEpoch() throws {
        XCTAssertEqual(BrewDerivedValues.dayNumber(try StoreFixtures.day("1970-01-01")), 0)
        XCTAssertEqual(BrewDerivedValues.dayNumber(try StoreFixtures.day("2000-03-01")), 11_017)
        XCTAssertEqual(BrewDerivedValues.dayNumber(try StoreFixtures.day("2026-11-25")), 20_782)
        XCTAssertEqual(BrewDerivedValues.dayNumber(try StoreFixtures.day("1969-12-31")), -1)
    }

    func testAStoredBrewReadsItsShelfEntrysRoastDate() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store, roastDate: "2026-11-20")
        let brew = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-24T23:30:00Z"))
        try store.addBrew(brew, shelfEntry: entry)

        // The device travels from Berlin to New York: the stored instant stays, the count
        // follows the calendar the device has now.
        XCTAssertEqual(brew.daysSinceRoast(calendar: try StoreFixtures.calendar("Europe/Berlin")), 5)
        XCTAssertEqual(brew.daysSinceRoast(calendar: try StoreFixtures.calendar("America/New_York")), 4)
        XCTAssertEqual(brew.brewedAtMilliseconds, try StoreFixtures.timestamp("2026-11-24T23:30:00Z").millisecondsSince1970)

        entry.roastDate = nil
        XCTAssertNil(brew.daysSinceRoast(calendar: try StoreFixtures.calendar("UTC")))
    }
}
