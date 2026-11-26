import Foundation

/// The values of a rating while the user sets them (M2-T20, docs/04 F3). The rating screen
/// edits this draft, never a stored model; `RatingFormModel` writes it through
/// `AccountStore.rateBrew` in one step (ADR 0025).
///
/// Every list and number comes from the bundled vocabulary: the criteria, the intensity
/// dimensions and levels and the flavour notes from the generated `Vocabulary` enums, the
/// score scale from `Vocabulary.Ranges.scale`, and the most flavour notes from
/// `Vocabulary.Constants.maxPicks` (`flavour_notes.max_picks`). Nothing is typed
/// (invariant 1).
///
/// - Scores: one per criterion, on the scale and on its half steps. The rating can be saved
///   only when every criterion has one, because the contract's `Scores` requires all of them.
/// - Intensities: optional, one level per dimension.
/// - Flavour notes: optional, in the order picked, never twice, at most `maxFlavourNotes`.
/// - Buy again: optional, yes or no (F3). Not set is nil and is not sent, so an untouched
///   control never counts as "no" in the bean's buy-again share (F4).
struct RatingDraft: Equatable, Sendable {
    /// The scale every criterion is scored on (criteria.scale).
    static var scale: VocabularyRange { Vocabulary.Ranges.scale }

    /// The most flavour notes a rating may have (flavour_notes.max_picks).
    static var maxFlavourNotes: Int { Vocabulary.Constants.maxPicks }

    /// Score by criterion. Set it through `setScore(_:for:)`, which keeps it on the scale.
    private(set) var scores: [Vocabulary.Criterion: API.Score]
    /// Intensity level by dimension; a dimension without a level is not set.
    private(set) var intensities: [Vocabulary.IntensityDimension: Vocabulary.IntensityLevel]
    /// The flavour notes, in the order picked. Change them through `toggle(_:)`.
    private(set) var flavourNotes: [Vocabulary.FlavourNote]
    /// `buy_again`.
    /// `buy_again`: nil while not set, then yes (true) or no (false).
    var buyAgain: Bool?

    /// An empty rating: no score, no intensity, no note, buy again not set.
    init() {
        scores = [:]
        intensities = [:]
        flavourNotes = []
        buyAgain = nil
    }

    /// The values of a stored rating, nil for none. Only what the bundled vocabulary knows is
    /// taken: a score is snapped onto the scale, an unknown id is left out, and notes beyond
    /// the limit are dropped.
    init(_ values: RatingValues?) {
        self.init()
        guard let values else {
            return
        }
        for criterion in Vocabulary.Criterion.allCases {
            setScore(values.score(for: criterion), for: criterion)
        }
        for (dimensionID, levelID) in values.intensities ?? [:] {
            if let dimension = Vocabulary.IntensityDimension(rawValue: dimensionID),
               let level = Vocabulary.IntensityLevel(rawValue: levelID) {
                intensities[dimension] = level
            }
        }
        for note in values.knownFlavourNotes where !flavourNotes.contains(note) && flavourNotes.count < RatingDraft.maxFlavourNotes {
            flavourNotes.append(note)
        }
        buyAgain = values.buyAgain
    }

    // MARK: - Scores

    func score(for criterion: Vocabulary.Criterion) -> API.Score? {
        scores[criterion]
    }

    /// Sets the score of `criterion` to `value`, moved into the scale and onto its nearest
    /// half step, or clears it for nil (or a value that is not finite).
    mutating func setScore(_ value: Double?, for criterion: Vocabulary.Criterion) {
        scores[criterion] = value.flatMap { number in RatingDraft.scale.snapped(number) }
    }

    /// The criteria that have no score yet, in vocabulary order.
    var missingCriteria: [Vocabulary.Criterion] {
        Vocabulary.Criterion.allCases.filter { criterion in scores[criterion] == nil }
    }

    /// Whether every criterion has a score, so the rating can be saved.
    var isComplete: Bool {
        missingCriteria.isEmpty
    }

    // MARK: - Intensities

    func intensity(for dimension: Vocabulary.IntensityDimension) -> Vocabulary.IntensityLevel? {
        intensities[dimension]
    }

    /// Sets the level of `dimension`, or clears it for nil.
    mutating func setIntensity(_ level: Vocabulary.IntensityLevel?, for dimension: Vocabulary.IntensityDimension) {
        intensities[dimension] = level
    }

    // MARK: - Flavour notes

    func isPicked(_ note: Vocabulary.FlavourNote) -> Bool {
        flavourNotes.contains(note)
    }

    /// Whether another note can be picked: fewer than `maxFlavourNotes` are.
    var canPickMoreNotes: Bool {
        flavourNotes.count < RatingDraft.maxFlavourNotes
    }

    /// Whether a tap on `note` does something: a picked note can always be removed, another
    /// only be picked below the limit. The screen disables the others.
    func canToggle(_ note: Vocabulary.FlavourNote) -> Bool {
        isPicked(note) || canPickMoreNotes
    }

    /// Picks `note`, or removes it if it is picked. A pick beyond the limit does nothing.
    /// Returns whether the notes changed.
    @discardableResult
    mutating func toggle(_ note: Vocabulary.FlavourNote) -> Bool {
        if let index = flavourNotes.firstIndex(of: note) {
            flavourNotes.remove(at: index)
            return true
        }
        guard canPickMoreNotes else {
            return false
        }
        flavourNotes.append(note)
        return true
    }

    /// How many of the picked notes belong to `category`.
    func pickedCount(in category: Vocabulary.FlavourCategory) -> Int {
        flavourNotes.filter { note in note.flavourCategory == category }.count
    }

    // MARK: - The rating to store and send

    /// The rating as it is stored (`StoredBrew.ratingData`), nil while a criterion has no
    /// score. No intensity, no note and buy again not set are left out rather than sent
    /// empty or as a default.
    var values: RatingValues? {
        guard isComplete else {
            return nil
        }
        var scoreIDs: [String: Double] = [:]
        for (criterion, score) in scores {
            scoreIDs[criterion.rawValue] = score
        }
        var levelIDs: [String: String] = [:]
        for (dimension, level) in intensities {
            levelIDs[dimension.rawValue] = level.rawValue
        }
        return RatingValues(
            scores: scoreIDs,
            intensities: levelIDs.isEmpty ? nil : levelIDs,
            flavourNotes: flavourNotes.isEmpty ? nil : flavourNotes.map(\.rawValue),
            buyAgain: buyAgain
        )
    }

    /// The contract's `Rating`. Throws `LocalStoreError.incompleteRating` with the criteria
    /// that have no score, so an incomplete rating can never be sent.
    func apiRating() throws -> API.Rating {
        guard let values else {
            throw LocalStoreError.incompleteRating(missing: missingCriteria)
        }
        return try values.apiRating()
    }
}

/// How the rating screen writes a score: with the decimals the scale's step needs (`7.5`,
/// in German `7,5`).
enum RatingFormat {
    static func score(_ value: Double, locale: Locale = .current) -> String {
        BrewFormat.number(value, fractionDigits: BrewFormat.fractionDigits(for: RatingDraft.scale), locale: locale)
    }
}
