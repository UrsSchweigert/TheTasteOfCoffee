import SwiftData
import XCTest
@testable import Cupmark

/// The rating (M2-T20, docs/04 F3): the draft's mapping to `API.Rating`, half-step snapping
/// on the vocabulary's scale, the flavour note limit from the vocabulary constant, that an
/// incomplete set of scores cannot be saved, and the outbox operation a rating queues offline
/// and sends once online. Criteria, dimensions, levels and notes come from the generated
/// enums, the scale and the limit from `Vocabulary.Ranges` and `Vocabulary.Constants`, never
/// from a list typed here.
@MainActor
final class RatingTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private var scale: VocabularyRange { RatingDraft.scale }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    /// A score on the scale for every criterion: the minimum, then one step more for each.
    private func scoredDraft() -> RatingDraft {
        var draft = RatingDraft()
        for (index, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            draft.setScore(scale.minimum + Double(index) * scale.multipleOf, for: criterion)
        }
        return draft
    }

    private func expectedScores() throws -> API.Scores {
        var values: [String: Double] = [:]
        for (index, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            values[criterion.rawValue] = scale.minimum + Double(index) * scale.multipleOf
        }
        return try JSONDecoder().decode(API.Scores.self, from: JSONEncoder().encode(values))
    }

    private func json(_ rating: API.Rating) throws -> [String: Any] {
        let data = try JSONEncoder().encode(rating)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// A synced brew without a rating on a synced shelf entry, as the server has it.
    private func syncedBrew(in store: AccountStore, brewedAt: String = "2026-11-25T08:30:00.123Z") throws -> StoredBrew {
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(brewedAt: brewedAt, rated: false), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    // MARK: - Mapping to Rating

    func testDraftMapsEveryValueToRating() throws {
        var draft = scoredDraft()
        let dimension = try StoreFixtures.first(Vocabulary.IntensityDimension.self)
        let level = try StoreFixtures.last(Vocabulary.IntensityLevel.self)
        draft.setIntensity(level, for: dimension)
        let firstNote = try StoreFixtures.first(Vocabulary.FlavourNote.self)
        let lastNote = try StoreFixtures.last(Vocabulary.FlavourNote.self)
        draft.toggle(lastNote)
        draft.toggle(firstNote)
        draft.buyAgain = true

        var intensities = API.Intensities()
        intensities[dimension] = level
        let expected = API.Rating(
            scores: try expectedScores(),
            intensities: intensities,
            flavourNotes: [lastNote, firstNote],
            buyAgain: true
        )
        XCTAssertEqual(try draft.apiRating(), expected, "notes keep the order they were picked in")
        XCTAssertEqual(try XCTUnwrap(draft.values).flavourNotes, [lastNote.rawValue, firstNote.rawValue])
    }

    func testOptionalPartsAreLeftOutWhileNotSet() throws {
        let draft = scoredDraft()
        XCTAssertNil(draft.buyAgain, "buy again starts as not set, never as no")
        let rating = try draft.apiRating()
        XCTAssertNil(rating.intensities)
        XCTAssertNil(rating.flavourNotes)
        XCTAssertNil(rating.buyAgain)
        XCTAssertNil(try XCTUnwrap(draft.values).buyAgain)

        let encoded = try json(rating)
        XCTAssertEqual(Set(encoded.keys), ["scores"], "no buy_again is sent while it is not set")
        let scores = try XCTUnwrap(encoded["scores"] as? [String: Any])
        XCTAssertEqual(Set(scores.keys), Set(Vocabulary.Criterion.allCases.map(\.rawValue)))
        XCTAssertTrue(Set(encoded.keys).isSubset(of: API.Rating.propertyNames))
    }

    func testBuyAgainIsSentAsYesOrNoOnceSet() throws {
        for answer in [true, false] {
            var draft = scoredDraft()
            draft.buyAgain = answer
            let rating = try draft.apiRating()
            XCTAssertEqual(rating.buyAgain, answer)
            let encoded = try json(rating)
            XCTAssertEqual(Set(encoded.keys), ["scores", "buy_again"])
            XCTAssertEqual(encoded["buy_again"] as? Bool, answer)
            draft.buyAgain = nil
            XCTAssertNil(try json(try draft.apiRating())["buy_again"], "clearing it leaves it out again")
        }
    }

    func testAStoredBuyAgainOpensAsItWasStored() throws {
        var values = RatingValues(try StoreFixtures.rating())
        for stored in [Bool?.none, .some(true), .some(false)] {
            values.buyAgain = stored
            let draft = RatingDraft(values)
            XCTAssertEqual(draft.buyAgain, stored)
            XCTAssertEqual(try draft.apiRating().buyAgain, stored)
        }
    }

    func testAStoredRatingRoundTripsThroughTheDraft() throws {
        let rating = try StoreFixtures.rating()
        let draft = RatingDraft(RatingValues(rating))
        XCTAssertTrue(draft.isComplete)
        XCTAssertEqual(try draft.apiRating(), rating)
        XCTAssertEqual(RatingDraft(nil), RatingDraft())
    }

    func testIdsTheBundledVocabularyDoesNotKnowAreLeftOutWhenARatingIsOpened() throws {
        var values = RatingValues(try StoreFixtures.rating())
        values.flavourNotes = (values.flavourNotes ?? []) + ["not_a_note"]
        values.intensities?["not_a_dimension"] = try StoreFixtures.first(Vocabulary.IntensityLevel.self).rawValue
        let draft = RatingDraft(values)
        XCTAssertEqual(try draft.apiRating(), try StoreFixtures.rating())
    }

    // MARK: - Scale and half steps

    func testTheScaleIsTheBundledCriteriaScale() throws {
        let store = try VocabularyStore.load(from: appBundle)
        XCTAssertEqual(RatingDraft.scale, Vocabulary.Ranges.scale)
        XCTAssertEqual(store.ranges["criteria.scale"], RatingDraft.scale)
        XCTAssertEqual(RatingDraft.scale.multipleOf, 0.5, "F3: half steps")
    }

    func testScoresSnapToTheNearestHalfStepWithinTheScale() throws {
        let criterion = try StoreFixtures.first(Vocabulary.Criterion.self)
        var draft = RatingDraft()
        let cases: [(Double, Double)] = [
            (7.3, 7.5),
            (7.2, 7.0),
            (7.75, 8.0),
            (scale.minimum + scale.multipleOf * 2.4, scale.minimum + scale.multipleOf * 2),
            (scale.maximum + 3, scale.maximum),
            (scale.minimum - 3, scale.minimum),
        ]
        for (input, expected) in cases {
            draft.setScore(input, for: criterion)
            let score = try XCTUnwrap(draft.score(for: criterion), "\(input)")
            XCTAssertEqual(score, expected, accuracy: 1e-9, "\(input)")
            XCTAssertTrue(scale.contains(score), "\(input) lies on the scale")
        }
        draft.setScore(.nan, for: criterion)
        XCTAssertNil(draft.score(for: criterion), "a value that is not finite clears the score")
        draft.setScore(scale.maximum, for: criterion)
        draft.setScore(nil, for: criterion)
        XCTAssertNil(draft.score(for: criterion))
    }

    func testTheSliderStartsInTheMiddleAndATouchSetsTheScore() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let model = RatingFormModel(brew: brew.localID, store: store)
        let criterion = try StoreFixtures.first(Vocabulary.Criterion.self)
        XCTAssertNil(model.scoreText(for: criterion))
        XCTAssertEqual(model.sliderValue(for: criterion), scale.middle, accuracy: 1e-9)

        model.beginSliding(criterion)
        XCTAssertEqual(model.draft.score(for: criterion), scale.middle, "a touch without a move sets the value shown")
        model.setSliderValue(8.3, for: criterion)
        XCTAssertEqual(model.draft.score(for: criterion), 8.5)
        XCTAssertEqual(model.scoreText(for: criterion, locale: Locale(identifier: "en_US")), "8.5")
        XCTAssertEqual(model.scoreText(for: criterion, locale: Locale(identifier: "de_DE")), "8,5")
        model.beginSliding(criterion)
        XCTAssertEqual(model.draft.score(for: criterion), 8.5, "touching a set slider keeps its score")
    }

    // MARK: - Questions

    func testEveryCriterionHasItsQuestionInEveryLanguage() throws {
        let store = try VocabularyStore.load(from: appBundle)
        XCTAssertTrue(Vocabulary.Namespace.criteria.hasQuestions)
        for language in VocabularyLanguage.allCases {
            for criterion in Vocabulary.Criterion.allCases {
                let question = try store.question(namespace: Vocabulary.Criterion.namespace, id: criterion.rawValue, language: language)
                XCTAssertFalse(question.isEmpty, "\(criterion.rawValue) in \(language.rawValue)")
            }
        }
    }

    // MARK: - The flavour note limit

    func testTheLimitIsTheVocabularyConstant() throws {
        let store = try VocabularyStore.load(from: appBundle)
        XCTAssertEqual(RatingDraft.maxFlavourNotes, Vocabulary.Constants.maxPicks)
        XCTAssertEqual(store.value(at: "flavour_notes.max_picks"), .number(Double(RatingDraft.maxFlavourNotes)))
        XCTAssertGreaterThan(Vocabulary.FlavourNote.allCases.count, RatingDraft.maxFlavourNotes)
    }

    func testFurtherPicksAreRefusedAtTheLimit() throws {
        let notes = Vocabulary.FlavourNote.allCases
        var draft = RatingDraft()
        for note in notes.prefix(RatingDraft.maxFlavourNotes) {
            XCTAssertTrue(draft.canToggle(note))
            XCTAssertTrue(draft.toggle(note))
        }
        XCTAssertEqual(draft.flavourNotes.count, RatingDraft.maxFlavourNotes)
        XCTAssertFalse(draft.canPickMoreNotes)

        let further = notes[RatingDraft.maxFlavourNotes]
        XCTAssertFalse(draft.canToggle(further), "the screen disables it")
        XCTAssertFalse(draft.toggle(further))
        XCTAssertFalse(draft.isPicked(further))
        XCTAssertEqual(draft.flavourNotes, Array(notes.prefix(RatingDraft.maxFlavourNotes)))

        let picked = notes[0]
        XCTAssertTrue(draft.canToggle(picked), "a picked note can always be removed")
        XCTAssertTrue(draft.toggle(picked))
        XCTAssertFalse(draft.isPicked(picked))
        XCTAssertTrue(draft.canToggle(further))
        XCTAssertTrue(draft.toggle(further))
        XCTAssertEqual(draft.flavourNotes.count, RatingDraft.maxFlavourNotes)
    }

    func testAStoredRatingWithTooManyNotesKeepsTheFirstOnes() throws {
        var values = RatingValues(try StoreFixtures.rating())
        let notes = Vocabulary.FlavourNote.allCases.prefix(RatingDraft.maxFlavourNotes + 2).map(\.rawValue)
        values.flavourNotes = notes + [notes[0]]
        let draft = RatingDraft(values)
        XCTAssertEqual(draft.flavourNotes.map(\.rawValue), Array(notes.prefix(RatingDraft.maxFlavourNotes)))
    }

    func testNotesCountPerCategory() throws {
        let category = try StoreFixtures.first(Vocabulary.FlavourCategory.self)
        let notes = category.flavourNotes
        XCTAssertFalse(notes.isEmpty)
        var draft = RatingDraft()
        draft.toggle(notes[0])
        draft.toggle(try StoreFixtures.last(Vocabulary.FlavourNote.self))
        XCTAssertEqual(draft.pickedCount(in: category), 1)
        XCTAssertTrue(notes.allSatisfy { note in note.flavourCategory == category })
    }

    // MARK: - An incomplete set of scores

    func testAnIncompleteSetOfScoresCannotBeSaved() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let model = RatingFormModel(brew: brew.localID, store: store)
        let criteria = Vocabulary.Criterion.allCases
        let missing = try StoreFixtures.last(Vocabulary.Criterion.self)
        for criterion in criteria where criterion != missing {
            model.setSliderValue(scale.maximum, for: criterion)
        }

        XCTAssertFalse(model.draft.isComplete)
        XCTAssertEqual(model.draft.missingCriteria, [missing])
        XCTAssertNil(model.draft.values)
        XCTAssertThrowsError(try model.draft.apiRating()) { error in
            XCTAssertEqual(error as? LocalStoreError, .incompleteRating(missing: [missing]))
        }
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.save())
        XCTAssertEqual(model.failure, .incomplete)
        XCTAssertNil(brew.rating)
        XCTAssertEqual(brew.syncState, .synced)
        XCTAssertTrue(try queue(store).isEmpty)

        // The store refuses one too, and changes nothing.
        var partial = RatingValues(try StoreFixtures.rating())
        partial.scores[missing.rawValue] = nil
        XCTAssertThrowsError(try store.rateBrew(brew, rating: partial))
        XCTAssertNil(brew.rating)
        XCTAssertTrue(try queue(store).isEmpty)

        model.setSliderValue(scale.minimum, for: missing)
        XCTAssertNil(model.failure, "the note goes once every criterion has a score")
        XCTAssertTrue(model.canSave)
        XCTAssertTrue(model.save())
    }

    // MARK: - The outbox, offline

    func testRatingASyncedBrewOfflineQueuesOneUpdate() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let model = RatingFormModel(brew: brew.localID, store: store)
        XCTAssertFalse(model.wasRated)
        model.draft = scoredDraft()
        model.draft.buyAgain = true

        XCTAssertTrue(model.save())

        XCTAssertEqual(try queue(store), ["update brew"], "PUT /brews/{brew_id}, no create")
        XCTAssertEqual(brew.syncState, .pendingUpdate)
        let input = try brew.apiInput()
        XCTAssertEqual(input.rating, try model.draft.apiRating())
        XCTAssertEqual(input.parameters, try StoreFixtures.parameters(), "the brew's parameters are kept")
        XCTAssertEqual(input.vocabularyVersion, Vocabulary.version)
        // Saved with the operation: a second context on the same container reads both.
        let other = ModelContext(store.container)
        XCTAssertEqual(try other.fetch(FetchDescriptor<OutboxOperation>()).count, 1)
        XCTAssertNotNil(try other.fetch(FetchDescriptor<StoredBrew>()).first?.ratingData)

        // A second change before it was sent shares that update.
        let again = RatingFormModel(brew: brew.localID, store: store)
        XCTAssertTrue(again.wasRated)
        XCTAssertEqual(again.draft, model.draft, "a rated brew opens with its rating")
        again.draft.buyAgain = false
        XCTAssertTrue(again.save())
        XCTAssertEqual(try queue(store), ["update brew"])
        XCTAssertEqual(try brew.apiInput().rating?.buyAgain, false)
    }

    func testRatingABrewNotSentYetRidesOnItsCreate() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(rated: false))
        try store.addBrew(brew, shelfEntry: entry)
        let model = RatingFormModel(brew: brew.localID, store: store)
        model.draft = scoredDraft()

        XCTAssertTrue(model.save())

        XCTAssertEqual(try queue(store), ["create brew"], "the create is built when it is sent, so it carries the rating")
        XCTAssertEqual(brew.syncState, .pendingCreate)
        XCTAssertEqual(try brew.apiInput().rating, try model.draft.apiRating())
    }

    func testARatingMadeOfflineIsSentAsPutOnceOnline() async throws {
        let store = try AccountStore.inMemory()
        // Held for the whole test: the stub registry keeps servers weakly.
        let server = try FakeSyncServer()
        let clock = TestClock()
        let engine = SyncEngine(
            store: store,
            client: server.client(),
            now: { clock.now },
            jitter: { 1 },
            sleep: { _ in },
            isCurrentAccount: { true }
        )
        let bean = try StoreFixtures.bean()
        server.backend.seed(bean: bean)
        server.backend.seed(shelfEntry: StoreFixtures.shelfEntryID, try StoreFixtures.shelfEntryInput())
        let unrated = try StoreFixtures.brewInput(rated: false)
        server.backend.seed(brew: StoreFixtures.brewID, unrated)
        let brew = try syncedBrew(in: store)

        let model = RatingFormModel(brew: brew.localID, store: store)
        model.draft = scoredDraft()
        let rating = try model.draft.apiRating()
        XCTAssertTrue(model.save())

        // Offline: the update stays queued.
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let offline = await engine.drain()
        guard case .waiting = offline else {
            return XCTFail("expected a retry, got \(offline)")
        }
        XCTAssertEqual(try queue(store), ["update brew"])
        XCTAssertEqual(brew.syncState, .pendingUpdate)

        // Online again.
        server.backend.setOverride(nil)
        clock.advance(300)
        let online = await engine.drain()

        XCTAssertEqual(online, .idle)
        XCTAssertEqual(server.log, ["PUT /brews/\(StoreFixtures.brewID)", "PUT /brews/\(StoreFixtures.brewID)"])
        let sent = try JSONDecoder().decode(API.BrewInput.self, from: XCTUnwrap(server.requests.last?.body))
        XCTAssertEqual(sent.rating, rating)
        XCTAssertEqual(sent.parameters, unrated.parameters)
        XCTAssertEqual(server.backend.storedBrews[StoreFixtures.brewID]?.rating, rating)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertEqual(brew.syncState, .synced)
        withExtendedLifetime(server) {}
    }

    // MARK: - The model

    func testAnUnratedBrewOffersTheLastRatingOfTheBag() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let earlier = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-24T08:00:00.000Z", rated: true), serverID: StoreFixtures.brewID)
        try store.addBrew(earlier, shelfEntry: entry, syncState: .synced)
        let later = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-26T08:00:00.000Z", rated: false))
        try store.addBrew(later, shelfEntry: entry)
        let current = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z", rated: false))
        try store.addBrew(current, shelfEntry: entry)

        let model = RatingFormModel(brew: current.localID, store: store)
        XCTAssertTrue(model.offersLastRating)
        XCTAssertFalse(model.canSave)
        model.useLastRating()
        XCTAssertEqual(try model.draft.apiRating(), try StoreFixtures.rating())
        XCTAssertTrue(model.canSave)
        XCTAssertTrue(model.save())
        XCTAssertFalse(model.offersLastRating)

        // The earlier brew has nothing earlier to offer, and a rated brew offers nothing.
        XCTAssertFalse(RatingFormModel(brew: earlier.localID, store: store).offersLastRating)
        XCTAssertFalse(RatingFormModel(brew: current.localID, store: store).offersLastRating)
    }

    func testARemovedBrewCannotBeRated() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let model = RatingFormModel(brew: brew.localID, store: store)
        model.draft = scoredDraft()
        try store.markDeleted(brew)

        XCTAssertFalse(model.save())

        XCTAssertEqual(model.failure, .notFound)
        XCTAssertNil(brew.rating)
        XCTAssertEqual(try queue(store), ["delete brew"])
        XCTAssertEqual(RatingFormModel(brew: brew.localID, store: store).failure, .notFound)
    }

    func testAFailedSaveLeavesNothingBehind() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let model = RatingFormModel(brew: brew.localID, store: store, rate: { _, brew, rating in
            try brew.setRating(rating)
            throw LocalStoreError.invalidDate
        })
        model.draft = scoredDraft()

        XCTAssertFalse(model.save())

        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertTrue(model.canSave, "the user can try again")
        XCTAssertNil(brew.rating, "the change was rolled back")
        XCTAssertTrue(try queue(store).isEmpty)
    }

    // MARK: - The brew list

    func testTheBrewListShowsTheEntrysBrewsNewestFirstAndWhetherTheyAreRated() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let older = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-24T08:00:00.000Z", rated: true))
        try store.addBrew(older, shelfEntry: entry)
        let newer = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z", rated: false))
        try store.addBrew(newer, shelfEntry: entry)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)

        list.reload()

        XCTAssertEqual(list.rows.map(\.id), [newer.localID, older.localID])
        XCTAssertEqual(list.rows.map(\.isRated), [false, true])
        XCTAssertEqual(list.rows.first?.method, try StoreFixtures.parameters().method)
        XCTAssertFalse(list.entryMissing)

        try store.markDeleted(newer)
        list.reload()
        XCTAssertEqual(list.rows.map(\.id), [older.localID], "a removed brew is not listed")
    }
}
