import Foundation
import SwiftData

// The rating write (M2-T20, docs/04 F3). Like every `AccountStore` write, it changes the
// brew and queues its operation in one save on the caller's actor, so the sync engine, which
// shares the context, never sees half of it (ADR 0025).

extension AccountStore {
    /// Stores `rating` on `brew` and queues it, as a local edit of the brew:
    /// - a brew the server has gets `pendingUpdate`, and `PUT /brews/{brew_id}` is queued
    ///   unless an update that has not been sent yet already carries it (`enqueueEdit(of:)`);
    /// - a brew whose create has not been sent yet keeps that one create, which then carries
    ///   the rating, since the body is built from the stored brew when it is sent.
    ///
    /// The rating must be complete and in the bundled vocabulary (`RatingValues.apiRating()`),
    /// otherwise it throws `incompleteRating` or `unknownVocabularyID` and changes nothing.
    /// The brew's `vocabulary_version` is raised to the bundled version if it was older, since
    /// the rating's ids are picked from it; ids are never removed from a later version
    /// (contracts/vocabulary/CHANGELOG.md). On any failure the unsaved changes are rolled back.
    func rateBrew(_ brew: StoredBrew, rating: RatingValues) throws {
        _ = try rating.apiRating()
        let before = BrewRatingSnapshot(brew)
        do {
            try brew.setRating(rating)
            brew.vocabularyVersion = max(brew.vocabularyVersion, Vocabulary.version)
            try markUpdated(brew)
        } catch {
            before.restore(brew)
            context.rollback()
            throw error
        }
    }
}

/// The fields of a brew that a rating write changes, kept so a failed write can put them back.
///
/// `ModelContext.rollback()` drops inserted models and unsaved operations, but it does not
/// restore an attribute changed on a model that was already saved (seen in the macOS `ios`
/// job). Without this, a failed rating would stay on the brew in memory with no operation
/// queued, and the next unrelated save would store it without ever sending it.
struct BrewRatingSnapshot {
    private let ratingData: Data?
    private let vocabularyVersion: Int
    private let syncStateRaw: String

    init(_ brew: StoredBrew) {
        ratingData = brew.ratingData
        vocabularyVersion = brew.vocabularyVersion
        syncStateRaw = brew.syncStateRaw
    }

    func restore(_ brew: StoredBrew) {
        brew.ratingData = ratingData
        brew.vocabularyVersion = vocabularyVersion
        brew.syncStateRaw = syncStateRaw
    }
}
