import Foundation
import XCTest
@testable import Cupmark

/// "My brews of this coffee" (M2-T44, ADR 0027 addendum) on fixture values: only the brews of
/// the shelf entry itself count, removed and unrated brews do not, ratings from an older
/// vocabulary version do, one rated brew is labelled as one, the dimensions keep the
/// vocabulary order, a method is broken out from the shared threshold, and the row has an
/// optional community slot. Vocabulary values come from the generated enums.
final class CoffeeAveragesTests: XCTestCase {
    // MARK: - Fixtures

    private let bag = UUID()
    private let otherBag = UUID()

    private func method(_ index: Int) throws -> Vocabulary.Method {
        let methods = Vocabulary.Method.allCases
        XCTAssertGreaterThan(methods.count, index, "the vocabulary has too few methods for this test")
        return try XCTUnwrap(methods.indices.contains(index) ? methods[index] : nil)
    }

    /// Every criterion scored `score`; `overrides` replace single criteria.
    private func rating(_ score: Double, _ overrides: [Vocabulary.Criterion: Double] = [:]) -> RatingValues {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = overrides[criterion] ?? score
        }
        return RatingValues(scores: scores)
    }

    private func brew(
        in entry: UUID?,
        method: Vocabulary.Method?,
        rating: RatingValues?,
        removed: Bool = false,
        id: UUID? = nil
    ) -> StatisticsBrew {
        StatisticsBrew(
            brewedAt: Date(timeIntervalSince1970: 1_795_000_000),
            method: method,
            bean: nil,
            rating: rating,
            isRemoved: removed,
            shelfEntryID: entry,
            id: id
        )
    }

    private func averages(_ brews: [StatisticsBrew], community: [Vocabulary.Criterion: CommunityValue] = [:]) -> CoffeeAverages {
        StatisticsRules.coffeeAverages(of: brews, shelfEntry: bag, community: community)
    }

    private func mean(_ result: CoffeeAverages, _ criterion: Vocabulary.Criterion) throws -> Double {
        try XCTUnwrap(result.rows.first { row in row.criterion == criterion }?.mean)
    }

    // MARK: - Which brews count

    func testEachShelfEntryCountsOnlyItsOwnBrewsEvenOnTheSameBean() throws {
        let first = try method(0)
        let brews = [
            brew(in: bag, method: first, rating: rating(8)),
            brew(in: bag, method: first, rating: rating(6)),
            brew(in: otherBag, method: first, rating: rating(2)),
            brew(in: nil, method: first, rating: rating(1)),
        ]
        let mine = StatisticsRules.coffeeAverages(of: brews, shelfEntry: bag)
        XCTAssertEqual(mine.ratedBrews, 2)
        XCTAssertEqual(try mean(mine, .aroma), 7)
        let theirs = StatisticsRules.coffeeAverages(of: brews, shelfEntry: otherBag)
        XCTAssertEqual(theirs.ratedBrews, 1)
        XCTAssertEqual(try mean(theirs, .aroma), 2)
    }

    func testARemovedBrewIsLeftOut() throws {
        let first = try method(0)
        let result = averages([
            brew(in: bag, method: first, rating: rating(8)),
            brew(in: bag, method: first, rating: rating(2), removed: true),
        ])
        XCTAssertEqual(result.ratedBrews, 1)
        XCTAssertEqual(try mean(result, .flavour), 8)
    }

    func testAnUnratedBrewIsLeftOut() throws {
        let first = try method(0)
        let result = averages([
            brew(in: bag, method: first, rating: rating(7)),
            brew(in: bag, method: first, rating: nil),
        ])
        XCTAssertEqual(result.ratedBrews, 1)
        XCTAssertEqual(try mean(result, .overall), 7)
    }

    func testARatingFromAnOlderVocabularyStillCountsOnTheCriteriaItScores() throws {
        let first = try method(0)
        // An older version had fewer criteria: this rating scores only the first three.
        var older: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases.prefix(3) {
            older[criterion.rawValue] = 4
        }
        let result = averages([
            brew(in: bag, method: first, rating: rating(8)),
            brew(in: bag, method: first, rating: RatingValues(scores: older)),
        ])
        XCTAssertEqual(result.ratedBrews, 2, "the older rating counts as a rated brew")
        let all = Vocabulary.Criterion.allCases
        XCTAssertEqual(try mean(result, try XCTUnwrap(all.first)), 6, "mean of 8 and 4")
        let last = try XCTUnwrap(all.last)
        XCTAssertEqual(try mean(result, last), 8, "the criterion the older rating lacks is the other brew's alone")
        XCTAssertEqual(result.rows.last?.scoredBrews, 1)
        XCTAssertEqual(result.rows.first?.scoredBrews, 2)
    }

    func testARatingOfCriteriaThisBuildDoesNotKnowCountsButHasNoRows() {
        let future = RatingValues(scores: ["a_criterion_of_a_newer_vocabulary": 5])
        let result = averages([brew(in: bag, method: nil, rating: future)])
        XCTAssertEqual(result.ratedBrews, 1)
        XCTAssertTrue(result.rows.isEmpty)
        XCTAssertTrue(result.hasNoKnownScores)
        XCTAssertFalse(result.isEmpty)
    }

    // MARK: - Empty, one, many

    func testNoRatedBrewIsEmptyWithNoRowsAndNoZeros() throws {
        let result = averages([brew(in: bag, method: try method(0), rating: nil)])
        XCTAssertTrue(result.isEmpty)
        XCTAssertEqual(result.ratedBrews, 0)
        XCTAssertTrue(result.rows.isEmpty)
        XCTAssertTrue(result.methods.isEmpty)
        XCTAssertNil(result.overall)
        XCTAssertTrue(averages([]).isEmpty)
        // A coffee whose only brews belong to another bag is empty too.
        XCTAssertTrue(StatisticsRules.coffeeAverages(of: [brew(in: otherBag, method: nil, rating: rating(9))], shelfEntry: bag).isEmpty)
    }

    func testOneRatedBrewShowsItsOwnValuesAndIsLabelledAsOne() throws {
        let result = averages([brew(in: bag, method: try method(0), rating: rating(7.5, [.aroma: 9]))])
        XCTAssertTrue(result.isSingleBrew)
        XCTAssertFalse(result.isEmpty)
        XCTAssertEqual(result.ratedBrews, 1)
        XCTAssertEqual(try mean(result, .aroma), 9)
        XCTAssertEqual(try mean(result, .balance), 7.5)
        XCTAssertTrue(result.methods.isEmpty, "one brew gives no method breakdown")
    }

    func testTwoRatedBrewsAreNotSingle() throws {
        let first = try method(0)
        let result = averages([brew(in: bag, method: first, rating: rating(5)), brew(in: bag, method: first, rating: rating(6))])
        XCTAssertFalse(result.isSingleBrew)
        XCTAssertEqual(result.ratedBrews, 2)
    }

    func testTheOverallMeanIsTheOverallRow() throws {
        let first = try method(0)
        let result = averages([
            brew(in: bag, method: first, rating: rating(5, [.overall: 9])),
            brew(in: bag, method: first, rating: rating(5, [.overall: 8])),
        ])
        XCTAssertEqual(result.overall?.criterion, .overall)
        XCTAssertEqual(result.overall?.mean, 8.5)
    }

    // MARK: - Order, rounding, bars

    func testTheDimensionsAreInVocabularyOrder() throws {
        let first = try method(0)
        var varied: [String: Double] = [:]
        for (position, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            varied[criterion.rawValue] = Double(10 - position)
        }
        let result = averages([brew(in: bag, method: first, rating: RatingValues(scores: varied))])
        XCTAssertEqual(result.rows.map(\.criterion), Vocabulary.Criterion.allCases)
        XCTAssertEqual(result.rows.map(\.mean), Vocabulary.Criterion.allCases.indices.map { position in Double(10 - position) })
    }

    func testMeansAreNotRoundedInTheModelAndShowOneDecimalInTheLocale() throws {
        let first = try method(0)
        let result = averages([
            brew(in: bag, method: first, rating: rating(7)),
            brew(in: bag, method: first, rating: rating(7.5)),
            brew(in: bag, method: first, rating: rating(8)),
            brew(in: bag, method: first, rating: rating(7.5)),
            brew(in: bag, method: first, rating: rating(7.5)),
            brew(in: bag, method: first, rating: rating(8)),
        ])
        let value = try mean(result, .aroma)
        XCTAssertEqual(value, 45.5 / 6, accuracy: 1e-9)
        XCTAssertEqual(value.formatted(StatisticsRules.meanStyle().locale(Locale(identifier: "en_US"))), "7.6")
        XCTAssertEqual(value.formatted(StatisticsRules.meanStyle().locale(Locale(identifier: "de_DE"))), "7,6")
    }

    func testTheBarIsTheShareOfTheTopOfTheScaleAndStaysInRange() {
        let top = Vocabulary.Ranges.scale.maximum
        XCTAssertEqual(CoffeeAverageRow.barFraction(of: top), 1)
        XCTAssertEqual(CoffeeAverageRow.barFraction(of: top / 2), 0.5)
        XCTAssertEqual(CoffeeAverageRow.barFraction(of: top * 3), 1)
        XCTAssertEqual(CoffeeAverageRow.barFraction(of: -1), 0)
    }

    // MARK: - Method breakdown

    func testAMethodIsBrokenOutOnceItHasTheSharedThresholdOfRatedBrews() throws {
        let first = try method(0)
        let second = try method(1)
        let threshold = StatisticsRules.minimumRatedBrews
        XCTAssertEqual(threshold, 2, "the threshold of ADR 0027")

        var brews = (0..<threshold).map { _ in brew(in: bag, method: first, rating: rating(8)) }
        brews += (0..<(threshold - 1)).map { _ in brew(in: bag, method: second, rating: rating(4)) }
        // Brews of the other bag, a removed one and an unrated one do not lift a method over it.
        brews.append(brew(in: otherBag, method: second, rating: rating(4)))
        brews.append(brew(in: bag, method: second, rating: rating(4), removed: true))
        brews.append(brew(in: bag, method: second, rating: nil))

        let result = averages(brews)
        XCTAssertEqual(result.methods.map(\.method), [first])
        XCTAssertEqual(result.methods.first?.ratedBrews, threshold)
        XCTAssertEqual(result.methods.first?.rows.map(\.criterion), Vocabulary.Criterion.allCases)
        XCTAssertEqual(result.methods.first?.rows.first?.mean, 8)
        XCTAssertEqual(result.ratedBrews, threshold + threshold - 1)

        let reached = averages(brews + [brew(in: bag, method: second, rating: rating(6))])
        XCTAssertEqual(reached.methods.map(\.method), [first, second], "in vocabulary order")
        XCTAssertEqual(reached.methods.last?.rows.first?.mean, 5)
    }

    func testABrewWithAnUnknownMethodCountsInTheTotalsOnly() throws {
        let result = averages([
            brew(in: bag, method: nil, rating: rating(8)),
            brew(in: bag, method: nil, rating: rating(6)),
        ])
        XCTAssertEqual(result.ratedBrews, 2)
        XCTAssertTrue(result.methods.isEmpty)
    }

    // MARK: - The community slot (M4)

    func testTheCommunityValueIsNilUntilGivenAndOnlyOnItsOwnRow() throws {
        let first = try method(0)
        let brews = [brew(in: bag, method: first, rating: rating(8)), brew(in: bag, method: first, rating: rating(6))]
        XCTAssertTrue(averages(brews).rows.allSatisfy { row in row.community == nil }, "no server call, nothing to show")

        let community = CommunityValue(mean: 7.1, raters: 12)
        let result = averages(brews, community: [.acidity: community])
        XCTAssertEqual(result.rows.first { row in row.criterion == .acidity }?.community, community)
        XCTAssertEqual(result.rows.filter { row in row.community != nil }.count, 1)
        XCTAssertTrue(result.methods.allSatisfy { entry in entry.rows.allSatisfy { row in row.community == nil } }, "the method rows are the user's own")
    }

    // MARK: - Excluding the brew being rated (M2-T48)

    func testTheExcludedBrewIsLeftOutOfEveryMean() throws {
        let first = try method(0)
        let rated = UUID()
        let brews = [
            brew(in: bag, method: first, rating: rating(9), id: rated),
            brew(in: bag, method: first, rating: rating(6), id: UUID()),
            brew(in: bag, method: first, rating: rating(7), id: UUID()),
        ]
        let others = StatisticsRules.coffeeAverages(of: brews, shelfEntry: bag, excluding: rated)
        XCTAssertEqual(others.ratedBrews, 2)
        XCTAssertEqual(try mean(others, .overall), 6.5, accuracy: 0.0001)
        let all = StatisticsRules.coffeeAverages(of: brews, shelfEntry: bag)
        XCTAssertEqual(all.ratedBrews, 3, "no exclusion by default")
    }

    func testExcludingTheOnlyRatedBrewLeavesNothing() throws {
        let rated = UUID()
        let result = StatisticsRules.coffeeAverages(
            of: [brew(in: bag, method: nil, rating: rating(9), id: rated)],
            shelfEntry: bag,
            excluding: rated
        )
        XCTAssertTrue(result.isEmpty)
        XCTAssertTrue(result.rows.isEmpty, "no marker, no zeros")
    }

    func testExcludingOneOtherRatedBrewGivesItsOwnValues() throws {
        let rated = UUID()
        let result = StatisticsRules.coffeeAverages(
            of: [
                brew(in: bag, method: nil, rating: rating(9), id: rated),
                brew(in: bag, method: nil, rating: rating(7.5, [.aroma: 8]), id: UUID()),
            ],
            shelfEntry: bag,
            excluding: rated
        )
        XCTAssertTrue(result.isSingleBrew)
        XCTAssertEqual(try mean(result, .aroma), 8, accuracy: 0.0001)
    }

    func testExclusionKeepsTheOtherRules() throws {
        let rated = UUID()
        let older = RatingValues(scores: [Vocabulary.Criterion.overall.rawValue: 5])
        let result = StatisticsRules.coffeeAverages(
            of: [
                brew(in: bag, method: nil, rating: rating(9), id: rated),
                brew(in: bag, method: nil, rating: rating(1), removed: true, id: UUID()),
                brew(in: bag, method: nil, rating: nil, id: UUID()),
                brew(in: otherBag, method: nil, rating: rating(2), id: UUID()),
                brew(in: bag, method: nil, rating: older, id: UUID()),
            ],
            shelfEntry: bag,
            excluding: rated
        )
        XCTAssertEqual(result.ratedBrews, 1, "removed, unrated and other-bag brews stay out; the older rating counts")
        XCTAssertEqual(try mean(result, .overall), 5, accuracy: 0.0001)
        XCTAssertEqual(result.rows.count, 1, "only the criterion the older rating scores")
    }

    func testABrewWithoutAnIdIsNeverExcluded() throws {
        let result = StatisticsRules.coffeeAverages(
            of: [brew(in: bag, method: nil, rating: rating(8))],
            shelfEntry: bag,
            excluding: UUID()
        )
        XCTAssertEqual(result.ratedBrews, 1)
    }
}
