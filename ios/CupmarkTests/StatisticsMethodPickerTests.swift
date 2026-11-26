import Foundation
import XCTest
@testable import Cupmark

/// The method picker of the statistics (M2-T50, ADR 0027 addendum): the numbers of one method
/// come from `PersonalStatistics.compute` with a method filter, "all" equals the unfiltered
/// output, a method below the threshold has an empty taste profile, the picker offers only
/// methods with rated brews, and the choice is kept as one method id or "all" and falls back
/// to "all". Vocabulary values come from the generated enums, never a typed list.
@MainActor
final class StatisticsMethodPickerTests: XCTestCase {
    private let suiteName = "cupmark-tests-statistics-method"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Fixtures

    private func defaults() -> UserDefaults {
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            preconditionFailure("The test suite of UserDefaults could not be made.")
        }
        return defaults
    }

    private func date(_ text: String) throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: text), "not a date: \(text)")
    }

    private func calendar() throws -> Calendar {
        PersonalStatistics.isoWeekCalendar(timeZone: try XCTUnwrap(TimeZone(identifier: "Europe/Berlin")))
    }

    private func method(_ index: Int) throws -> Vocabulary.Method {
        let methods = Vocabulary.Method.allCases
        XCTAssertGreaterThan(methods.count, index, "the vocabulary has too few methods for this test")
        return try XCTUnwrap(methods.indices.contains(index) ? methods[index] : nil)
    }

    private func rating(_ score: Double, buyAgain: Bool? = nil) -> RatingValues {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = score
        }
        return RatingValues(scores: scores, flavourNotes: nil, buyAgain: buyAgain)
    }

    private func brew(
        _ method: Vocabulary.Method?,
        score: Double? = nil,
        buyAgain: Bool? = nil,
        removed: Bool = false
    ) throws -> StatisticsBrew {
        StatisticsBrew(
            brewedAt: try date("2026-11-25T08:00:00Z"),
            method: method,
            bean: nil,
            rating: score.map { value in rating(value, buyAgain: buyAgain) },
            isRemoved: removed
        )
    }

    private func compute(_ brews: [StatisticsBrew], method: Vocabulary.Method?) throws -> PersonalStatistics {
        PersonalStatistics.compute(brews, now: try date("2026-11-26T12:00:00Z"), calendar: try calendar(), method: method)
    }

    // MARK: - The filter

    func testAllMethodsEqualsTheUnfilteredOutput() throws {
        let first = try method(0)
        let second = try method(1)
        let brews = [
            try brew(first, score: 8, buyAgain: true),
            try brew(first, score: 6, buyAgain: false),
            try brew(second, score: 4),
            try brew(second),
            try brew(nil, score: 9),
        ]
        let now = try date("2026-11-26T12:00:00Z")
        XCTAssertEqual(try compute(brews, method: nil), PersonalStatistics.compute(brews, now: now, calendar: try calendar()))
    }

    func testEachMethodShowsTheNumbersOfItsOwnBrewsOnly() throws {
        let first = try method(0)
        let second = try method(1)
        let brews = [
            try brew(first, score: 8, buyAgain: true),
            try brew(first, score: 6, buyAgain: false),
            try brew(first),
            try brew(second, score: 4, buyAgain: true),
            try brew(second, score: 2, buyAgain: true),
        ]
        let onlyFirst = try compute(brews, method: first)
        XCTAssertEqual(onlyFirst.totalBrews, 3)
        XCTAssertEqual(onlyFirst.ratedBrews, 2)
        XCTAssertEqual(onlyFirst.buyAgain, BuyAgainShare(yes: 1, answered: 2))
        XCTAssertEqual(onlyFirst.tasteProfile.first?.mean, 7)

        let onlySecond = try compute(brews, method: second)
        XCTAssertEqual(onlySecond.totalBrews, 2)
        XCTAssertEqual(onlySecond.ratedBrews, 2)
        XCTAssertEqual(onlySecond.buyAgain, BuyAgainShare(yes: 2, answered: 2))
        XCTAssertEqual(onlySecond.tasteProfile.first?.mean, 3)
    }

    func testTheTasteProfileOfAMethodIsTheMethodProfileOfTheUnfilteredOutput() throws {
        let first = try method(0)
        let brews = [try brew(first, score: 8), try brew(first, score: 6), try brew(try method(1), score: 1)]
        let all = try compute(brews, method: nil)
        let profile = try XCTUnwrap(all.methodProfiles.first { entry in entry.method == first })
        XCTAssertEqual(try compute(brews, method: first).tasteProfile, profile.means)
    }

    func testAMethodBelowTheThresholdHasNoTasteProfileNotZeros() throws {
        let first = try method(0)
        let statistics = try compute([try brew(first, score: 8)], method: first)
        XCTAssertEqual(statistics.ratedBrews, StatisticsRules.minimumRatedBrews - 1)
        XCTAssertFalse(StatisticsRules.hasEnoughRatedBrews(statistics.ratedBrews))
        XCTAssertTrue(statistics.tasteProfile.isEmpty)
        XCTAssertTrue(StatisticsRules.hasEnoughRatedBrews(StatisticsRules.minimumRatedBrews))
    }

    func testAMethodWithoutRatedBrewsHasEmptyNumbers() throws {
        let first = try method(0)
        let second = try method(1)
        let statistics = try compute([try brew(first, score: 8), try brew(first, score: 6)], method: second)
        XCTAssertEqual(statistics.totalBrews, 0)
        XCTAssertEqual(statistics.ratedBrews, 0)
        XCTAssertFalse(statistics.hasRatedBrews)
        XCTAssertTrue(statistics.tasteProfile.isEmpty)
        XCTAssertTrue(statistics.topFlavourNotes.isEmpty)
        XCTAssertNil(statistics.buyAgain)
        XCTAssertNil(statistics.bestBean)
    }

    func testARemovedBrewCountsInNoMethod() throws {
        let first = try method(0)
        let brews = [try brew(first, score: 8), try brew(first, score: 6, removed: true)]
        let statistics = try compute(brews, method: first)
        XCTAssertEqual(statistics.totalBrews, 1)
        XCTAssertEqual(statistics.ratedBrews, 1)
        let onlyRemoved = [try brew(first, score: 6, removed: true)]
        XCTAssertEqual(PersonalStatistics.ratedMethods(in: onlyRemoved), [])
    }

    // MARK: - What the picker offers

    func testThePickerOffersTheMethodsWithRatedBrewsInVocabularyOrder() throws {
        let first = try method(0)
        let second = try method(1)
        let third = try method(2)
        let brews = [
            try brew(third, score: 5),
            try brew(first, score: 5),
            try brew(second),
            try brew(nil, score: 5),
        ]
        XCTAssertEqual(PersonalStatistics.ratedMethods(in: brews), [first, third], "second is unrated, nil is unknown")
        XCTAssertEqual(PersonalStatistics.ratedMethods(in: []), [])
    }

    // MARK: - The kept choice

    func testTheChoiceIsKeptAsOneMethodIdOrAll() throws {
        XCTAssertEqual(StatisticsMethodChoice.all.storageValue, "all")
        let first = try method(0)
        XCTAssertEqual(StatisticsMethodChoice.method(first).storageValue, first.rawValue)
        XCTAssertNil(StatisticsMethodChoice.all.method)
        XCTAssertEqual(StatisticsMethodChoice.method(first).method, first)
        XCTAssertFalse(Vocabulary.Method.allCases.map(\.rawValue).contains(StatisticsMethodChoice.allStorageValue), "'all' is no method id")
    }

    func testAKeptChoiceIsRestoredAndAnythingElseFallsBackToAll() throws {
        let first = try method(0)
        let second = try method(1)
        XCTAssertEqual(StatisticsMethodChoice.resolve(first.rawValue, offering: [first, second]), .method(first))
        XCTAssertEqual(StatisticsMethodChoice.resolve("all", offering: [first]), .all)
        XCTAssertEqual(StatisticsMethodChoice.resolve(nil, offering: [first]), .all)
        XCTAssertEqual(StatisticsMethodChoice.resolve("no-such-method", offering: [first]), .all, "an unknown id")
        XCTAssertEqual(StatisticsMethodChoice.resolve(second.rawValue, offering: [first]), .all, "no longer present")
    }

    // MARK: - The model

    private func storeWithOneRatedBrew() throws -> AccountStore {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return store
    }

    func testThePickedChoiceIsKeptAcrossModelsAndFiltersTheNumbers() throws {
        let store = try storeWithOneRatedBrew()
        let setting = StatisticsMethodSetting(defaults: defaults())
        let model = StatisticsModel(store: store, setting: setting)
        model.reload()
        XCTAssertEqual(model.choice, .all, "nothing kept yet")
        let offered = try XCTUnwrap(model.availableMethods.first, "the fixture brew is rated")
        let reads = model.reloadCount

        model.select(.method(offered))
        XCTAssertEqual(model.choice, .method(offered))
        XCTAssertEqual(model.reloadCount, reads, "a new choice reads no store")
        XCTAssertEqual(model.statistics?.totalBrews, 1)
        XCTAssertEqual(setting.storedValue, offered.rawValue)

        let reopened = StatisticsModel(store: store, setting: StatisticsMethodSetting(defaults: defaults()))
        reopened.reload()
        XCTAssertEqual(reopened.choice, .method(offered), "kept across launches")

        reopened.select(.all)
        XCTAssertEqual(setting.storedValue, "all")
        XCTAssertEqual(reopened.choice, .all)
    }

    func testAKeptMethodThatIsUnknownOrNoLongerPresentFallsBackToAll() throws {
        let store = try storeWithOneRatedBrew()
        let setting = StatisticsMethodSetting(defaults: defaults())
        let probe = StatisticsModel(store: store, setting: setting)
        probe.reload()
        let present = try XCTUnwrap(probe.availableMethods.first)
        let absent = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method != present })

        setting.storedValue = absent.rawValue
        let missing = StatisticsModel(store: store, setting: setting)
        missing.reload()
        XCTAssertEqual(missing.choice, .all, "a method without rated brews")
        XCTAssertEqual(missing.statistics?.totalBrews, 1, "the numbers are those of all methods")

        setting.storedValue = "no-such-method"
        let unknown = StatisticsModel(store: store, setting: setting)
        unknown.reload()
        XCTAssertEqual(unknown.choice, .all, "an id of no vocabulary")
    }

    func testARemovedBrewLeavesThePickerAndFallsBackToAll() throws {
        let store = try storeWithOneRatedBrew()
        let setting = StatisticsMethodSetting(defaults: defaults())
        let model = StatisticsModel(store: store, setting: setting)
        model.reload()
        let offered = try XCTUnwrap(model.availableMethods.first)
        model.select(.method(offered))

        let brews = try store.brewsNewestFirst()
        let stored = try XCTUnwrap(brews.first)
        try store.markDeleted(stored)
        model.reload()

        XCTAssertTrue(model.availableMethods.isEmpty)
        XCTAssertEqual(model.choice, .all)
        XCTAssertEqual(model.statistics?.totalBrews, 0)
    }

    func testABrewOfAnOlderVocabularyAndARatingOfUnknownCriteriaCountInThePicker() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        // A rating recorded under an earlier vocabulary version.
        var olderInput = try StoreFixtures.brewInput(brewedAt: "2026-11-24T08:00:00.000Z")
        olderInput.vocabularyVersion = Vocabulary.version - 1
        let older = try StoredBrew(olderInput, serverID: StoreFixtures.brewID)
        try store.addBrew(older, shelfEntry: entry, syncState: .synced)
        // A rating that scores only criteria this build does not know.
        let unknown = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z"), serverID: StoreFixtures.brewID)
        try unknown.setRating(RatingValues(scores: ["criterion-of-a-newer-vocabulary": 5]))
        try store.addBrew(unknown, shelfEntry: entry, syncState: .synced)

        let values = StatisticsBrew.values(of: try store.brewsNewestFirst())
        let offered = PersonalStatistics.ratedMethods(in: values)
        XCTAssertEqual(offered.count, 1, "both brews are rated and have the same method")
        let method = try XCTUnwrap(offered.first)

        let statistics = PersonalStatistics.compute(
            values,
            now: try date("2026-11-26T12:00:00Z"),
            calendar: try calendar(),
            method: method
        )
        XCTAssertEqual(statistics.ratedBrews, 2, "the unknown-criteria rating is a rated brew")
        XCTAssertFalse(statistics.tasteProfile.isEmpty, "the older rating is read")
        XCTAssertTrue(statistics.tasteProfile.allSatisfy { mean in mean.count == 1 }, "only the older rating scores a known criterion")
    }
}
