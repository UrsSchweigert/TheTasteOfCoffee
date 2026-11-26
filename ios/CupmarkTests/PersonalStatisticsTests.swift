import Foundation
import XCTest
@testable import Cupmark

/// The personal statistics (M2-T28, ADR 0027) on fixture values: means, the per-method
/// threshold, the top notes, best method and bean with their threshold and tie rules, the
/// buy-again share, removed and unrated brews, the empty state, and ISO weeks across New Year
/// in a fixed time zone. Vocabulary values come from the generated enums, never a typed list.
final class PersonalStatisticsTests: XCTestCase {
    // MARK: - Fixtures

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

    private func note(_ index: Int) throws -> Vocabulary.FlavourNote {
        let notes = Vocabulary.FlavourNote.allCases
        XCTAssertGreaterThan(notes.count, index, "the vocabulary has too few notes for this test")
        return try XCTUnwrap(notes.indices.contains(index) ? notes[index] : nil)
    }

    private func bean() -> StatisticsBean {
        StatisticsBean(id: UUID(), summary: ShelfBeanSummary(name: nil, brand: nil, attributes: []))
    }

    /// Every criterion scored `score`, `overall` scored `overall` if given.
    private func rating(
        _ score: Double,
        overall: Double? = nil,
        notes: [Vocabulary.FlavourNote] = [],
        buyAgain: Bool? = nil
    ) -> RatingValues {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = score
        }
        if let overall {
            scores[Vocabulary.Criterion.overall.rawValue] = overall
        }
        return RatingValues(scores: scores, flavourNotes: notes.isEmpty ? nil : notes.map(\.rawValue), buyAgain: buyAgain)
    }

    private func brew(
        _ brewedAt: String = "2026-11-25T08:00:00Z",
        method: Vocabulary.Method?,
        bean: StatisticsBean? = nil,
        rating: RatingValues? = nil,
        removed: Bool = false
    ) throws -> StatisticsBrew {
        StatisticsBrew(brewedAt: try date(brewedAt), method: method, bean: bean, rating: rating, isRemoved: removed)
    }

    private func compute(_ brews: [StatisticsBrew], now: String = "2026-11-26T12:00:00Z") throws -> PersonalStatistics {
        PersonalStatistics.compute(brews, now: try date(now), calendar: try calendar())
    }

    // MARK: - Thresholds

    func testTheThresholdsAreTheOnesOfADR0027() {
        XCTAssertEqual(StatisticsRules.minimumRatedBrews, 2)
        XCTAssertEqual(StatisticsRules.weekCount, 8)
        XCTAssertEqual(StatisticsRules.topFlavourNoteCount, 5)
        XCTAssertEqual(StatisticsRules.meanFractionDigits, 1)
    }

    func testAMeanIsShownWithOneDecimalInTheLocale() {
        let mean = 43.0 / 6
        XCTAssertEqual(mean.formatted(StatisticsRules.meanStyle().locale(Locale(identifier: "de_DE"))), "7,2")
        XCTAssertEqual(mean.formatted(StatisticsRules.meanStyle().locale(Locale(identifier: "en_US"))), "7.2")
        XCTAssertEqual(7.0.formatted(StatisticsRules.meanStyle().locale(Locale(identifier: "en_US"))), "7.0")
    }

    // MARK: - Empty state

    func testNoBrewsGiveEmptySectionsNotZeros() throws {
        let statistics = try compute([])
        XCTAssertEqual(statistics.totalBrews, 0)
        XCTAssertFalse(statistics.hasBrews)
        XCTAssertFalse(statistics.hasRatedBrews)
        XCTAssertEqual(statistics.tasteProfile, [])
        XCTAssertEqual(statistics.methodProfiles, [])
        XCTAssertEqual(statistics.topFlavourNotes, [])
        XCTAssertNil(statistics.bestMethod)
        XCTAssertNil(statistics.bestBean)
        XCTAssertNil(statistics.buyAgain)
    }

    func testUnratedBrewsCountAsBrewsButNeverAsScores() throws {
        let first = try method(0)
        let statistics = try compute([
            try brew(method: first),
            try brew(method: first),
            try brew(method: first),
            try brew(method: nil),
        ])
        XCTAssertEqual(statistics.totalBrews, 4, "unrated brews and an unknown method are brews")
        XCTAssertEqual(statistics.ratedBrews, 0)
        XCTAssertTrue(statistics.hasBrews)
        XCTAssertFalse(statistics.hasRatedBrews)
        XCTAssertEqual(statistics.tasteProfile, [], "no score without a rated brew")
        XCTAssertEqual(statistics.methodProfiles, [], "unrated brews do not reach the method threshold")
        XCTAssertNil(statistics.bestMethod)
        XCTAssertNil(statistics.buyAgain)
    }

    // MARK: - Means

    func testTheTasteProfileIsTheMeanOfEachCriterionOverRatedBrewsOnly() throws {
        let first = try method(0)
        let statistics = try compute([
            try brew(method: first, rating: rating(6)),
            try brew(method: first, rating: rating(7)),
            try brew(method: first, rating: rating(8.5)),
            try brew(method: first),
        ])
        XCTAssertEqual(statistics.ratedBrews, 3)
        XCTAssertEqual(statistics.tasteProfile.map(\.criterion), Vocabulary.Criterion.allCases, "every criterion, in vocabulary order")
        for entry in statistics.tasteProfile {
            XCTAssertEqual(entry.mean, 21.5 / 3, accuracy: 1e-12, "\(entry.criterion)")
            XCTAssertEqual(entry.count, 3)
        }
    }

    func testACriterionIsAveragedOverTheRatingsThatScoreIt() throws {
        let criterion = try XCTUnwrap(Vocabulary.Criterion.allCases.first)
        var partial = rating(9)
        partial.scores[criterion.rawValue] = nil
        let statistics = try compute([
            try brew(method: try method(0), rating: rating(5)),
            try brew(method: try method(0), rating: partial),
        ])
        let entry = try XCTUnwrap(statistics.tasteProfile.first { mean in mean.criterion == criterion })
        XCTAssertEqual(entry.mean, 5)
        XCTAssertEqual(entry.count, 1)
        let overall = try XCTUnwrap(statistics.tasteProfile.first { mean in mean.criterion == .overall })
        XCTAssertEqual(overall.mean, 7)
        XCTAssertEqual(overall.count, 2)
    }

    func testAMethodHasATasteProfileOnlyWithEnoughRatedBrews() throws {
        let shown = try method(0)
        let hidden = try method(1)
        var brews: [StatisticsBrew] = []
        for _ in 0..<StatisticsRules.minimumRatedBrews {
            brews.append(try brew(method: shown, rating: rating(8)))
        }
        for _ in 0..<(StatisticsRules.minimumRatedBrews - 1) {
            brews.append(try brew(method: hidden, rating: rating(4)))
        }
        // Unrated brews of the hidden method do not lift it over the threshold.
        brews.append(try brew(method: hidden))
        brews.append(try brew(method: hidden))
        let statistics = try compute(brews)
        XCTAssertEqual(statistics.methodProfiles.map(\.method), [shown])
        let profile = try XCTUnwrap(statistics.methodProfiles.first)
        XCTAssertEqual(profile.ratedBrews, StatisticsRules.minimumRatedBrews)
        XCTAssertEqual(profile.means.map(\.mean), Array(repeating: 8, count: Vocabulary.Criterion.allCases.count))
    }

    // MARK: - Flavour notes

    func testTheTopNotesAreTheMostPickedOncePerRatingWithTiesInVocabularyOrder() throws {
        let first = try method(0)
        let notes = try (0..<7).map { index in try note(index) }
        var unknown = rating(6, notes: [notes[0]])
        unknown.flavourNotes = (unknown.flavourNotes ?? []) + ["not_a_note_of_this_vocabulary", notes[0].rawValue]
        let statistics = try compute([
            try brew(method: first, rating: unknown),
            try brew(method: first, rating: rating(6, notes: [notes[0], notes[2]])),
            try brew(method: first, rating: rating(6, notes: [notes[0], notes[2], notes[6]])),
            try brew(method: first, rating: rating(6, notes: [notes[5], notes[4], notes[3], notes[1]])),
            try brew(method: first, rating: rating(6, notes: [notes[1], notes[2], notes[3], notes[4], notes[5]]), removed: true),
        ])
        XCTAssertEqual(statistics.topFlavourNotes.count, StatisticsRules.topFlavourNoteCount)
        XCTAssertEqual(statistics.topFlavourNotes, [
            FlavourNoteCount(note: notes[0], count: 3),
            FlavourNoteCount(note: notes[2], count: 2),
            FlavourNoteCount(note: notes[1], count: 1),
            FlavourNoteCount(note: notes[3], count: 1),
            FlavourNoteCount(note: notes[4], count: 1),
        ])
    }

    func testRatedBrewsWithoutNotesGiveNoTopNotes() throws {
        let statistics = try compute([try brew(method: try method(0), rating: rating(6))])
        XCTAssertTrue(statistics.hasRatedBrews)
        XCTAssertEqual(statistics.topFlavourNotes, [])
    }

    // MARK: - Best method

    func testTheBestMethodNeedsEnoughRatedBrews() throws {
        let single = try method(0)
        let pair = try method(1)
        let statistics = try compute([
            try brew(method: single, rating: rating(5, overall: 10)),
            try brew(method: pair, rating: rating(5, overall: 7)),
            try brew(method: pair, rating: rating(5, overall: 8)),
            try brew(method: single),
        ])
        let best = try XCTUnwrap(statistics.bestMethod)
        XCTAssertEqual(best.key, pair, "one great cup does not win")
        XCTAssertEqual(best.mean, 7.5)
        XCTAssertEqual(best.ratedBrews, 2)
    }

    func testNoBestMethodWhileNoMethodHasEnoughRatedBrews() throws {
        let statistics = try compute([
            try brew(method: try method(0), rating: rating(5, overall: 9)),
            try brew(method: try method(1), rating: rating(5, overall: 9)),
        ])
        XCTAssertNil(statistics.bestMethod)
        XCTAssertNil(statistics.bestBean)
    }

    func testOnAnEqualMeanTheMethodWithMoreRatedBrewsWins() throws {
        let fewer = try method(0)
        let more = try method(1)
        let brews = [
            try brew("2026-11-25T08:00:00Z", method: fewer, rating: rating(5, overall: 8)),
            try brew("2026-11-25T09:00:00Z", method: fewer, rating: rating(5, overall: 8)),
            try brew("2026-11-20T08:00:00Z", method: more, rating: rating(5, overall: 8)),
            try brew("2026-11-21T08:00:00Z", method: more, rating: rating(5, overall: 7.5)),
            try brew("2026-11-22T08:00:00Z", method: more, rating: rating(5, overall: 8.5)),
        ]
        XCTAssertEqual(try compute(brews).bestMethod?.key, more)
        XCTAssertEqual(try compute(Array(brews.reversed())).bestMethod?.key, more, "the input order does not matter")
    }

    func testOnAnEqualMeanAndCountTheMostRecentMethodWins() throws {
        let older = try method(0)
        let newer = try method(1)
        let brews = [
            try brew("2026-11-20T08:00:00Z", method: older, rating: rating(5, overall: 7)),
            try brew("2026-11-24T08:00:00Z", method: older, rating: rating(5, overall: 9)),
            try brew("2026-11-21T08:00:00Z", method: newer, rating: rating(5, overall: 8)),
            try brew("2026-11-25T08:00:00Z", method: newer, rating: rating(5, overall: 8)),
        ]
        let best = try XCTUnwrap(try compute(brews).bestMethod)
        XCTAssertEqual(best.key, newer)
        XCTAssertEqual(best.latestBrewedAt, try date("2026-11-25T08:00:00Z"))
        XCTAssertEqual(try compute(Array(brews.reversed())).bestMethod?.key, newer)
    }

    // MARK: - Best bean

    func testTheBestBeanNeedsEnoughRatedBrewsAndFollowsTheTieRules() throws {
        let single = bean()
        let fewer = bean()
        let more = bean()
        let first = try method(0)
        let brews = [
            try brew(method: first, bean: single, rating: rating(5, overall: 10)),
            try brew("2026-11-25T08:00:00Z", method: first, bean: fewer, rating: rating(5, overall: 9)),
            try brew("2026-11-25T09:00:00Z", method: first, bean: fewer, rating: rating(5, overall: 7)),
            try brew("2026-11-10T08:00:00Z", method: first, bean: more, rating: rating(5, overall: 8)),
            try brew("2026-11-11T08:00:00Z", method: first, bean: more, rating: rating(5, overall: 8)),
            try brew("2026-11-12T08:00:00Z", method: first, bean: more, rating: rating(5, overall: 8)),
            try brew(method: first, bean: single),
            try brew(method: first, bean: single),
        ]
        let best = try XCTUnwrap(try compute(brews).bestBean)
        XCTAssertEqual(best.bean, more, "equal mean: more rated brews win; a single cup and unrated brews never count")
        XCTAssertEqual(best.score.mean, 8)
        XCTAssertEqual(best.score.ratedBrews, 3)
    }

    func testOnAnEqualMeanAndCountTheMostRecentBeanWins() throws {
        let older = bean()
        let newer = bean()
        let first = try method(0)
        let brews = [
            try brew("2026-11-01T08:00:00Z", method: first, bean: older, rating: rating(5, overall: 6)),
            try brew("2026-11-23T08:00:00Z", method: first, bean: older, rating: rating(5, overall: 8)),
            try brew("2026-11-02T08:00:00Z", method: first, bean: newer, rating: rating(5, overall: 7)),
            try brew("2026-11-24T08:00:00Z", method: first, bean: newer, rating: rating(5, overall: 7)),
        ]
        XCTAssertEqual(try compute(brews).bestBean?.bean, newer)
        XCTAssertEqual(try compute(Array(brews.reversed())).bestBean?.bean, newer)
    }

    // MARK: - Buy again

    func testTheBuyAgainShareCountsOnlyRatingsThatAnswerIt() throws {
        let first = try method(0)
        let statistics = try compute([
            try brew(method: first, rating: rating(6, buyAgain: true)),
            try brew(method: first, rating: rating(6, buyAgain: true)),
            try brew(method: first, rating: rating(6, buyAgain: false)),
            try brew(method: first, rating: rating(6)),
            try brew(method: first, rating: rating(6)),
            try brew(method: first),
        ])
        let share = try XCTUnwrap(statistics.buyAgain)
        XCTAssertEqual(share.yes, 2)
        XCTAssertEqual(share.answered, 3, "an unanswered rating is not a no")
        XCTAssertEqual(share.share, 2.0 / 3, accuracy: 1e-12)
    }

    func testNoBuyAgainShareWhenNoRatingAnswersIt() throws {
        let statistics = try compute([try brew(method: try method(0), rating: rating(6))])
        XCTAssertNil(statistics.buyAgain)
    }

    // MARK: - Removed brews

    func testRemovedBrewsAreLeftOutOfEverything() throws {
        let first = try method(0)
        let second = try method(1)
        let kept = bean()
        let removedBean = bean()
        let statistics = try compute([
            try brew(method: first, bean: kept, rating: rating(5, buyAgain: false)),
            try brew(method: first, bean: kept, rating: rating(5)),
            try brew(method: second, bean: removedBean, rating: rating(10, notes: [try note(0)], buyAgain: true), removed: true),
            try brew(method: second, bean: removedBean, rating: rating(10, buyAgain: true), removed: true),
            try brew(method: second, removed: true),
        ])
        XCTAssertEqual(statistics.totalBrews, 2)
        XCTAssertEqual(statistics.ratedBrews, 2)
        XCTAssertEqual(statistics.weeks.map(\.count).reduce(0, +), 2)
        XCTAssertEqual(statistics.tasteProfile.map(\.mean), Array(repeating: 5, count: Vocabulary.Criterion.allCases.count))
        XCTAssertEqual(statistics.methodProfiles.map(\.method), [first])
        XCTAssertEqual(statistics.topFlavourNotes, [])
        XCTAssertEqual(statistics.bestMethod?.key, first)
        XCTAssertEqual(statistics.bestBean?.bean, kept)
        XCTAssertEqual(statistics.buyAgain, BuyAgainShare(yes: 0, answered: 1))
    }

    // MARK: - Weeks

    func testTheISOWeekCalendarHasWeek53In2026() throws {
        let calendar = try self.calendar()
        let newYearsEve = try date("2026-12-31T12:00:00Z")
        XCTAssertEqual(calendar.component(.weekOfYear, from: newYearsEve), 53)
        XCTAssertEqual(calendar.component(.yearForWeekOfYear, from: newYearsEve), 2026)
        XCTAssertEqual(calendar.firstWeekday, 2, "weeks start on Monday")
    }

    func testBrewsPerWeekAreBucketedInISOWeeksAcrossNewYearInTheCalendarsTimeZone() throws {
        let first = try method(0)
        let statistics = try compute([
            // Sunday 2027-01-03, 23:30 in Berlin: still week 53 of 2026.
            try brew("2027-01-03T22:30:00Z", method: first),
            // Monday 2027-01-04, 00:30 in Berlin: week 1 of 2027.
            try brew("2027-01-03T23:30:00Z", method: first, rating: rating(7)),
            // New Year's Eve: week 53 of 2026.
            try brew("2026-12-31T10:00:00Z", method: first),
            // Sunday 2026-11-15, 23:59 in Berlin: week 46, just before the window.
            try brew("2026-11-15T22:59:00Z", method: first),
            // Monday 2026-11-16, 00:00 in Berlin: week 47, the first week of the window.
            try brew("2026-11-15T23:00:00Z", method: first),
        ], now: "2027-01-06T12:00:00Z")

        XCTAssertEqual(statistics.totalBrews, 5, "the total has every brew, also outside the window")
        XCTAssertEqual(statistics.weeks.count, StatisticsRules.weekCount)
        XCTAssertEqual(statistics.weeks.map(\.weekOfYear), [47, 48, 49, 50, 51, 52, 53, 1])
        XCTAssertEqual(statistics.weeks.map(\.yearForWeekOfYear), [2026, 2026, 2026, 2026, 2026, 2026, 2026, 2027])
        XCTAssertEqual(statistics.weeks.map(\.count), [1, 0, 0, 0, 0, 0, 2, 1])
        XCTAssertEqual(statistics.weeks.first?.start, try date("2026-11-15T23:00:00Z"))
        XCTAssertEqual(statistics.weeks.last?.start, try date("2027-01-03T23:00:00Z"), "Monday 00:00 in Berlin")
    }

    func testWeeksAcrossTheEndOfDaylightSavingTimeStartOnMondayAtMidnightLocal() throws {
        let calendar = try self.calendar()
        let first = try method(0)
        // Berlin leaves summer time on Sunday 2026-10-25 (03:00 CEST becomes 02:00 CET), so
        // week 43 is 169 hours long and Mondays move from 22:00Z to 23:00Z.
        let statistics = try compute([
            // Sunday 2026-10-18, 23:30 CEST: week 42.
            try brew("2026-10-18T21:30:00Z", method: first),
            // Sunday 2026-10-25, 23:30 CET, after the change: still week 43.
            try brew("2026-10-25T22:30:00Z", method: first),
            // Monday 2026-10-26, 00:00 CET: week 44.
            try brew("2026-10-25T23:00:00Z", method: first),
        ], now: "2026-11-04T12:00:00Z")

        guard statistics.weeks.count == StatisticsRules.weekCount else {
            return XCTFail("expected \(StatisticsRules.weekCount) weeks, got \(statistics.weeks.count)")
        }
        XCTAssertEqual(statistics.weeks.map(\.weekOfYear), [38, 39, 40, 41, 42, 43, 44, 45])
        XCTAssertEqual(statistics.weeks.map(\.count), [0, 0, 0, 0, 1, 1, 1, 0])
        for week in statistics.weeks {
            let parts = calendar.dateComponents([.weekday, .hour, .minute, .second], from: week.start)
            XCTAssertEqual(parts.weekday, 2, "week \(week.weekOfYear) starts on a Monday")
            XCTAssertEqual(parts.hour, 0, "week \(week.weekOfYear) starts at midnight local")
            XCTAssertEqual(parts.minute, 0)
            XCTAssertEqual(parts.second, 0)
        }
        XCTAssertEqual(statistics.weeks[5].start, try date("2026-10-18T22:00:00Z"), "Monday 00:00 CEST")
        XCTAssertEqual(statistics.weeks[6].start, try date("2026-10-25T23:00:00Z"), "Monday 00:00 CET")
    }

    func testRatingsWithOnlyUnknownCriteriaAreRatedButGiveNoTasteProfile() throws {
        let unknown = RatingValues(scores: ["criterion_of_a_newer_vocabulary": 8])
        let statistics = try compute([
            try brew(method: try method(0), rating: unknown),
            try brew(method: try method(0), rating: unknown),
        ])
        XCTAssertTrue(statistics.hasRatedBrews, "the screen shows its own text, not \"no rated brews\"")
        XCTAssertEqual(statistics.tasteProfile, [])
        XCTAssertNil(statistics.bestMethod, "no overall score this build knows")
    }
}

/// The statistics read from a real (in-memory) store: removed brews are left out, the bean
/// is the shelf entry's, and reading changes nothing in the store.
@MainActor
final class StatisticsModelTests: XCTestCase {
    func testTheModelReadsTheStoreWithoutRemovedBrewsAndWritesNothing() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let rated = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-24T08:00:00.000Z"), serverID: StoreFixtures.brewID)
        try store.addBrew(rated, shelfEntry: entry, syncState: .synced)
        let unrated = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z", rated: false), serverID: StoreFixtures.brewID)
        try store.addBrew(unrated, shelfEntry: entry, syncState: .synced)
        let removed = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T09:00:00.000Z"), serverID: StoreFixtures.brewID)
        try store.addBrew(removed, shelfEntry: entry, syncState: .synced)
        try store.markDeleted(removed)
        XCTAssertTrue(StatisticsBrew(removed, bean: nil).isRemoved)

        let queued = try store.outboxOperations().count
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-26T10:00:00Z"))
        let calendar = PersonalStatistics.isoWeekCalendar(timeZone: try XCTUnwrap(TimeZone(identifier: "Europe/Berlin")))
        let model = StatisticsModel(store: store, now: { now }, calendar: calendar)
        model.reload()

        XCTAssertFalse(model.loadFailed)
        let statistics = try XCTUnwrap(model.statistics)
        XCTAssertEqual(statistics.totalBrews, 2)
        XCTAssertEqual(statistics.ratedBrews, 1)
        XCTAssertEqual(statistics.weeks.last?.count, 2)
        let expected = try XCTUnwrap(StoreFixtures.rating().buyAgain)
        XCTAssertEqual(statistics.buyAgain, BuyAgainShare(yes: expected ? 1 : 0, answered: 1))
        XCTAssertNil(statistics.bestBean, "one rated brew is not enough")
        XCTAssertEqual(try store.outboxOperations().count, queued, "reading queues nothing")

        let values = StatisticsBrew.values(of: try store.brewsNewestFirst())
        XCTAssertEqual(values.compactMap(\.bean).map(\.id), [entry.bean?.localID, entry.bean?.localID].compactMap { id in id })
        XCTAssertEqual(values.first?.bean?.summary, ShelfBeanSummary(entry.bean))
    }

    func testSavesInQuickSuccessionAreCoalescedIntoOneRead() async throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = StatisticsModel(store: store, reloadDelay: .milliseconds(50))
        model.scheduleReload()
        model.scheduleReload()
        model.scheduleReload()
        XCTAssertEqual(model.reloadCount, 0, "nothing is read before the delay")
        let brew = try StoredBrew(try StoreFixtures.brewInput(), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        model.scheduleReload()

        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(model.reloadCount, 1, "four scheduled reads in a row, one read")
        XCTAssertEqual(model.statistics?.totalBrews, 1, "the read sees the last save")
    }

    func testAnImmediateReloadDropsAWaitingOne() async throws {
        let store = try AccountStore.inMemory()
        let model = StatisticsModel(store: store, reloadDelay: .milliseconds(50))
        model.scheduleReload()
        model.reload()
        XCTAssertEqual(model.reloadCount, 1)
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(model.reloadCount, 1, "the scheduled read was dropped")
    }
}
