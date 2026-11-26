import SwiftData
import XCTest
@testable import Cupmark

/// The brew form (M2-T19, docs/04 F2): the draft's mapping to `BrewInput`, the ranges from
/// the vocabulary, the exclusive temperature, the ratio text, and the model's offline save
/// through the outbox. Vocabulary values come from the generated enums, never from a list
/// typed here; ranges come from `Vocabulary.Ranges`.
@MainActor
final class BrewFormTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func now() throws -> Date {
        try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z").date
    }

    private func model(_ entry: StoredShelfEntry, _ store: AccountStore) throws -> BrewFormModel {
        let now = try now()
        return BrewFormModel(shelfEntry: entry.localID, store: store, now: { now }, calendar: try StoreFixtures.calendar("Europe/Berlin"))
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    private func encodedParameters(_ draft: BrewDraft) throws -> [String: Any] {
        let parameters = try XCTUnwrap(draft.parameters)
        let data = try JSONEncoder().encode(parameters)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Mapping to BrewInput

    func testDraftMapsEveryValueToBrewInput() throws {
        var draft = BrewDraft()
        draft.method = try StoreFixtures.last(Vocabulary.Method.self)
        draft.setValue(18.5, of: .dose)
        draft.setValue(300, of: .water)
        draft.setValue(94, of: .temperature)
        draft.setValue(4.5, of: .grind)
        draft.waterType = try StoreFixtures.last(Vocabulary.WaterType.self)
        draft.milk = try StoreFixtures.last(Vocabulary.MilkType.self)
        let brewedAt = try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z")

        let input = try XCTUnwrap(draft.input(shelfEntryID: StoreFixtures.shelfEntryID, brewedAt: brewedAt))

        let expected = API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: StoreFixtures.shelfEntryID,
            brewedAt: brewedAt,
            parameters: API.BrewParameters(
                method: try StoreFixtures.last(Vocabulary.Method.self),
                doseDg: 185,
                waterG: 300,
                waterTemperature: .celsius(94),
                brewTimeS: nil,
                grindNormalised: 4.5,
                waterType: try StoreFixtures.last(Vocabulary.WaterType.self),
                milk: try StoreFixtures.last(Vocabulary.MilkType.self)
            ),
            rating: nil
        )
        XCTAssertEqual(input, expected)
    }

    func testOnlyTheMethodIsRequired() throws {
        var draft = BrewDraft()
        XCTAssertFalse(draft.isComplete)
        XCTAssertNil(draft.parameters)
        XCTAssertNil(draft.input(shelfEntryID: StoreFixtures.shelfEntryID, brewedAt: try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z")))

        draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        XCTAssertTrue(draft.isComplete)
        let json = try encodedParameters(draft)
        XCTAssertEqual(Set(json.keys), ["method"], "nothing optional is sent unless it was set")
        XCTAssertEqual(json["method"] as? String, try StoreFixtures.first(Vocabulary.Method.self).rawValue)
    }

    func testEighteenPointFiveGramsIsSentAsDoseDg185() throws {
        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        draft.setValue(18.5, of: .dose)
        XCTAssertEqual(draft.doseDg, 185)
        XCTAssertEqual(try XCTUnwrap(draft.value(of: .dose)), 18.5, accuracy: 1e-9)
        XCTAssertEqual(try encodedParameters(draft)["dose_dg"] as? Int, 185)

        // The same value reached with the stepper, one step of the vocabulary at a time.
        var stepped = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        stepped.step(.dose, by: 1, seed: 18.4)
        XCTAssertEqual(stepped.doseDg, 184, "the first tap starts at the seed")
        stepped.step(.dose, by: 1, seed: nil)
        XCTAssertEqual(stepped.doseDg, 185)
        XCTAssertEqual(try encodedParameters(stepped)["dose_dg"] as? Int, 185)
    }

    func testVocabularyVersionIsTheBundledVersion() throws {
        let store = try VocabularyStore.load(from: appBundle)
        let draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        let input = try XCTUnwrap(draft.input(shelfEntryID: StoreFixtures.shelfEntryID, brewedAt: try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z")))
        XCTAssertEqual(input.vocabularyVersion, Vocabulary.version)
        XCTAssertEqual(store.value(at: "brew.version"), .number(Double(input.vocabularyVersion)), "the version of the bundled brew.json")
    }

    // MARK: - Ranges from the vocabulary

    func testEveryStepperUsesItsBundledVocabularyRange() throws {
        let store = try VocabularyStore.load(from: appBundle)
        XCTAssertEqual(BrewNumberField.dose.range, Vocabulary.Ranges.doseG)
        XCTAssertEqual(BrewNumberField.water.range, Vocabulary.Ranges.waterG)
        XCTAssertEqual(BrewNumberField.temperature.range, Vocabulary.Ranges.waterTempC)
        XCTAssertEqual(BrewNumberField.grind.range, Vocabulary.Ranges.grindNormalised)
        XCTAssertEqual(store.ranges["brew.ranges.dose_g"], BrewNumberField.dose.range)
        XCTAssertEqual(store.ranges["brew.ranges.water_g"], BrewNumberField.water.range)
        XCTAssertEqual(store.ranges["brew.ranges.water_temp_c"], BrewNumberField.temperature.range)
        XCTAssertEqual(store.ranges["brew.ranges.grind_normalised"], BrewNumberField.grind.range)
    }

    func testValuesStayWithinTheRangeAndOnItsSteps() throws {
        for field in BrewNumberField.allCases {
            let range = field.range
            var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
            draft.setValue(range.maximum + range.multipleOf * 7, of: field)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.maximum, accuracy: 1e-9, "\(field) is clamped to its maximum")
            draft.step(field, by: 1, seed: nil)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.maximum, accuracy: 1e-9, "\(field) does not step past its maximum")
            draft.setValue(range.minimum - range.multipleOf * 7, of: field)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.minimum, accuracy: 1e-9, "\(field) is clamped to its minimum")
            draft.step(field, by: -1, seed: nil)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.minimum, accuracy: 1e-9, "\(field) does not step below its minimum")
            draft.step(field, by: 1, seed: nil)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.minimum + range.multipleOf, accuracy: 1e-9, "\(field) moves by one step")
            XCTAssertTrue(range.contains(try XCTUnwrap(draft.value(of: field))))
            draft.setValue(range.minimum + range.multipleOf * 2.4, of: field)
            XCTAssertEqual(try XCTUnwrap(draft.value(of: field)), range.minimum + range.multipleOf * 2, accuracy: 1e-9, "\(field) snaps to the nearest step")
            draft.setValue(nil, of: field)
            XCTAssertNil(draft.value(of: field))
            draft.setValue(.nan, of: field)
            XCTAssertNil(draft.value(of: field), "a value that is not finite clears the field")
        }
    }

    func testTheFirstTapStartsAtTheSeedOrTheMiddleOfTheRange() throws {
        let grind = BrewNumberField.grind.range
        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        draft.step(.grind, by: -1, seed: nil)
        XCTAssertEqual(try XCTUnwrap(draft.value(of: .grind)), grind.middle, accuracy: 1e-9)
        XCTAssertTrue(grind.contains(grind.middle))
        draft.setValue(nil, of: .grind)
        draft.step(.grind, by: 1, seed: grind.maximum + 3)
        XCTAssertEqual(try XCTUnwrap(draft.value(of: .grind)), grind.maximum, accuracy: 1e-9, "a seed outside the range is clamped")
    }

    func testGrindMovesInTheVocabularyStep() throws {
        let grind = BrewNumberField.grind.range
        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        draft.setValue(grind.minimum, of: .grind)
        draft.step(.grind, by: 1, seed: nil)
        draft.step(.grind, by: 1, seed: nil)
        XCTAssertEqual(try XCTUnwrap(draft.grindNormalised), grind.minimum + 2 * grind.multipleOf, accuracy: 1e-9)
        XCTAssertTrue(grind.contains(try XCTUnwrap(draft.grindNormalised)))
    }

    // MARK: - Temperature or cold, never both

    func testTemperatureAndColdExcludeEachOther() throws {
        // No method allows both (the generated rules), and the type holds only one of them.
        let special = try StoreFixtures.first(Vocabulary.WaterTempSpecial.self)
        let heated = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.waterTempC) })
        let cold = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.waterTempSpecial) })
        XCTAssertFalse(heated.allows(.waterTempSpecial))
        XCTAssertFalse(cold.allows(.waterTempC))

        var draft = BrewDraft(method: heated)
        draft.setValue(94, of: .temperature)
        XCTAssertEqual(draft.temperatureChoice, .celsius)
        XCTAssertEqual(draft.waterTemperature, .celsius(94))
        draft.chooseTemperature(.special(special), seed: nil)
        XCTAssertEqual(draft.waterTemperature, .celsius(94), "cold is ignored where the method does not allow it")
        var json = try encodedParameters(draft)
        XCTAssertEqual(json["water_temp_c"] as? Int, 94)
        XCTAssertNil(json["water_temp_special"])

        draft.method = cold
        XCTAssertNil(draft.waterTemperature, "changing to a method without a temperature clears it")
        draft.chooseTemperature(.special(special), seed: nil)
        XCTAssertEqual(draft.waterTemperature, .special(special))
        XCTAssertNil(draft.value(of: .temperature), "the temperature is gone once cold is picked")
        json = try encodedParameters(draft)
        XCTAssertEqual(json["water_temp_special"] as? String, special.rawValue)
        XCTAssertNil(json["water_temp_c"])
        draft.step(.temperature, by: 1, seed: 92)
        XCTAssertEqual(draft.waterTemperature, .special(special), "a temperature is ignored where the method does not allow it")
        draft.chooseTemperature(.celsius, seed: 80)
        XCTAssertEqual(draft.waterTemperature, .special(special))

        draft.method = heated
        XCTAssertNil(draft.waterTemperature, "cold is cleared by a method that does not allow it")
        draft.step(.temperature, by: 1, seed: 92)
        XCTAssertEqual(draft.waterTemperature, .celsius(92))
        draft.chooseTemperature(.celsius, seed: 80)
        XCTAssertEqual(draft.waterTemperature, .celsius(92), "choosing °C again keeps the temperature")
        draft.chooseTemperature(.notSet, seed: nil)
        XCTAssertNil(draft.waterTemperature)
        draft.chooseTemperature(.celsius, seed: nil)
        XCTAssertEqual(try XCTUnwrap(draft.value(of: .temperature)), BrewNumberField.temperature.range.middle, accuracy: 1e-9)
        XCTAssertEqual(BrewDraft.TemperatureChoice.all.count, 2 + Vocabulary.WaterTempSpecial.allCases.count)
    }

    func testAStoredBrewWithBothTemperatureColumnsCannotBeSent() throws {
        // The draft never writes both; the store refuses them if a column was set by hand.
        let brew = StoredBrew(brewedAtMilliseconds: 0, methodID: try StoreFixtures.first(Vocabulary.Method.self).rawValue)
        brew.waterTempC = 94
        brew.waterTempSpecialID = try StoreFixtures.first(Vocabulary.WaterTempSpecial.self).rawValue
        XCTAssertThrowsError(try brew.apiParameters())
    }

    // MARK: - Ratio and its text

    func testRatioFormatting() throws {
        let english = Locale(identifier: "en_US")
        let german = Locale(identifier: "de_DE")
        XCTAssertEqual(BrewFormat.ratio(16, locale: english), "1:16.0")
        XCTAssertEqual(BrewFormat.ratio(300.0 / 18.5, locale: english), "1:16.2")
        XCTAssertEqual(BrewFormat.ratio(300.0 / 18.5, locale: german), "1:16,2")
        XCTAssertEqual(BrewFormat.ratio(2, locale: english), "1:2.0")

        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        XCTAssertNil(draft.ratio)
        draft.setValue(18.5, of: .dose)
        XCTAssertNil(draft.ratio, "no ratio without water")
        draft.setValue(300, of: .water)
        XCTAssertEqual(try XCTUnwrap(draft.ratio), 300.0 / 18.5, accuracy: 1e-9)
        XCTAssertEqual(draft.ratio, BrewDerivedValues.ratio(doseDg: 185, waterG: 300))
    }

    func testStepperValuesShowTheDigitsOfTheirStep() {
        XCTAssertEqual(BrewFormat.fractionDigits(for: Vocabulary.Ranges.doseG), 1)
        XCTAssertEqual(BrewFormat.fractionDigits(for: Vocabulary.Ranges.waterG), 0)
        XCTAssertEqual(BrewFormat.fractionDigits(for: Vocabulary.Ranges.grindNormalised), 1)
        let english = Locale(identifier: "en_US")
        XCTAssertTrue(BrewFormat.value(18.5, of: .dose, locale: english).hasPrefix("18.5"))
        XCTAssertTrue(BrewFormat.value(18.5, of: .dose, locale: Locale(identifier: "de_DE")).hasPrefix("18,5"))
        XCTAssertTrue(BrewFormat.value(94, of: .temperature, locale: english).hasPrefix("94"))
        XCTAssertEqual(BrewFormat.value(4.5, of: .grind, locale: english), "4.5")
    }

    // MARK: - The model: offline save through the outbox

    func testSavingStoresTheBrewOnTheEntryAndQueuesOnlyItsCreate() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try model(entry, store)
        XCTAssertNil(model.draft.method, "no brew on the entry yet, so no method is preselected")
        XCTAssertFalse(model.canSave)
        XCTAssertEqual(model.daysSinceRoast, 7, "roasted 2026-11-18, brewed 2026-11-25")

        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        model.draft.setValue(18.5, of: .dose)
        model.draft.setValue(300, of: .water)
        XCTAssertEqual(model.ratioText(locale: Locale(identifier: "en_US")), "1:16.2")
        XCTAssertTrue(model.canSave)

        let localID = try XCTUnwrap(model.save())

        let brew = try XCTUnwrap(try store.brew(localID: localID))
        XCTAssertEqual(brew.shelfEntry?.localID, entry.localID)
        XCTAssertEqual(brew.syncState, .pendingCreate)
        XCTAssertEqual(brew.vocabularyVersion, Vocabulary.version)
        XCTAssertEqual(brew.brewedAt, try now(), "brewed_at is the device clock at the save")
        XCTAssertEqual(try queue(store), ["create brew"])
        let brewedAt = try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z")
        XCTAssertEqual(try brew.apiInput(), model.draft.input(shelfEntryID: StoreFixtures.shelfEntryID, brewedAt: brewedAt))
        XCTAssertEqual(try brew.apiInput().parameters.doseDg, 185)

        XCTAssertFalse(model.canSave, "a saved form does not save a second brew")
        XCTAssertNil(model.save())
        XCTAssertEqual(try store.brewsNewestFirst().count, 1)
    }

    func testABrewOnAnEntryTheServerHasNotGotYetIsQueuedAfterTheEntry() throws {
        let store = try AccountStore.inMemory()
        let bean = StoredBean(try StoreFixtures.bean())
        try store.addBean(bean, syncState: .synced)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try store.addShelfEntry(entry, bean: bean)
        let model = try model(entry, store)
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)

        XCTAssertNotNil(model.save())

        XCTAssertEqual(try queue(store), ["create shelf_entry", "create brew"], "the brew names the entry's server id once it has one")
    }

    func testTheMethodAndTheStepperStartsComeFromTheLatestBrew() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let earlier = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-24T08:00:00.000Z"), serverID: StoreFixtures.brewID)
        try store.addBrew(earlier, shelfEntry: entry, syncState: .synced)
        let parameters = try StoreFixtures.parameters()

        let model = try model(entry, store)

        XCTAssertEqual(model.draft.method, parameters.method, "a repeat brew needs no method pick")
        XCTAssertNil(model.draft.doseDg, "values are not copied, only offered as the stepper start")
        model.increment(.dose)
        XCTAssertEqual(model.draft.doseDg, parameters.doseDg)
        model.increment(.dose)
        XCTAssertEqual(model.draft.doseDg, parameters.doseDg.map { dose in dose + 1 })
        model.temperatureChoice = .celsius
        XCTAssertEqual(model.draft.waterTemperature, parameters.waterTemperature)
        model.decrement(.grind)
        XCTAssertEqual(model.draft.grindNormalised, parameters.grindNormalised)
        model.clear(.grind)
        XCTAssertNil(model.draft.grindNormalised)
    }

    func testWithoutTheEntryNothingIsSaved() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = try model(entry, store)
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        try store.markDeleted(entry)

        XCTAssertNil(model.save())

        XCTAssertEqual(model.failure, .notFound)
        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
        XCTAssertEqual(try queue(store), ["delete shelf_entry"])
    }

    func testAFailedSaveLeavesNothingBehind() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let now = try now()
        let model = BrewFormModel(
            shelfEntry: entry.localID,
            store: store,
            now: { now },
            calendar: try StoreFixtures.calendar("Europe/Berlin"),
            addBrew: { _, _, _, _ in throw LocalStoreError.invalidDate }
        )
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)

        XCTAssertNil(model.save())

        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertTrue(model.canSave, "the user can try again")
        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
        XCTAssertTrue(try queue(store).isEmpty)
    }
}
