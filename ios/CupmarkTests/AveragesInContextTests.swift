import XCTest
@testable import Cupmark

/// Averages in context (M2-T48): the marker state of a rating slider (hidden until its score is
/// set, shown when editing a rating, the brew being rated left out, the community slot), the
/// rows of the brew list (own overall, the coffee's average from two rated brews on) and the
/// summary of a coffee. The numbers come from `StatisticsRules.coffeeAverages`, tested in
/// `CoffeeAveragesTests`; criteria and the scale come from the generated vocabulary.
@MainActor
final class AveragesInContextTests: XCTestCase {
    /// Every criterion scored `score`.
    private func values(_ score: Double) -> RatingValues {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = score
        }
        return RatingValues(scores: scores)
    }

    @discardableResult
    private func addBrew(
        _ store: AccountStore,
        to entry: StoredShelfEntry,
        at brewedAt: String,
        rating: RatingValues?
    ) throws -> StoredBrew {
        let brew = try StoredBrew(try StoreFixtures.brewInput(brewedAt: brewedAt, rated: false))
        try brew.setRating(rating)
        try store.addBrew(brew, shelfEntry: entry)
        return brew
    }

    private func firstCriterion() throws -> Vocabulary.Criterion {
        try StoreFixtures.first(Vocabulary.Criterion.self)
    }

    // MARK: - Slider markers

    func testTheMarkerIsHiddenUntilTheScoreIsSetThenShowsTheOthersMean() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-23T08:00:00.000Z", rating: values(6))
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(8))
        let current = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let model = RatingFormModel(brew: current.localID, store: store)
        let criterion = try firstCriterion()

        XCTAssertNil(model.markers(for: criterion), "no marker before the slider was touched, so it cannot anchor")
        model.beginSliding(criterion)
        let markers = try XCTUnwrap(model.markers(for: criterion))
        XCTAssertEqual(try XCTUnwrap(markers.own), 7, accuracy: 0.0001)
        XCTAssertNil(markers.community, "no community value until M4")

        for other in Vocabulary.Criterion.allCases where other != criterion {
            XCTAssertNil(model.markers(for: other), "only the slider that was set shows its marker")
        }
    }

    func testTheMarkerIsAFixedAverageThatDoesNotFollowTheScore() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(6))
        let current = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let model = RatingFormModel(brew: current.localID, store: store)
        let criterion = try firstCriterion()

        model.beginSliding(criterion)
        let before = model.markers(for: criterion)
        model.setSliderValue(Vocabulary.Ranges.scale.maximum, for: criterion)
        XCTAssertEqual(model.markers(for: criterion), before, "moving the slider does not move the marker")
        XCTAssertEqual(model.draft.score(for: criterion), Vocabulary.Ranges.scale.maximum, "the marker does not change the score")
        XCTAssertEqual(model.sliderValue(for: criterion), Vocabulary.Ranges.scale.maximum, accuracy: 0.0001)
    }

    func testEditingAnExistingRatingShowsTheMarkersAtOnceAndLeavesTheBrewOut() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(6))
        let rated = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: values(10))
        let model = RatingFormModel(brew: rated.localID, store: store)

        for criterion in Vocabulary.Criterion.allCases {
            let markers = try XCTUnwrap(model.markers(for: criterion), "a rated brew opens with its markers")
            XCTAssertEqual(try XCTUnwrap(markers.own), 6, accuracy: 0.0001, "the brew being rated (10) is left out of the mean")
        }
    }

    func testNoMarkerWithoutAnotherRatedBrewEvenOnceTheScoreIsSet() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let current = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let model = RatingFormModel(brew: current.localID, store: store)
        let criterion = try firstCriterion()
        model.beginSliding(criterion)
        XCTAssertNil(model.markers(for: criterion), "no other rated brew: nothing to show, no zero")

        // The only rated brew is the one being edited.
        try current.setRating(values(9))
        try store.save()
        let editing = RatingFormModel(brew: current.localID, store: store)
        XCTAssertNil(editing.markers(for: criterion), "the brew's own rating is not its average")
    }

    func testRemovedAndUnratedBrewsDoNotCount() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-22T08:00:00.000Z", rating: values(6))
        let removed = try addBrew(store, to: entry, at: "2026-11-23T08:00:00.000Z", rating: values(1))
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: nil)
        let current = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        try store.markDeleted(removed)
        let model = RatingFormModel(brew: current.localID, store: store)
        let criterion = try firstCriterion()
        model.beginSliding(criterion)
        XCTAssertEqual(try XCTUnwrap(model.markers(for: criterion)?.own), 6, accuracy: 0.0001)
    }

    func testTheCommunitySlotShowsASecondMarkerOnlyWhileItHasAValueAndTheScoreIsSet() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(6))
        let current = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let model = RatingFormModel(brew: current.localID, store: store)
        let criterion = try firstCriterion()
        let community = CommunityValue(mean: 7.5, raters: 12)

        model.setCommunityValues([criterion: community])
        XCTAssertNil(model.markers(for: criterion), "the community marker does not anchor either")
        model.beginSliding(criterion)
        XCTAssertEqual(model.markers(for: criterion)?.community, community)
        XCTAssertEqual(try XCTUnwrap(model.markers(for: criterion)?.own), 6, accuracy: 0.0001)

        model.setCommunityValues([:])
        XCTAssertNil(model.markers(for: criterion)?.community, "hidden while nil")
        XCTAssertNotNil(model.markers(for: criterion)?.own)
    }

    func testAMarkerSitsAtItsValueOnTheScale() throws {
        let scale = Vocabulary.Ranges.scale
        XCTAssertEqual(SliderMarkers.fraction(of: scale.minimum), 0, accuracy: 0.0001)
        XCTAssertEqual(SliderMarkers.fraction(of: scale.maximum), 1, accuracy: 0.0001)
        XCTAssertEqual(SliderMarkers.fraction(of: scale.middle), 0.5, accuracy: 0.0001)
        XCTAssertEqual(SliderMarkers.fraction(of: scale.maximum + 5), 1, accuracy: 0.0001, "outside the scale stays on the track")
    }

    // MARK: - Brew list

    func testBrewListRowsShowTheirOverallAndTheCoffeesAverageFromTwoRatedBrewsOn() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let low = try addBrew(store, to: entry, at: "2026-11-23T08:00:00.000Z", rating: values(6))
        let high = try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(8))
        let unrated = try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)
        list.reload()

        let byID = Dictionary(uniqueKeysWithValues: list.rows.map { row in (row.id, row) })
        XCTAssertEqual(byID[low.localID]?.overall, 6)
        XCTAssertEqual(byID[high.localID]?.overall, 8)
        XCTAssertEqual(try XCTUnwrap(byID[low.localID]?.coffeeAverageOverall), 7, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(byID[high.localID]?.coffeeAverageOverall), 7, accuracy: 0.0001)
        XCTAssertNil(byID[unrated.localID]?.overall, "an unrated row shows neither number")
        XCTAssertNil(byID[unrated.localID]?.coffeeAverageOverall)
    }

    func testOneRatedBrewShowsItsOverallButNoAverage() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let only = try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(8))
        try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: nil)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)
        list.reload()
        let row = try XCTUnwrap(list.rows.first { row in row.id == only.localID })
        XCTAssertEqual(row.overall, 8)
        XCTAssertNil(row.coffeeAverageOverall, "one rated brew is not an average")
    }

    func testARemovedBrewIsNotInTheListsAverage() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-22T08:00:00.000Z", rating: values(6))
        try addBrew(store, to: entry, at: "2026-11-23T08:00:00.000Z", rating: values(8))
        let removed = try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(1))
        try store.markDeleted(removed)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)
        list.reload()
        XCTAssertEqual(list.rows.count, 2)
        XCTAssertTrue(list.rows.allSatisfy { row in abs((row.coffeeAverageOverall ?? 0) - 7) < 0.0001 })
    }

    // MARK: - Summary of a coffee

    func testTheSummaryNeedsARatedBrewAndShowsNoZeros() throws {
        let empty = CoffeeAverages(ratedBrews: 0, rows: [], methods: [])
        XCTAssertNil(empty.summaryOverall)

        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try addBrew(store, to: entry, at: "2026-11-24T08:00:00.000Z", rating: values(6))
        try addBrew(store, to: entry, at: "2026-11-25T08:00:00.000Z", rating: values(8))
        let model = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store)
        XCTAssertEqual(model.averages.ratedBrews, 2)
        XCTAssertEqual(try XCTUnwrap(model.averages.summaryOverall), 7, accuracy: 0.0001)

        // Rated, but only on a criterion this build does not know: no overall, no summary.
        let unknown = RatingValues(scores: ["future_criterion": 9])
        let others = StatisticsRules.coffeeAverages(
            of: [StatisticsBrew(brewedAt: Date(), method: nil, bean: nil, rating: unknown, shelfEntryID: entry.localID)],
            shelfEntry: entry.localID
        )
        XCTAssertNil(others.summaryOverall)
    }
}
