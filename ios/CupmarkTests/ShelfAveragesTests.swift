import Foundation
import XCTest
@testable import Cupmark

/// The averages on the shelf list (M2-T49): the pure function `StatisticsRules.shelfAverages`
/// on fixture values, then the shelf model's rows and the coffee screen's product line on an
/// in-memory store. Vocabulary values come from the generated enums.
@MainActor
final class ShelfAveragesTests: XCTestCase {
    private let bagA = UUID()
    private let bagB = UUID()
    private let bagC = UUID()
    private let beanOne = UUID()
    private let beanTwo = UUID()

    // MARK: - Fixtures

    /// Every criterion scored `score`.
    private func rating(_ score: Double) -> RatingValues {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = score
        }
        return RatingValues(scores: scores)
    }

    private func brew(in entry: UUID?, _ rating: RatingValues?, removed: Bool = false) -> StatisticsBrew {
        StatisticsBrew(
            brewedAt: Date(timeIntervalSince1970: 1_795_000_000),
            method: Vocabulary.Method.allCases.first,
            bean: nil,
            rating: rating,
            isRemoved: removed,
            shelfEntryID: entry
        )
    }

    private func average(_ mean: Double, _ brews: Int) -> OverallAverage {
        OverallAverage(mean: mean, ratedBrews: brews)
    }

    // MARK: - The pure function

    func testABagWithoutRatedBrewsHasNothingNotZeros() {
        let bags = [ShelfBag(entryID: bagA, beanID: beanOne)]
        XCTAssertEqual(StatisticsRules.shelfAverages(of: [brew(in: bagA, nil)], bags: bags)[bagA], ShelfAverages.none)
        XCTAssertEqual(StatisticsRules.shelfAverages(of: [], bags: bags)[bagA], ShelfAverages.none)
    }

    func testOneRatedBrewGivesTheBagLineAndNoProductLineWithOneBag() {
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(7.5))],
            bags: [ShelfBag(entryID: bagA, beanID: beanOne)]
        )
        XCTAssertEqual(result[bagA], ShelfAverages(bag: average(7.5, 1), product: nil))
    }

    func testTwoBagsOfOneBeanCombineForTheProductAndStayApartForTheBag() {
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(8)), brew(in: bagA, rating(6)), brew(in: bagB, rating(10))],
            bags: [ShelfBag(entryID: bagA, beanID: beanOne), ShelfBag(entryID: bagB, beanID: beanOne)]
        )
        let product = average(8, 3)
        XCTAssertEqual(result[bagA], ShelfAverages(bag: average(7, 2), product: product))
        XCTAssertEqual(result[bagB], ShelfAverages(bag: average(10, 1), product: product))
    }

    func testABagWithoutBrewsStillShowsTheProductLineOfItsBean() {
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(8))],
            bags: [ShelfBag(entryID: bagA, beanID: beanOne), ShelfBag(entryID: bagB, beanID: beanOne)]
        )
        XCTAssertNil(result[bagB]?.bag)
        XCTAssertEqual(result[bagB]?.product, average(8, 1))
    }

    func testBrewsOfOtherBeansNeverCountInTheProduct() {
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(8)), brew(in: bagB, rating(6)), brew(in: bagC, rating(2))],
            bags: [
                ShelfBag(entryID: bagA, beanID: beanOne),
                ShelfBag(entryID: bagB, beanID: beanOne),
                ShelfBag(entryID: bagC, beanID: beanTwo),
            ]
        )
        XCTAssertEqual(result[bagA]?.product, average(7, 2))
        XCTAssertEqual(result[bagC], ShelfAverages(bag: average(2, 1), product: nil), "its own bean has one bag")
    }

    func testRemovedUnratedAndForeignBrewsAreLeftOut() {
        let result = StatisticsRules.shelfAverages(
            of: [
                brew(in: bagA, rating(8)),
                brew(in: bagA, rating(1), removed: true),
                brew(in: bagA, nil),
                brew(in: UUID(), rating(1)),
                brew(in: nil, rating(1)),
            ],
            bags: [ShelfBag(entryID: bagA, beanID: beanOne)]
        )
        XCTAssertEqual(result[bagA]?.bag, average(8, 1))
    }

    func testARatingOfAnOlderVocabularyCountsOnlyWhereItScoresOverall() {
        var older: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases where criterion != .overall {
            older[criterion.rawValue] = 1
        }
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(8)), brew(in: bagA, RatingValues(scores: older))],
            bags: [ShelfBag(entryID: bagA, beanID: beanOne)]
        )
        XCTAssertEqual(result[bagA]?.bag, average(8, 1), "the rating without an overall score is no part of the mean")
    }

    func testABagWithoutABeanHasNoProductLine() {
        let result = StatisticsRules.shelfAverages(
            of: [brew(in: bagA, rating(8)), brew(in: bagB, rating(6))],
            bags: [ShelfBag(entryID: bagA, beanID: nil), ShelfBag(entryID: bagB, beanID: nil)]
        )
        XCTAssertNil(result[bagA]?.product)
        XCTAssertEqual(result[bagB]?.bag, average(6, 1))
    }

    // MARK: - The shelf model and the coffee screen

    @discardableResult
    private func addBrew(_ store: AccountStore, to entry: StoredShelfEntry, score: Double?, at brewedAt: String) throws -> StoredBrew {
        let brew = try StoredBrew(try StoreFixtures.brewInput(brewedAt: brewedAt, rated: false))
        try brew.setRating(score.map { value in rating(value) })
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    private func secondBag(of entry: StoredShelfEntry, in store: AccountStore) throws -> StoredShelfEntry {
        let bean = try XCTUnwrap(entry.bean)
        let second = StoredShelfEntry(try StoreFixtures.shelfEntryInput(), serverID: "01JD00000000000000000SHEF2")
        try store.addShelfEntry(second, bean: bean, syncState: .synced)
        return second
    }

    private func today() throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-25T10:00:00Z"))
    }

    private func shelf(_ store: AccountStore) throws -> ShelfModel {
        let now = try today()
        let model = ShelfModel(store: store, now: { now }, calendar: try StoreFixtures.calendar("Europe/Berlin"))
        model.reload()
        return model
    }

    func testRowsWithoutRatedBrewsShowNoAverages() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, score: nil, at: "2026-11-24T08:00:00.000Z")
        let model = try shelf(store)
        XCTAssertEqual(model.rows.first?.averages, ShelfAverages.none)
    }

    func testARowShowsItsBagMeanAndTheProductMeanOfTwoBags() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let second = try secondBag(of: entry, in: store)
        try addBrew(store, to: entry, score: 8, at: "2026-11-23T08:00:00.000Z")
        try addBrew(store, to: entry, score: 6, at: "2026-11-24T08:00:00.000Z")
        try addBrew(store, to: second, score: 10, at: "2026-11-25T08:00:00.000Z")
        let model = try shelf(store)
        let first = try XCTUnwrap(model.rows.first { row in row.id == entry.localID })
        let other = try XCTUnwrap(model.rows.first { row in row.id == second.localID })
        XCTAssertEqual(first.averages.bag, average(7, 2))
        XCTAssertEqual(first.averages.product, average(8, 3))
        XCTAssertEqual(other.averages.bag, average(10, 1))
        XCTAssertEqual(other.averages.product, average(8, 3))
    }

    func testARemovedBrewLeavesTheRowAfterAReload() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, score: 8, at: "2026-11-23T08:00:00.000Z")
        let removed = try addBrew(store, to: entry, score: 2, at: "2026-11-24T08:00:00.000Z")
        removed.syncState = .pendingDelete
        try store.save()
        let model = try shelf(store)
        XCTAssertEqual(model.rows.first?.averages.bag, average(8, 1))
    }

    func testTheCoffeeScreenGetsTheProductLineOnlyWithMoreThanOneBag() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, score: 8, at: "2026-11-23T08:00:00.000Z")
        let now = try today()
        let calendar = try StoreFixtures.calendar("Europe/Berlin")
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store, now: { now }, calendar: calendar)
        XCTAssertNil(editor.productAverage, "one bag: the line would repeat the bag line")

        let second = try secondBag(of: entry, in: store)
        try addBrew(store, to: second, score: 6, at: "2026-11-24T08:00:00.000Z")
        editor.refresh()
        XCTAssertEqual(editor.productAverage, average(7, 2))
        XCTAssertEqual(editor.averages.ratedBrews, 1, "the bag's own numbers stay the bag's")
    }

    // MARK: - Wording

    func testTheLinesUseTheSummaryWordingAndTheProductWording() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(ShelfAverageLines.bagText(average(7.4, 3), locale: locale), L10n.coffeeSummaryOverall(mean: "7.4", brews: "3"))
        XCTAssertEqual(ShelfAverageLines.productText(average(7.1, 5), locale: locale), L10n.shelfRowProductAverage(mean: "7.1", brews: "5"))
    }
}
