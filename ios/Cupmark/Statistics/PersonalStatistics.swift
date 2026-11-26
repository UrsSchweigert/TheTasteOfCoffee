import Foundation

// Personal statistics (M2-T28, ADR 0027): computed on the device from the account's local
// store, offline, with no route. `PersonalStatistics.compute` is a pure function over plain
// values (`StatisticsBrew`), so it is tested without SwiftData; `StatisticsModel` reads the
// store and calls it.

/// The thresholds and display rules of the statistics (ADR 0027). This is the only place
/// they are defined; the computation and the screen read them from here.
enum StatisticsRules {
    /// A method's taste profile is shown, and a method or bean takes part in "best", only
    /// with at least this many rated brews, so a single good cup does not top the list.
    static let minimumRatedBrews = 2
    /// Brews per ISO week are shown for this many weeks, the current one included.
    static let weekCount = 8
    /// The most-picked flavour notes are shown up to this many.
    static let topFlavourNoteCount = 5
    /// Means are shown with this many decimals, in the device locale.
    static let meanFractionDigits = 1

    /// How a mean is shown: one decimal, in the locale of the view's environment.
    static func meanStyle() -> FloatingPointFormatStyle<Double> {
        FloatingPointFormatStyle<Double>().precision(.fractionLength(meanFractionDigits))
    }

    /// How the buy-again share is shown: a whole percentage.
    static func shareStyle() -> FloatingPointFormatStyle<Double>.Percent {
        FloatingPointFormatStyle<Double>.Percent().precision(.fractionLength(0))
    }
}

// MARK: - Input

/// A bean as the statistics know it: its local id and what the shelf shows for it
/// (`ShelfBeanSummary`, which already leaves out unconfirmed Open Food Facts text).
struct StatisticsBean: Equatable, Sendable {
    let id: UUID
    let summary: ShelfBeanSummary
}

/// One brew of the local store, as plain values.
struct StatisticsBrew: Equatable, Sendable {
    let brewedAt: Date
    /// Nil for a method id the bundled vocabulary does not know: counted in the brews, left
    /// out of everything per method.
    let method: Vocabulary.Method?
    /// The bean of the brew's shelf entry, nil if it has none.
    let bean: StatisticsBean?
    /// Nil for an unrated brew: counted in the brews, left out of every score.
    let rating: RatingValues?
    /// Removed on the device (`pendingDelete`): left out of everything.
    let isRemoved: Bool
    /// The local id of the brew's shelf entry (one bag), nil if it has none. The averages of
    /// one coffee (`StatisticsRules.coffeeAverages`) count only the brews of their own entry.
    let shelfEntryID: UUID?
    /// The brew's own local id, nil when not known (a test value). `StatisticsRules.coffeeAverages`
    /// leaves out the brew being rated by it (M2-T48).
    let id: UUID?

    init(
        brewedAt: Date,
        method: Vocabulary.Method?,
        bean: StatisticsBean?,
        rating: RatingValues?,
        isRemoved: Bool = false,
        shelfEntryID: UUID? = nil,
        id: UUID? = nil
    ) {
        self.shelfEntryID = shelfEntryID
        self.id = id
        self.brewedAt = brewedAt
        self.method = method
        self.bean = bean
        self.rating = rating
        self.isRemoved = isRemoved
    }
}

// MARK: - Results

/// Brews in one ISO week.
struct WeekCount: Equatable, Sendable {
    /// The first moment of the week (Monday, 00:00 in the calendar's time zone).
    let start: Date
    /// The ISO week number and its year (`yearForWeekOfYear`), which differ from the
    /// calendar year around New Year.
    let weekOfYear: Int
    let yearForWeekOfYear: Int
    let count: Int
}

/// The mean score of one criterion over the ratings that score it.
struct CriterionMean: Equatable, Sendable {
    let criterion: Vocabulary.Criterion
    let mean: Double
    /// How many ratings scored it.
    let count: Int
}

/// The taste profile of one method.
struct MethodProfile: Equatable, Sendable {
    let method: Vocabulary.Method
    let ratedBrews: Int
    let means: [CriterionMean]
}

/// How often a flavour note was picked: once per rating at most.
struct FlavourNoteCount: Equatable, Sendable {
    let note: Vocabulary.FlavourNote
    let count: Int
}

/// The winner of "best method" or "best bean".
struct RankedScore<Key: Hashable & Sendable>: Equatable, Sendable {
    let key: Key
    /// The mean `overall` score.
    let mean: Double
    /// Rated brews with an `overall` score.
    let ratedBrews: Int
    /// The latest of those brews, the second tie break.
    let latestBrewedAt: Date
}

/// The best bean, with what the screen shows for it.
struct BestBean: Equatable, Sendable {
    let bean: StatisticsBean
    let score: RankedScore<UUID>
}

/// Buy again among the ratings that answer it (ADR 0026): a rating without an answer is not
/// a no.
struct BuyAgainShare: Equatable, Sendable {
    let yes: Int
    let answered: Int

    /// Yes as a fraction of the answers, 0 to 1. Only made with at least one answer.
    var share: Double { Double(yes) / Double(answered) }
}

/// The personal statistics of ADR 0027.
struct PersonalStatistics: Equatable, Sendable {
    /// Brews not removed, rated or not.
    let totalBrews: Int
    /// Of those, the rated ones.
    let ratedBrews: Int
    /// The last `StatisticsRules.weekCount` ISO weeks, oldest first, the current week last.
    /// A week without brews is listed with 0.
    let weeks: [WeekCount]
    /// The mean per criterion over all rated brews, in vocabulary order. Empty without
    /// rated brews.
    let tasteProfile: [CriterionMean]
    /// The taste profile per method, for methods with at least
    /// `StatisticsRules.minimumRatedBrews` rated brews, in vocabulary order.
    let methodProfiles: [MethodProfile]
    /// The most-picked notes, most first, at most `StatisticsRules.topFlavourNoteCount`.
    let topFlavourNotes: [FlavourNoteCount]
    let bestMethod: RankedScore<Vocabulary.Method>?
    let bestBean: BestBean?
    /// Nil when no rating answers buy again.
    let buyAgain: BuyAgainShare?

    var hasBrews: Bool { totalBrews > 0 }
    var hasRatedBrews: Bool { ratedBrews > 0 }
}

// MARK: - Computation

extension PersonalStatistics {
    /// A Gregorian calendar with ISO 8601 weeks (Monday first, the first week has at least
    /// four days) in `timeZone`. The app passes the device time zone.
    static func isoWeekCalendar(timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        calendar.minimumDaysInFirstWeek = 4
        calendar.timeZone = timeZone
        return calendar
    }

    /// The statistics of `brews` at `now`, weeks bucketed in `calendar` (use
    /// `isoWeekCalendar(timeZone:)`). Pure: reads nothing else.
    static func compute(_ brews: [StatisticsBrew], now: Date, calendar: Calendar) -> PersonalStatistics {
        let live = brews.filter { brew in !brew.isRemoved }
        let rated = live.filter { brew in brew.rating != nil }
        let ratings = rated.compactMap { brew in brew.rating }

        return PersonalStatistics(
            totalBrews: live.count,
            ratedBrews: rated.count,
            weeks: weeks(of: live, now: now, calendar: calendar),
            tasteProfile: means(of: ratings),
            methodProfiles: methodProfiles(of: rated),
            topFlavourNotes: topFlavourNotes(of: ratings),
            bestMethod: bestMethod(of: rated),
            bestBean: bestBean(of: rated),
            buyAgain: buyAgainShare(of: ratings)
        )
    }

    /// Brews per week for the last `StatisticsRules.weekCount` ISO weeks, oldest first.
    static func weeks(of brews: [StatisticsBrew], now: Date, calendar: Calendar) -> [WeekCount] {
        var result: [WeekCount] = []
        for offset in stride(from: StatisticsRules.weekCount - 1, through: 0, by: -1) {
            guard let day = calendar.date(byAdding: .weekOfYear, value: -offset, to: now),
                  let week = calendar.dateInterval(of: .weekOfYear, for: day) else {
                continue
            }
            let count = brews.filter { brew in brew.brewedAt >= week.start && brew.brewedAt < week.end }.count
            result.append(WeekCount(
                start: week.start,
                weekOfYear: calendar.component(.weekOfYear, from: week.start),
                yearForWeekOfYear: calendar.component(.yearForWeekOfYear, from: week.start),
                count: count
            ))
        }
        return result
    }

    /// The mean of each criterion over the ratings that score it, in vocabulary order. A
    /// criterion no rating scores is left out.
    static func means(of ratings: [RatingValues]) -> [CriterionMean] {
        Vocabulary.Criterion.allCases.compactMap { criterion in
            let scores = ratings.compactMap { rating in rating.score(for: criterion) }
            guard !scores.isEmpty else {
                return nil
            }
            return CriterionMean(criterion: criterion, mean: scores.reduce(0, +) / Double(scores.count), count: scores.count)
        }
    }

    /// The taste profile of each method with enough rated brews.
    static func methodProfiles(of rated: [StatisticsBrew]) -> [MethodProfile] {
        Vocabulary.Method.allCases.compactMap { method in
            let ratings = rated.filter { brew in brew.method == method }.compactMap { brew in brew.rating }
            guard ratings.count >= StatisticsRules.minimumRatedBrews else {
                return nil
            }
            return MethodProfile(method: method, ratedBrews: ratings.count, means: means(of: ratings))
        }
    }

    /// The most-picked notes, a note counted once per rating. Equal counts keep the
    /// vocabulary order, so the list is the same on every run.
    static func topFlavourNotes(of ratings: [RatingValues]) -> [FlavourNoteCount] {
        var counts: [Vocabulary.FlavourNote: Int] = [:]
        for rating in ratings {
            for note in Set(rating.knownFlavourNotes) {
                counts[note, default: 0] += 1
            }
        }
        let ordered = Vocabulary.FlavourNote.allCases.enumerated().compactMap { index, note -> (index: Int, count: FlavourNoteCount)? in
            counts[note].map { count in (index: index, count: FlavourNoteCount(note: note, count: count)) }
        }
        let sorted = ordered.sorted { lhs, rhs in
            lhs.count.count != rhs.count.count ? lhs.count.count > rhs.count.count : lhs.index < rhs.index
        }
        return sorted.prefix(StatisticsRules.topFlavourNoteCount).map { entry in entry.count }
    }

    /// The method with the best mean `overall` score among methods with enough rated brews.
    static func bestMethod(of rated: [StatisticsBrew]) -> RankedScore<Vocabulary.Method>? {
        let order = Dictionary(uniqueKeysWithValues: Vocabulary.Method.allCases.enumerated().map { index, method in (method, index) })
        let samples = rated.compactMap { brew -> (key: Vocabulary.Method, brewedAt: Date, overall: Double)? in
            guard let method = brew.method, let overall = brew.rating?.score(for: .overall) else {
                return nil
            }
            return (key: method, brewedAt: brew.brewedAt, overall: overall)
        }
        return best(of: samples) { lhs, rhs in
            (order[lhs] ?? Int.max) < (order[rhs] ?? Int.max)
        }
    }

    /// The bean with the best mean `overall` score among beans with enough rated brews.
    static func bestBean(of rated: [StatisticsBrew]) -> BestBean? {
        var beans: [UUID: StatisticsBean] = [:]
        let samples = rated.compactMap { brew -> (key: UUID, brewedAt: Date, overall: Double)? in
            guard let bean = brew.bean, let overall = brew.rating?.score(for: .overall) else {
                return nil
            }
            beans[bean.id] = bean
            return (key: bean.id, brewedAt: brew.brewedAt, overall: overall)
        }
        let ranked = best(of: samples) { lhs, rhs in lhs.uuidString < rhs.uuidString }
        guard let winner = ranked, let bean = beans[winner.key] else {
            return nil
        }
        return BestBean(bean: bean, score: winner)
    }

    /// The best key by mean score, among keys with at least
    /// `StatisticsRules.minimumRatedBrews` samples. On an equal mean, more samples win, then
    /// the latest sample; `precedes` only decides a tie on all three, so the result never
    /// depends on the order of `samples`.
    static func best<Key: Hashable & Sendable>(
        of samples: [(key: Key, brewedAt: Date, overall: Double)],
        precedes: (Key, Key) -> Bool
    ) -> RankedScore<Key>? {
        var groups: [Key: (sum: Double, count: Int, latest: Date)] = [:]
        for sample in samples {
            let current = groups[sample.key] ?? (sum: 0, count: 0, latest: Date.distantPast)
            groups[sample.key] = (
                sum: current.sum + sample.overall,
                count: current.count + 1,
                latest: max(current.latest, sample.brewedAt)
            )
        }
        let candidates = groups.compactMap { key, group -> RankedScore<Key>? in
            guard group.count >= StatisticsRules.minimumRatedBrews else {
                return nil
            }
            return RankedScore(key: key, mean: group.sum / Double(group.count), ratedBrews: group.count, latestBrewedAt: group.latest)
        }
        return candidates.min { lhs, rhs in
            ranksAbove(lhs, rhs, precedes: precedes)
        }
    }

    /// Whether `lhs` ranks above `rhs`: higher mean, then more rated brews, then more recent.
    static func ranksAbove<Key: Hashable & Sendable>(_ lhs: RankedScore<Key>, _ rhs: RankedScore<Key>, precedes: (Key, Key) -> Bool) -> Bool {
        if lhs.mean != rhs.mean {
            return lhs.mean > rhs.mean
        }
        if lhs.ratedBrews != rhs.ratedBrews {
            return lhs.ratedBrews > rhs.ratedBrews
        }
        if lhs.latestBrewedAt != rhs.latestBrewedAt {
            return lhs.latestBrewedAt > rhs.latestBrewedAt
        }
        return precedes(lhs.key, rhs.key)
    }

    /// Yes among the ratings that answer buy again, nil when none does.
    static func buyAgainShare(of ratings: [RatingValues]) -> BuyAgainShare? {
        let answers = ratings.compactMap { rating in rating.buyAgain }
        guard !answers.isEmpty else {
            return nil
        }
        return BuyAgainShare(yes: answers.filter { answer in answer }.count, answered: answers.count)
    }
}
