import Foundation

// "My brews of this coffee" (M2-T44, ADR 0027 addendum): the user's own averages for one
// shelf entry (one bag), computed on the device from the local store, offline. One pure
// function, `StatisticsRules.coffeeAverages`, over plain values (`StatisticsBrew`), so it is
// tested without SwiftData. The shelf entry screen reads the store and calls it.

/// The community's mean of one criterion and how many raters it rests on (M4). Nothing in
/// the app makes one yet: the row model has the slot so the view needs no new layout, and
/// the view hides it while it is nil.
struct CommunityValue: Equatable, Sendable {
    let mean: Double
    let raters: Int
}

/// One criterion of one coffee: the user's mean over the rated brews that score it.
struct CoffeeAverageRow: Equatable, Sendable, Identifiable {
    let criterion: Vocabulary.Criterion
    /// Unrounded; shown with `StatisticsRules.meanStyle()`.
    let mean: Double
    /// How many of the rated brews score this criterion (fewer than all when an older
    /// vocabulary version had no such criterion).
    let scoredBrews: Int
    /// The bean's community numbers (M4), nil until they exist.
    let community: CommunityValue?

    var id: Vocabulary.Criterion { criterion }

    /// The length of the bar, 0 to 1: the mean as a share of the top of the scale.
    var barFraction: Double {
        Self.barFraction(of: mean)
    }

    static func barFraction(of value: Double) -> Double {
        min(1, max(0, value / Vocabulary.Ranges.scale.maximum))
    }
}

/// The averages of one method on one coffee, for a method with enough rated brews.
struct CoffeeMethodAverages: Equatable, Sendable, Identifiable {
    let method: Vocabulary.Method
    let ratedBrews: Int
    let rows: [CoffeeAverageRow]

    var id: Vocabulary.Method { method }
}

/// What the "My brews of this coffee" section shows.
struct CoffeeAverages: Equatable, Sendable {
    /// Rated brews of the shelf entry, not removed: what everything below rests on.
    let ratedBrews: Int
    /// One row per criterion with at least one score, in vocabulary order. The criteria are
    /// the vocabulary's, `overall` among them, so the mean overall score is the last row.
    let rows: [CoffeeAverageRow]
    /// Methods with at least `StatisticsRules.minimumRatedBrews` rated brews, in vocabulary
    /// order.
    let methods: [CoffeeMethodAverages]

    /// No rated brew: an empty state, never zeros.
    var isEmpty: Bool { ratedBrews == 0 }
    /// Exactly one rated brew: its own values, labelled as one brew, not as an average.
    var isSingleBrew: Bool { ratedBrews == 1 }
    /// Rated, but only on criteria this build's vocabulary does not know.
    var hasNoKnownScores: Bool { ratedBrews > 0 && rows.isEmpty }
    /// The mean overall score, nil while no rated brew scores it.
    var overall: CoffeeAverageRow? {
        rows.first { row in row.criterion == .overall }
    }
    /// The mean overall score for the summary row at the top of the coffee's screen (M2-T48):
    /// nil with no rated brew (no zeros) and while no rated brew scores `overall`.
    var summaryOverall: Double? {
        isEmpty ? nil : overall?.mean
    }
}

// MARK: - The method switcher (M2-T52)

/// What the one averages section of a bag shows: every rated brew, or one method's.
enum CoffeeAveragesChoice: Hashable, Sendable {
    case all
    case method(Vocabulary.Method)
}

/// The rated-brew count and the rows the section shows for one choice.
struct CoffeeAveragesShown: Equatable, Sendable {
    let ratedBrews: Int
    let rows: [CoffeeAverageRow]
}

extension CoffeeAverages {
    /// The options of the switcher: "All Methods" and each method of `methods` (at least
    /// `StatisticsRules.minimumRatedBrews` rated brews), in vocabulary order. Only "All" while
    /// no method qualifies; the view then shows no switcher.
    var choices: [CoffeeAveragesChoice] {
        [.all] + methods.map { entry in CoffeeAveragesChoice.method(entry.method) }
    }

    /// `choice` if it is still offered, else `.all`: a method whose brews were removed drops out.
    func resolved(_ choice: CoffeeAveragesChoice) -> CoffeeAveragesChoice {
        choices.contains(choice) ? choice : .all
    }

    /// The count and rows for `choice` (after `resolved`): `.all` is the unfiltered numbers,
    /// a method is that method's entry. No second computation.
    func shown(for choice: CoffeeAveragesChoice) -> CoffeeAveragesShown {
        if case .method(let method) = resolved(choice), let entry = methods.first(where: { $0.method == method }) {
            return CoffeeAveragesShown(ratedBrews: entry.ratedBrews, rows: entry.rows)
        }
        return CoffeeAveragesShown(ratedBrews: ratedBrews, rows: rows)
    }
}

extension StatisticsRules {
    /// The averages of the rated brews of the shelf entry `shelfEntry` (M2-T44):
    /// - a brew counts if it belongs to that entry (not to another bag of the same bean), has
    ///   a rating, and is not removed on the device (`isRemoved`);
    /// - a rating made with an older vocabulary version counts: a criterion it does not
    ///   score is left out of that criterion's mean only;
    /// - a method is broken out with at least `minimumRatedBrews` rated brews, the same
    ///   threshold as the taste profile of ADR 0027; a brew with a method this build does
    ///   not know counts in the totals only;
    /// - means are not rounded here, `meanStyle()` rounds them when shown;
    /// - `excluding` (M2-T48) leaves one brew out, the brew being rated, so the markers on its
    ///   sliders show the mean of the others; nil leaves none out;
    /// - `community` (M4) is attached to the matching rows; the app passes none yet.
    ///
    /// Pure: reads nothing else.
    static func coffeeAverages(
        of brews: [StatisticsBrew],
        shelfEntry: UUID,
        excluding excluded: UUID? = nil,
        community: [Vocabulary.Criterion: CommunityValue] = [:]
    ) -> CoffeeAverages {
        let rated = brews.filter { brew in
            brew.shelfEntryID == shelfEntry && !brew.isRemoved && brew.rating != nil
                && (excluded == nil || brew.id != excluded)
        }
        let methods = Vocabulary.Method.allCases.compactMap { method -> CoffeeMethodAverages? in
            let ratings = rated.filter { brew in brew.method == method }.compactMap { brew in brew.rating }
            guard ratings.count >= minimumRatedBrews else {
                return nil
            }
            return CoffeeMethodAverages(method: method, ratedBrews: ratings.count, rows: rows(of: ratings, community: [:]))
        }
        return CoffeeAverages(
            ratedBrews: rated.count,
            rows: rows(of: rated.compactMap { brew in brew.rating }, community: community),
            methods: methods
        )
    }

    private static func rows(of ratings: [RatingValues], community: [Vocabulary.Criterion: CommunityValue]) -> [CoffeeAverageRow] {
        PersonalStatistics.means(of: ratings).map { entry in
            CoffeeAverageRow(
                criterion: entry.criterion,
                mean: entry.mean,
                scoredBrews: entry.count,
                community: community[entry.criterion]
            )
        }
    }
}

// MARK: - Averages on the shelf list (M2-T49)

/// A mean overall score and the number of rated brews it rests on.
struct OverallAverage: Equatable, Sendable {
    /// Unrounded; shown with `StatisticsRules.meanStyle()`.
    let mean: Double
    let ratedBrews: Int
}

/// One bag of the shelf as the averages see it: its local id and the local id of its bean.
struct ShelfBag: Equatable, Sendable {
    let entryID: UUID
    /// Nil for a bag without a bean: it has a bag line and never a product line.
    let beanID: UUID?
}

/// What one shelf row shows: the bag's own average and the product's (the bean across all the
/// user's bags of it). Both nil while there is nothing to show; never zeros.
struct ShelfAverages: Equatable, Sendable {
    /// The mean over this bag's rated brews, nil with none.
    let bag: OverallAverage?
    /// The mean over every bag of the same bean, nil with one bag of the bean (it would repeat
    /// the bag line) or with no rated brew in any of them.
    let product: OverallAverage?

    static let none = ShelfAverages(bag: nil, product: nil)
}

extension StatisticsRules {
    /// The mean overall score of every bag in `bags`, and of every bean that has more than one
    /// of them (M2-T49), in one pass over `brews`:
    /// - a brew counts if it belongs to one of `bags`, has a rating that scores `overall`
    ///   (a rating of an older vocabulary version that does not, counts nowhere here), and is
    ///   not removed on the device;
    /// - two bags of one bean combine for the product and stay apart for the bag; brews of other
    ///   beans never count;
    /// - means are not rounded here.
    ///
    /// Pure: reads nothing else. The result has a key for every bag.
    static func shelfAverages(of brews: [StatisticsBrew], bags: [ShelfBag]) -> [UUID: ShelfAverages] {
        var perBag: [UUID: (sum: Double, count: Int)] = [:]
        let known = Set(bags.map(\.entryID))
        for brew in brews where !brew.isRemoved {
            guard let entryID = brew.shelfEntryID, known.contains(entryID),
                let score = brew.rating?.score(for: .overall)
            else {
                continue
            }
            let soFar = perBag[entryID] ?? (0, 0)
            perBag[entryID] = (soFar.sum + score, soFar.count + 1)
        }
        var bagsOfBean: [UUID: [UUID]] = [:]
        for bag in bags {
            if let beanID = bag.beanID {
                bagsOfBean[beanID, default: []].append(bag.entryID)
            }
        }
        var result: [UUID: ShelfAverages] = [:]
        for bag in bags {
            var product: OverallAverage?
            if let beanID = bag.beanID, let siblings = bagsOfBean[beanID], siblings.count > 1 {
                let sums = siblings.compactMap { id in perBag[id] }
                product = average(sum: sums.reduce(0) { $0 + $1.sum }, count: sums.reduce(0) { $0 + $1.count })
            }
            let own = perBag[bag.entryID]
            result[bag.entryID] = ShelfAverages(bag: own.flatMap { average(sum: $0.sum, count: $0.count) }, product: product)
        }
        return result
    }

    private static func average(sum: Double, count: Int) -> OverallAverage? {
        count > 0 ? OverallAverage(mean: sum / Double(count), ratedBrews: count) : nil
    }
}
