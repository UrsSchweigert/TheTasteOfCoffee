import SwiftData
import XCTest
@testable import Cupmark

/// Stored values are contract ids, read through the `Vocabulary` types, and convert to and
/// from the generated API types without loss.
final class StoredValuesTests: XCTestCase {
    /// An id no vocabulary version has: ids are lower snake case, this is not.
    private let unknownID = "Not-A-Contract-Id"

    // MARK: - Round trips

    func testABrewRoundTripsThroughTheAPIType() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let input = try StoreFixtures.brewInput()
        let brew = try StoredBrew(input)
        try store.addBrew(brew, shelfEntry: entry)

        XCTAssertEqual(try brew.apiInput(), input)
        XCTAssertEqual(brew.method, input.parameters.method)
        XCTAssertEqual(brew.methodID, input.parameters.method.rawValue)
        XCTAssertEqual(brew.waterType, input.parameters.waterType)
        XCTAssertEqual(brew.milk, input.parameters.milk)
        XCTAssertEqual(brew.waterTemperature, input.parameters.waterTemperature)
        XCTAssertEqual(brew.doseDg, input.parameters.doseDg)
        XCTAssertEqual(brew.brewedAtMilliseconds, input.brewedAt.millisecondsSince1970)
    }

    func testAnUnratedBrewRoundTrips() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let input = try StoreFixtures.brewInput(rated: false)
        let brew = try StoredBrew(input)
        try store.addBrew(brew, shelfEntry: entry)
        XCTAssertNil(brew.ratingData)
        XCTAssertNil(brew.rating)
        XCTAssertEqual(try brew.apiInput(), input)
    }

    func testAStoredRatingHoldsIdsAndRoundTrips() throws {
        let rating = try StoreFixtures.rating()
        let values = RatingValues(rating)
        XCTAssertEqual(Set(values.scores.keys), Set(Vocabulary.Criterion.allCases.map(\.rawValue)))
        for criterion in Vocabulary.Criterion.allCases {
            XCTAssertEqual(values.score(for: criterion), rating.scores[criterion])
        }
        XCTAssertEqual(values.flavourNotes, rating.flavourNotes?.map(\.rawValue))
        XCTAssertEqual(values.knownFlavourNotes, rating.flavourNotes)
        XCTAssertEqual(try values.apiRating(), rating)

        let data = try XCTUnwrap(RatingValues.encoded(values))
        XCTAssertEqual(RatingValues.decoded(data), values)
    }

    func testAShelfEntryRoundTripsThroughTheAPIType() throws {
        let store = try AccountStore.inMemory()
        let input = try StoreFixtures.shelfEntryInput()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        XCTAssertEqual(try entry.apiInput(), input)
        XCTAssertEqual(entry.purchaseDate, input.purchaseDate)
        XCTAssertEqual(entry.roastDate, input.roastDate)
        XCTAssertEqual(entry.bagSize, input.bagSize)
        XCTAssertEqual(entry.priceBand, input.priceBand)

        let unroasted = StoredShelfEntry(try StoreFixtures.shelfEntryInput(roastDate: nil))
        XCTAssertNil(unroasted.roastDateRaw)
        XCTAssertNil(unroasted.roastDate)
    }

    func testABeanRoundTripsThroughTheAPIType() throws {
        let bean = try StoreFixtures.bean()
        let stored = StoredBean(bean)
        XCTAssertEqual(try stored.apiBean(), bean)
        XCTAssertEqual(stored.pickedAttributes, bean.pickedAttributes)
        XCTAssertEqual(stored.operatorAttributes, bean.operatorAttributes)
        XCTAssertEqual(stored.serverID, bean.beanId)

        var withoutProduct = bean
        withoutProduct.openFoodFacts = nil
        XCTAssertEqual(try StoredBean(withoutProduct).apiBean(), withoutProduct)
    }

    func testABeanMadeOnTheDeviceBecomesItsCreateBody() throws {
        let create = API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: "4006381333931",
            openFoodFactsConfirmed: true,
            attributes: API.BeanAttributes(
                process: try StoreFixtures.last(Vocabulary.Process.self),
                origin: try StoreFixtures.first(Vocabulary.Origin.self)
            )
        )
        let bean = StoredBean(create)
        XCTAssertNil(bean.serverID)
        XCTAssertEqual(try bean.apiCreate(), create)
        XCTAssertThrowsError(try bean.apiBean()) { error in
            XCTAssertEqual(error as? LocalStoreError, .missingServerID)
        }
    }

    func testARecipeAndTheProfileRoundTrip() throws {
        let recipeInput = API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())
        XCTAssertEqual(try StoredRecipe(recipeInput, serverID: StoreFixtures.recipeID).apiInput(), recipeInput)

        let language = try XCTUnwrap(VocabularyLanguage.allCases.last)
        let profile = API.Profile(locale: language, consent: API.Consent(contributeToAggregates: true))
        let stored = StoredProfile(profile)
        XCTAssertEqual(stored.locale, language)
        XCTAssertEqual(try stored.apiProfile(), profile)
    }

    // MARK: - Unknown ids

    func testAnUnknownIdReadsAsNilIsKeptAndIsNeverSent() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try store.addBrew(brew, shelfEntry: entry)

        brew.methodID = unknownID
        brew.waterTypeID = unknownID
        try store.save()

        let stored = try XCTUnwrap(try store.brewsNewestFirst().first)
        XCTAssertNil(stored.method)
        XCTAssertNil(stored.waterType)
        XCTAssertEqual(stored.methodID, unknownID)
        XCTAssertEqual(stored.waterTypeID, unknownID)
        XCTAssertThrowsError(try stored.apiInput()) { error in
            XCTAssertEqual(error as? LocalStoreError, .unknownVocabularyID(namespace: .methods, id: unknownID))
        }
    }

    func testUnknownIdsInEveryModelReadAsNil() throws {
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        entry.bagSizeID = unknownID
        entry.priceBandID = unknownID
        XCTAssertNil(entry.bagSize)
        XCTAssertNil(entry.priceBand)

        let bean = StoredBean(try StoreFixtures.bean())
        bean.pickedProcessID = unknownID
        XCTAssertNil(bean.pickedAttributes.process)
        XCTAssertThrowsError(try bean.apiBean()) { error in
            XCTAssertEqual(error as? LocalStoreError, .unknownVocabularyID(namespace: .processes, id: unknownID))
        }

        let recipe = StoredRecipe(methodID: unknownID)
        recipe.waterTempSpecialID = unknownID
        XCTAssertNil(recipe.method)
        XCTAssertNil(recipe.waterTemperature)

        let profile = StoredProfile(localeID: unknownID, contributeToAggregates: false)
        XCTAssertNil(profile.locale)
        XCTAssertThrowsError(try profile.apiProfile()) { error in
            XCTAssertEqual(error as? LocalStoreError, .unknownLanguage(unknownID))
        }
    }

    func testARatingWithAnUnknownNoteKeepsItButIsNotSent() throws {
        var values = RatingValues(try StoreFixtures.rating())
        values.flavourNotes = (values.flavourNotes ?? []) + [unknownID]
        XCTAssertEqual(values.knownFlavourNotes, try StoreFixtures.rating().flavourNotes)
        XCTAssertThrowsError(try values.apiRating()) { error in
            XCTAssertEqual(error as? LocalStoreError, .unknownVocabularyID(namespace: .flavourNotes, id: unknownID))
        }
    }

    func testARatingWithoutEveryScoreIsNotSent() throws {
        XCTAssertThrowsError(try RatingValues(scores: [:]).apiRating()) { error in
            XCTAssertEqual(error as? LocalStoreError, .incompleteRating(missing: Vocabulary.Criterion.allCases))
        }
        var values = RatingValues(try StoreFixtures.rating())
        values.scores[unknownID] = 5
        XCTAssertThrowsError(try values.apiRating()) { error in
            XCTAssertEqual(error as? LocalStoreError, .unknownVocabularyID(namespace: .criteria, id: unknownID))
        }
    }

    // MARK: - References and values

    func testABrewIsNotSentBeforeItsShelfEntryHasAServerID() throws {
        let store = try AccountStore.inMemory()
        let bean = StoredBean(try StoreFixtures.bean())
        try store.addBean(bean, syncState: .synced)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try store.addShelfEntry(entry, bean: bean)
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try store.addBrew(brew, shelfEntry: entry)

        XCTAssertThrowsError(try brew.apiInput()) { error in
            XCTAssertEqual(error as? LocalStoreError, .missingServerID)
        }
        entry.serverID = StoreFixtures.shelfEntryID
        XCTAssertEqual(try brew.apiInput().shelfEntryId, StoreFixtures.shelfEntryID)

        let orphan = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        XCTAssertThrowsError(try orphan.apiInput()) { error in
            XCTAssertEqual(error as? LocalStoreError, .missingServerID)
        }
    }

    func testSettingOneWaterTemperatureClearsTheOther() throws {
        let recipe = StoredRecipe(methodID: try StoreFixtures.first(Vocabulary.Method.self).rawValue)
        let special = try StoreFixtures.first(Vocabulary.WaterTempSpecial.self)
        recipe.waterTemperature = .celsius(92)
        XCTAssertEqual(recipe.waterTempC, 92)
        XCTAssertNil(recipe.waterTempSpecialID)
        recipe.waterTemperature = .special(special)
        XCTAssertNil(recipe.waterTempC)
        XCTAssertEqual(recipe.waterTempSpecialID, special.rawValue)
        XCTAssertEqual(try recipe.apiParameters().waterTemperature, .special(special))
        recipe.waterTemperature = nil
        XCTAssertNil(recipe.waterTempC)
        XCTAssertNil(recipe.waterTempSpecialID)
    }

    func testBothWaterTemperatureColumnsSetIsNeverSent() throws {
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters()))
        recipe.waterTempC = 94
        recipe.waterTempSpecialID = try StoreFixtures.first(Vocabulary.WaterTempSpecial.self).rawValue
        XCTAssertThrowsError(try recipe.apiParameters()) { error in
            XCTAssertEqual(error as? LocalStoreError, .conflictingWaterTemperature)
        }
        XCTAssertThrowsError(try recipe.apiInput()) { error in
            XCTAssertEqual(error as? LocalStoreError, .conflictingWaterTemperature)
        }
    }

    func testARatingWithANonFiniteScoreThrowsAndKeepsThePreviousRating() throws {
        let input = try StoreFixtures.brewInput()
        let brew = try StoredBrew(input)
        let previous = try XCTUnwrap(brew.rating)
        let criterion = try StoreFixtures.first(Vocabulary.Criterion.self)

        for score in [Double.nan, .infinity, -.infinity] {
            var values = previous
            values.scores[criterion.rawValue] = score
            XCTAssertThrowsError(try brew.setRating(values)) { error in
                XCTAssertEqual(error as? LocalStoreError, .nonFiniteScore(id: criterion.rawValue))
            }
            XCTAssertEqual(brew.rating, previous)
            XCTAssertThrowsError(try RatingValues.encoded(values))
        }

        try brew.setRating(nil)
        XCTAssertNil(brew.ratingData)
        try brew.setRating(previous)
        XCTAssertEqual(brew.rating, previous)
    }

    func testABrewInputWithANonFiniteScoreThrowsAndChangesNothing() throws {
        let input = try StoreFixtures.brewInput()
        let brew = try StoredBrew(input)
        let before = try XCTUnwrap(brew.ratingData)

        var bad = try StoreFixtures.brewInput(brewedAt: "2026-11-26T08:00:00.000Z")
        var rating = try XCTUnwrap(bad.rating)
        rating.scores[try StoreFixtures.first(Vocabulary.Criterion.self)] = .nan
        bad.rating = rating
        bad.parameters.waterG = 999

        XCTAssertThrowsError(try brew.apply(bad))
        XCTAssertEqual(brew.ratingData, before)
        XCTAssertEqual(brew.waterG, input.parameters.waterG)
        XCTAssertEqual(brew.brewedAtMilliseconds, input.brewedAt.millisecondsSince1970)
        XCTAssertThrowsError(try StoredBrew(bad))
    }

    func testTheDoseIsKeptInDecigrams() throws {
        var parameters = try StoreFixtures.parameters()
        parameters.doseGrams = 18.3
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters))
        XCTAssertEqual(recipe.doseDg, 183)
        XCTAssertEqual(try recipe.apiParameters().doseGrams, 18.3)
    }

    func testTheVocabularyVersionIsStoredPerItem() throws {
        var input = try StoreFixtures.shelfEntryInput()
        input.vocabularyVersion = 1
        let entry = StoredShelfEntry(input)
        XCTAssertEqual(entry.vocabularyVersion, 1)
        XCTAssertEqual(StoredRecipe(methodID: unknownID).vocabularyVersion, Vocabulary.version)
    }
}
