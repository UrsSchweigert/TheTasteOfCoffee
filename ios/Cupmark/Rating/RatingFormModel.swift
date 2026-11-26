import Foundation
import Observation

/// Rating one brew (M2-T20, docs/04 F3), right after it was logged or later from the brew
/// list.
///
/// - The screen edits `draft`, never the stored brew. `save()` stores the rating and queues
///   it through `AccountStore.rateBrew` in one save, so it works offline: a brew the server
///   has goes out as `PUT /brews/{brew_id}`, a brew not sent yet in its own create
///   (ADR 0025).
/// - A brew that already has a rating opens with it. Saving it unchanged writes nothing, so
///   no update is queued.
/// - A brew stored with a newer vocabulary than the bundled one (picked on a newer app) opens
///   read-only (`isReadOnly`): the draft keeps only the ids this build knows, so saving it
///   could drop flavour notes or intensities it does not know.
/// - An unrated brew offers an earlier rating (`lastRating`, from `lastRatingSource`), which
///   `useLastRating()` copies into the draft. A repeat brew then needs only the changes, not
///   eight new scores. It is never copied without that tap. The offer is the newest rating of
///   an earlier brew of the same bag; else of the same bean on any bag; else, for a brew
///   started as a repeat of the last brew, that brew's rating (ADR 0026, Addendum M2-T27).
///   A later brew's rating is never offered.
@MainActor
@Observable
final class RatingFormModel {
    /// Where the offered rating comes from; the screen says so.
    enum RatingSource: Equatable, Sendable {
        /// An earlier brew of the same shelf entry.
        case sameBag
        /// An earlier brew of the same bean, on another shelf entry.
        case sameBean
        /// The brew this one repeated (`BrewFormModel.copiedBrewID`).
        case repeatedBrew
    }

    enum Failure: Equatable, Sendable {
        /// The brew is gone (removed here, or on another device and pulled).
        case notFound
        /// A criterion has no score; the contract's `Scores` requires all of them.
        case incomplete
        /// The local store could not save; nothing was changed.
        case saveFailed
    }

    let brewLocalID: UUID
    let store: AccountStore
    var draft: RatingDraft
    private(set) var bean: ShelfBeanSummary
    private(set) var method: Vocabulary.Method?
    private(set) var brewedAt: Date?
    /// Whether the brew had a rating when the screen opened.
    private(set) var wasRated: Bool
    /// The rating offered while the brew has none (see `lastRatingSource`).
    private(set) var lastRating: RatingValues?
    /// Where `lastRating` comes from, nil without an offer.
    private(set) var lastRatingSource: RatingSource?
    private(set) var failure: Failure?
    /// Whether the rating was saved at least once.
    private(set) var didSave = false
    /// The brew's `vocabulary_version` is newer than the bundled one: the rating is shown but
    /// cannot be changed.
    private(set) var isReadOnly = false

    /// Stores the rating and saves (`AccountStore.rateBrew`). Tests replace it to make the
    /// write fail.
    private let rate: (AccountStore, StoredBrew, RatingValues) throws -> Void

    /// `repeatedFrom` is the brew a repeat copied (M2-T27), nil for any other brew.
    init(
        brew localID: UUID,
        store: AccountStore,
        repeatedFrom: UUID? = nil,
        rate: @escaping (AccountStore, StoredBrew, RatingValues) throws -> Void = { store, brew, rating in
            try store.rateBrew(brew, rating: rating)
        }
    ) {
        brewLocalID = localID
        self.store = store
        self.rate = rate
        let brew = try? store.brew(localID: localID)
        if let brew, brew.syncState != .pendingDelete {
            bean = ShelfBeanSummary(brew.shelfEntry?.bean)
            method = brew.method
            brewedAt = brew.brewedAt
            let stored = brew.rating
            wasRated = stored != nil
            draft = RatingDraft(stored)
            let readOnly = RatingFormModel.isNewer(brew)
            isReadOnly = readOnly
            let offer = stored == nil && !readOnly
                ? RatingFormModel.offeredRating(for: brew, store: store, repeatedFrom: repeatedFrom)
                : nil
            lastRating = offer?.rating
            lastRatingSource = offer?.source
            failure = nil
        } else {
            bean = ShelfBeanSummary(nil)
            method = nil
            brewedAt = nil
            wasRated = false
            draft = RatingDraft()
            lastRating = nil
            lastRatingSource = nil
            failure = .notFound
        }
    }

    /// The rating of the newest other brew of the same shelf entry brewed no later than
    /// `brew`, nil if none of them is rated.
    static func latestEarlierRating(of brew: StoredBrew) -> RatingValues? {
        guard let entry = brew.shelfEntry else {
            return nil
        }
        let earlier = entry.liveBrewsNewestFirst.first { other in
            other.localID != brew.localID
                && other.brewedAtMilliseconds <= brew.brewedAtMilliseconds
                && other.rating != nil
        }
        return earlier?.rating
    }

    /// The rating offered to `brew`, with where it comes from: the newest rating of an earlier
    /// brew of the same shelf entry; else of the same bean on any shelf entry; else the rating
    /// of `repeatedFrom`, the brew it repeated. Every candidate is another brew, not removed,
    /// brewed no later than `brew`. Nil when there is none.
    static func offeredRating(
        for brew: StoredBrew,
        store: AccountStore,
        repeatedFrom: UUID?
    ) -> (rating: RatingValues, source: RatingSource)? {
        if let rating = latestEarlierRating(of: brew) {
            return (rating, .sameBag)
        }
        if let beanID = brew.shelfEntry?.bean?.localID {
            let sameBean = ((try? store.brewsNewestFirst()) ?? []).first { other in
                other.shelfEntry?.bean?.localID == beanID && isEarlierRated(other, than: brew)
            }
            if let rating = sameBean?.rating {
                return (rating, .sameBean)
            }
        }
        if let repeatedFrom,
           let repeated = try? store.brew(localID: repeatedFrom),
           repeated.syncState != .pendingDelete,
           isEarlierRated(repeated, than: brew),
           let rating = repeated.rating {
            return (rating, .repeatedBrew)
        }
        return nil
    }

    /// Whether `other` is another brew than `brew`, brewed no later, with a rating.
    private static func isEarlierRated(_ other: StoredBrew, than brew: StoredBrew) -> Bool {
        other.localID != brew.localID
            && other.brewedAtMilliseconds <= brew.brewedAtMilliseconds
            && other.rating != nil
    }

    /// Whether "Start from the last rating" is offered: the brew has no rating of its own
    /// yet and one of the three sources has one (the bag, the same coffee on any bag, or the
    /// repeated brew; ADR 0026, addendum M2-T27).
    var offersLastRating: Bool {
        lastRating != nil && failure != .notFound && !isReadOnly
    }

    /// Whether `brew` was stored with a newer vocabulary than this build bundles.
    static func isNewer(_ brew: StoredBrew) -> Bool {
        brew.vocabularyVersion > Vocabulary.version
    }

    /// Copies the last rating of the bag into the draft (only what the bundled vocabulary
    /// knows; see `RatingDraft.init(_:)`).
    func useLastRating() {
        guard let lastRating else {
            return
        }
        draft = RatingDraft(lastRating)
        if failure == .incomplete, draft.isComplete {
            failure = nil
        }
    }

    /// Whether `save()` would write: every criterion has a score and the brew exists.
    var canSave: Bool {
        draft.isComplete && failure != .notFound && !isReadOnly
    }

    // MARK: - Controls

    /// The text of a criterion's score, nil while it has none.
    func scoreText(for criterion: Vocabulary.Criterion, locale: Locale = .current) -> String? {
        draft.score(for: criterion).map { score in RatingFormat.score(score, locale: locale) }
    }

    /// Where a criterion's slider stands: its score, or the middle of the scale while it has
    /// none (the slider then shows "Not set" next to it).
    func sliderValue(for criterion: Vocabulary.Criterion) -> Double {
        draft.score(for: criterion) ?? RatingDraft.scale.middle
    }

    /// The slider moved: the score is snapped onto the scale's half steps.
    func setSliderValue(_ value: Double, for criterion: Vocabulary.Criterion) {
        draft.setScore(value, for: criterion)
        clearIncompleteOnceComplete()
    }

    /// The slider was touched: a criterion without a score takes the value the slider shows,
    /// so a touch without a move sets it too.
    func beginSliding(_ criterion: Vocabulary.Criterion) {
        if draft.score(for: criterion) == nil {
            draft.setScore(sliderValue(for: criterion), for: criterion)
            clearIncompleteOnceComplete()
        }
    }

    func toggle(_ note: Vocabulary.FlavourNote) {
        draft.toggle(note)
    }

    private func clearIncompleteOnceComplete() {
        if failure == .incomplete, draft.isComplete {
            failure = nil
        }
    }

    // MARK: - Writes

    /// Stores the rating on the brew and queues it. Returns whether it was written; when not,
    /// `failure` says why.
    @discardableResult
    func save() -> Bool {
        guard failure != .notFound, !isReadOnly else {
            return false
        }
        guard let values = draft.values else {
            failure = .incomplete
            return false
        }
        do {
            guard let brew = try store.brew(localID: brewLocalID), brew.syncState != .pendingDelete else {
                failure = .notFound
                return false
            }
            guard !RatingFormModel.isNewer(brew) else {
                isReadOnly = true
                return false
            }
            if brew.rating == values {
                // Nothing changed: no write, so no update is queued or sent.
                failure = nil
                return true
            }
            // A failed write puts the brew's saved fields back (`AccountStore.write`), so
            // nothing half-made stays in the shared context for the engine to save.
            try store.write {
                try rate(store, brew, values)
            }
            failure = nil
            didSave = true
            wasRated = true
            lastRating = nil
            lastRatingSource = nil
            return true
        } catch {
            failure = .saveFailed
            return false
        }
    }

    /// Reads the brew again (a pull may have removed it).
    func refresh() {
        guard let brew = try? store.brew(localID: brewLocalID), brew.syncState != .pendingDelete else {
            failure = .notFound
            return
        }
        bean = ShelfBeanSummary(brew.shelfEntry?.bean)
        method = brew.method
        brewedAt = brew.brewedAt
        if RatingFormModel.isNewer(brew) {
            isReadOnly = true
            lastRating = nil
            lastRatingSource = nil
        }
        if failure == .notFound {
            failure = nil
        }
    }
}
