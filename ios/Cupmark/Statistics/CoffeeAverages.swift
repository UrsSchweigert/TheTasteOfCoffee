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
