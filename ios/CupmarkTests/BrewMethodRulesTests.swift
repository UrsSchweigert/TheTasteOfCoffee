import XCTest
@testable import Cupmark

/// The brew form's method rules, grinders and grind settings (M2-T26, docs/04 F2, ADR 0021).
///
/// Methods, fields, grinders and scales all come from the generated types
/// (`Vocabulary.Method.allows(_:)`, `Vocabulary.Grinder.scale`), and are checked once against the
/// bundled JSON, so a test never types a list of its own. The one id written here is
/// `pre_ground`, which the task names.
@MainActor
final class BrewMethodRulesTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func now() throws -> Date {
        try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z").date
    }

    private func model(
        _ entry: StoredShelfEntry,
        _ store: AccountStore,
        start: BrewStart = .blank
    ) throws -> BrewFormModel {
        let now = try now()
        return BrewFormModel(
            shelfEntry: entry.localID,
            store: store,
            now: { now },
            calendar: try StoreFixtures.calendar("Europe/Berlin"),
            start: start
        )
    }

    private var grinderWithScale: Vocabulary.Grinder {
        get throws {
            try XCTUnwrap(Vocabulary.Grinder.allCases.first { grinder in grinder.scale != nil })
        }
    }

    /// Sets every field the draft can take, in the order the form offers them. A field the
    /// method does not allow is ignored by the draft, which is the point of the tests.
    private func fill(_ draft: inout BrewDraft) throws {
        draft.setValue(18, of: .dose)
        draft.setValue(300, of: .water)
        draft.setValue(94, of: .temperature)
        draft.chooseTemperature(.special(try StoreFixtures.first(Vocabulary.WaterTempSpecial.self)), seed: nil)
        draft.setBrewTime(seconds: 200)
        draft.setValue(4.5, of: .grind)
        draft.waterType = try StoreFixtures.first(Vocabulary.WaterType.self)
        draft.milk = try StoreFixtures.first(Vocabulary.MilkType.self)
        let grinder = try grinderWithScale
        draft.setGrinder(grinder)
        draft.setGrindSetting(grinder.scale?.middle)
    }

    private let temperatureFields: Set<Vocabulary.BrewField> = [.waterTempC, .waterTempSpecial]

    // MARK: - The generated rules are the bundled ones

    func testTheGeneratedRulesAndScalesAreTheBundledOnes() throws {
        let store = try VocabularyStore.load(from: appBundle)
        for method in Vocabulary.Method.allCases {
            for field in Vocabulary.BrewField.allCases {
                let rule = store.value(at: "brew.field_rules.\(field.rawValue).allowed_methods")
                let expected: Bool
                if case .some(.object(let methods)) = rule {
                    expected = methods[method.rawValue] == .bool(true)
                } else {
                    XCTAssertNil(rule, "\(field) has a rule that is not a method table")
                    expected = true
                }
                XCTAssertEqual(method.allows(field), expected, "\(method) and \(field)")
            }
        }
        for grinder in Vocabulary.Grinder.allCases {
            XCTAssertEqual(grinder.scale, store.entryRanges["grinders.\(grinder.rawValue).scale"], "\(grinder)")
        }
    }

    // MARK: - The form shows the fields the method allows

    func testForEveryMethodTheVisibleFieldsAreTheGeneratedRules() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let form = try model(entry, store)
        for method in Vocabulary.Method.allCases {
            let draft = BrewDraft(method: method)
            XCTAssertEqual(draft.visibleFields, method.allowedFields, "\(method)")
            form.draft.method = method
            for field in Vocabulary.BrewField.allCases {
                XCTAssertEqual(form.shows(field), method.allows(field), "\(method) shows \(field)")
                XCTAssertEqual(draft.allows(field), method.allows(field), "\(method) allows \(field)")
            }
            XCTAssertEqual(form.temperatureChoices.contains(.celsius), method.allows(.waterTempC), "\(method)")
            let specials = form.temperatureChoices.filter { choice in
                if case .special = choice { return true }
                return false
            }
            XCTAssertEqual(!specials.isEmpty, method.allows(.waterTempSpecial), "\(method)")
            XCTAssertTrue(form.temperatureChoices.contains(.notSet), "\(method) can always leave the temperature out")
        }
    }

    func testWithoutAMethodOnlyFieldsWithoutARuleAreShown() {
        let draft = BrewDraft()
        XCTAssertEqual(draft.visibleFields, Vocabulary.BrewField.allCases.filter { field in Vocabulary.Method.fieldRules[field] == nil })
        XCTAssertEqual(draft.temperatureChoices, [.notSet])
        XCTAssertNil(draft.grindSettingRange)
    }

    func testEveryFieldTheContractRulesIsHiddenByAMethodThatDoesNotAllowIt() throws {
        // The generated table has rules for fields, and a method that lacks one: the vocabulary
        // would otherwise not need them.
        for (field, methods) in Vocabulary.Method.fieldRules {
            let excluded = Vocabulary.Method.allCases.filter { method in !methods.contains(method) }
            XCTAssertFalse(excluded.isEmpty, "\(field) is ruled but every method allows it")
            for method in excluded {
                XCTAssertFalse(BrewDraft(method: method).visibleFields.contains(field))
            }
        }
    }

    // MARK: - Changing the method clears what it no longer allows

    func testChangingTheMethodClearsTheFieldsTheNewMethodDoesNotAllow() throws {
        for old in Vocabulary.Method.allCases {
            for new in Vocabulary.Method.allCases {
                var draft = BrewDraft(method: old)
                try fill(&draft)
                let before = try XCTUnwrap(draft.parameters).setFields

                draft.method = new

                let after = try XCTUnwrap(draft.parameters).setFields
                XCTAssertEqual(after, before.filter { field in new.allows(field) }, "\(old) to \(new)")
                if !new.allows(.grinder) {
                    XCTAssertNil(draft.grinder, "\(old) to \(new)")
                    XCTAssertNil(draft.grindSetting, "\(old) to \(new)")
                }
            }
        }
    }

    func testClearingTheMethodKeepsTheValuesUntilAnotherIsPicked() throws {
        var draft = BrewDraft(method: try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) }))
        try fill(&draft)
        let grinder = draft.grinder

        draft.method = nil

        XCTAssertNil(draft.parameters, "nothing is sent without a method")
        XCTAssertEqual(draft.grinder, grinder)
    }

    // MARK: - BrewInput never holds a disallowed field

    func testTheBrewInputNeverHoldsAFieldItsMethodDoesNotAllow() throws {
        let brewedAt = try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z")
        for old in Vocabulary.Method.allCases {
            for new in Vocabulary.Method.allCases {
                var draft = BrewDraft(method: old)
                try fill(&draft)
                draft.method = new
                try fill(&draft)
                let input = try XCTUnwrap(draft.input(shelfEntryID: StoreFixtures.shelfEntryID, brewedAt: brewedAt))

                let parameters = input.parameters
                XCTAssertEqual(parameters.method, new)
                XCTAssertTrue(parameters.setFields.isSubset(of: Set(new.allowedFields)), "\(old) to \(new)")
                XCTAssertFalse(parameters.violatesMethodRules, "\(old) to \(new)")
                // What the method allows is kept (the temperature is one of two fields).
                XCTAssertEqual(
                    parameters.setFields.subtracting(temperatureFields),
                    Set(new.allowedFields).subtracting(temperatureFields),
                    "\(new)"
                )
                XCTAssertEqual(input.vocabularyVersion, Vocabulary.version)
                // The wire body names only allowed fields.
                let data = try JSONEncoder().encode(parameters)
                let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
                let allowedKeys = Set(new.allowedFields.map(\.rawValue)).union(["method"])
                XCTAssertTrue(Set(json.keys).isSubset(of: allowedKeys), "\(new): \(json.keys)")
            }
        }
    }

    func testSettersIgnoreAFieldTheMethodDoesNotAllow() throws {
        let noGrinder = Vocabulary.Method.allCases.first { method in !method.allows(.grinder) }
        var draft = BrewDraft(method: try XCTUnwrap(noGrinder))
        draft.setGrinder(try grinderWithScale)
        XCTAssertNil(draft.grinder)
        draft.setGrindSetting(5)
        draft.stepGrindSetting(by: 1, seed: nil)
        XCTAssertNil(draft.grindSetting)
        XCTAssertNil(draft.grindSettingRange)
    }

    // MARK: - The grind setting stays on each grinder's scale

    func testTheGrindSettingStaysWithinEachGrindersScale() throws {
        let method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) && method.allows(.grindSetting) })
        for grinder in Vocabulary.Grinder.allCases {
            var draft = BrewDraft(method: method)
            draft.setValue(4.5, of: .grind)
            draft.setGrinder(grinder)
            XCTAssertEqual(draft.grindSettingRange, grinder.scale, "\(grinder)")
            guard let scale = grinder.scale else {
                // No scale: no stepper, no setting, and the normalised grind stays.
                draft.setGrindSetting(3)
                draft.stepGrindSetting(by: 1, seed: 3)
                XCTAssertNil(draft.grindSetting, "\(grinder) has no scale")
                XCTAssertEqual(draft.grindNormalised, 4.5, "\(grinder) keeps the normalised grind")
                XCTAssertEqual(try XCTUnwrap(draft.parameters).grinder, grinder)
                XCTAssertNil(try XCTUnwrap(draft.parameters).grindSetting)
                continue
            }
            draft.setGrindSetting(scale.maximum + scale.multipleOf * 9)
            XCTAssertEqual(draft.grindSetting, scale.maximum, "\(grinder) is clamped to its maximum")
            draft.stepGrindSetting(by: 1, seed: nil)
            XCTAssertEqual(draft.grindSetting, scale.maximum, "\(grinder) does not step past its maximum")
            draft.setGrindSetting(scale.minimum - scale.multipleOf * 9)
            XCTAssertEqual(draft.grindSetting, scale.minimum, "\(grinder) is clamped to its minimum")
            draft.stepGrindSetting(by: -1, seed: nil)
            XCTAssertEqual(draft.grindSetting, scale.minimum, "\(grinder) does not step below its minimum")
            draft.stepGrindSetting(by: 1, seed: nil)
            XCTAssertEqual(try XCTUnwrap(draft.grindSetting), scale.minimum + scale.multipleOf, accuracy: 1e-9, "\(grinder) moves by its own step")
            draft.setGrindSetting(scale.minimum + scale.multipleOf * 2.4)
            XCTAssertEqual(try XCTUnwrap(draft.grindSetting), scale.minimum + scale.multipleOf * 2, accuracy: 1e-9, "\(grinder) snaps to its step")
            draft.setGrindSetting(nil)
            XCTAssertNil(draft.grindSetting)
            draft.stepGrindSetting(by: 1, seed: nil)
            XCTAssertEqual(draft.grindSetting, scale.middle, "\(grinder) starts in the middle of its scale")
            draft.setGrindSetting(nil)
            draft.stepGrindSetting(by: 1, seed: scale.maximum + 50)
            XCTAssertEqual(draft.grindSetting, scale.maximum, "\(grinder) starts at a seed moved onto its scale")
            draft.setGrindSetting(.nan)
            XCTAssertNil(draft.grindSetting, "a value that is not finite clears the setting")
            // Every setting the draft can hold is a setting the server accepts.
            for steps in 0...scale.stepCount {
                draft.setGrindSetting(scale.minimum + Double(steps) * scale.multipleOf)
                XCTAssertTrue(scale.contains(try XCTUnwrap(draft.grindSetting)), "\(grinder) step \(steps)")
                XCTAssertTrue(grinder.accepts(try XCTUnwrap(draft.grindSetting)))
                XCTAssertFalse(try XCTUnwrap(draft.parameters).violatesMethodRules)
            }
        }
    }

    func testPreGroundIsInTheListHasNoScaleAndKeepsTheNormalisedGrind() throws {
        let preGround = try XCTUnwrap(Vocabulary.Grinder(rawValue: "pre_ground"))
        XCTAssertTrue(Vocabulary.Grinder.allCases.contains(preGround))
        XCTAssertNil(preGround.scale)
        let method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        var draft = BrewDraft(method: method)
        draft.setValue(6, of: .grind)
        draft.setGrinder(try grinderWithScale)
        draft.setGrindSetting(try grinderWithScale.scale?.middle)
        XCTAssertNotNil(draft.grindSetting)

        draft.setGrinder(preGround)

        XCTAssertNil(draft.grindSetting, "another grinder's setting means nothing on this one")
        XCTAssertNil(draft.grindSettingRange)
        XCTAssertEqual(draft.grindNormalised, 6)
        let parameters = try XCTUnwrap(draft.parameters)
        XCTAssertEqual(parameters.grinder, preGround)
        XCTAssertNil(parameters.grindSetting)
        XCTAssertEqual(parameters.grindNormalised, 6)
    }

    func testAnotherGrinderClearsTheGrindSettingAndTheSameOneKeepsIt() throws {
        let method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        let scaled = Vocabulary.Grinder.allCases.filter { grinder in grinder.scale != nil }
        let first = try XCTUnwrap(scaled.first)
        let second = try XCTUnwrap(scaled.last)
        XCTAssertNotEqual(first, second)
        var draft = BrewDraft(method: method)
        draft.setGrinder(first)
        draft.stepGrindSetting(by: 1, seed: nil)
        let setting = draft.grindSetting
        XCTAssertNotNil(setting)

        draft.setGrinder(first)
        XCTAssertEqual(draft.grindSetting, setting)

        draft.setGrinder(second)
        XCTAssertNil(draft.grindSetting)

        draft.setGrinder(nil)
        XCTAssertNil(draft.grinder)
        XCTAssertNil(draft.grindSettingRange)
    }

    func testTheGrindSettingIsSentAsTheNumberOnTheGrindersScale() throws {
        let method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        let grinder = try XCTUnwrap(Vocabulary.Grinder.allCases.first { grinder in (grinder.scale?.multipleOf ?? 1) < 1 } ?? Vocabulary.Grinder.allCases.first { grinder in grinder.scale != nil })
        let scale = try XCTUnwrap(grinder.scale)
        var draft = BrewDraft(method: method)
        draft.setGrinder(grinder)
        draft.setGrindSetting(scale.minimum + scale.multipleOf)

        let data = try JSONEncoder().encode(try XCTUnwrap(draft.parameters))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["grinder"] as? String, grinder.rawValue)
        XCTAssertEqual(try XCTUnwrap(json["grind_setting"] as? Double), scale.minimum + scale.multipleOf, accuracy: 1e-9)
        XCTAssertEqual(
            BrewFormat.grindSetting(scale.minimum + scale.multipleOf, on: scale, locale: Locale(identifier: "en_US")),
            BrewFormat.number(scale.minimum + scale.multipleOf, fractionDigits: BrewFormat.fractionDigits(for: scale), locale: Locale(identifier: "en_US"))
        )
    }

    // MARK: - The model: save, repeat, recent grinders

    func testAGrinderAndItsSettingAreSavedWithVocabularyVersion3OrLater() throws {
        XCTAssertGreaterThanOrEqual(Vocabulary.version, 3, "a grinder needs vocabulary 3")
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let form = try model(entry, store)
        form.draft.method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        let grinder = try grinderWithScale
        let scale = try XCTUnwrap(grinder.scale)
        form.grinder = grinder
        XCTAssertEqual(form.grindSettingRange, scale)
        XCTAssertNil(form.grindSettingText())
        form.incrementGrindSetting()
        XCTAssertEqual(form.draft.grindSetting, scale.middle)
        XCTAssertNotNil(form.grindSettingText(locale: Locale(identifier: "en_US")))
        form.incrementGrindSetting()
        XCTAssertEqual(try XCTUnwrap(form.draft.grindSetting), scale.middle + scale.multipleOf, accuracy: 1e-9)
        form.decrementGrindSetting()
        form.decrementGrindSetting()
        XCTAssertEqual(try XCTUnwrap(form.draft.grindSetting), scale.middle - scale.multipleOf, accuracy: 1e-9)

        let localID = try XCTUnwrap(form.save())

        let brew = try XCTUnwrap(try store.brew(localID: localID))
        XCTAssertEqual(brew.vocabularyVersion, Vocabulary.version)
        XCTAssertEqual(brew.grinder, grinder)
        XCTAssertEqual(brew.grindSetting, form.draft.grindSetting)
        let input = try brew.apiInput()
        XCTAssertEqual(input.parameters.grinder, grinder)
        XCTAssertEqual(input.parameters.grindSetting, form.draft.grindSetting)
        XCTAssertGreaterThanOrEqual(input.vocabularyVersion, 3)
        XCTAssertFalse(input.parameters.violatesMethodRules)
    }

    func testClearingTheGrindSettingLeavesTheGrinder() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let form = try model(entry, store)
        form.draft.method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        form.grinder = try grinderWithScale
        form.incrementGrindSetting()

        form.clearGrindSetting()

        XCTAssertNil(form.draft.grindSetting)
        XCTAssertNotNil(form.grinder)
        XCTAssertNil(form.grindSettingText())
    }

    func testARepeatCopiesTheGrinderAndTheSettingAndTheStepperStartsFromTheLatestBrew() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let first = try model(entry, store)
        first.draft.method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        let grinder = try grinderWithScale
        first.grinder = grinder
        first.incrementGrindSetting()
        first.incrementGrindSetting()
        first.incrementGrindSetting()
        let setting = try XCTUnwrap(first.draft.grindSetting)
        XCTAssertNotNil(first.save())

        let repeated = try model(entry, store, start: .lastBrew)
        XCTAssertEqual(repeated.draft.grinder, grinder)
        XCTAssertEqual(repeated.draft.grindSetting, setting)
        XCTAssertEqual(repeated.recentGrinders, [grinder])
        XCTAssertEqual(repeated.grindSettingText(), first.grindSettingText())

        let blank = try model(entry, store)
        XCTAssertEqual(blank.draft.method, first.draft.method, "the method of the latest brew")
        XCTAssertNil(blank.draft.grinder, "values are offered, not copied")
        blank.grinder = grinder
        blank.incrementGrindSetting()
        XCTAssertEqual(blank.draft.grindSetting, setting, "the first tap starts at the setting of the latest brew with this grinder")
    }

    func testRecentGrindersAreTheLatestBrewsGrindersEachOnceNewestFirstAndOnlyWhereAllowed() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        let grinders = Array(Vocabulary.Grinder.allCases.prefix(BrewFormModel.recentGrinderLimit + 2))
        // Oldest first: grinders[0] twice, then the others, so the newest brew has the last.
        let order = [grinders[0]] + grinders
        for (index, grinder) in order.enumerated() {
            let brew = StoredBrew(
                brewedAtMilliseconds: Int64(1_000 + index),
                methodID: method.rawValue
            )
            brew.grinder = grinder
            try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        }

        let form = try model(entry, store)
        form.draft.method = method

        XCTAssertEqual(form.recentGrinders, Array(grinders.reversed().prefix(BrewFormModel.recentGrinderLimit)))
        form.draft.method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in !method.allows(.grinder) })
        XCTAssertTrue(form.recentGrinders.isEmpty)
    }

    // MARK: - Brews and recipes of older vocabularies

    /// A method that allows neither kind of temperature (the water heats in the pot).
    private func methodWithoutTemperature() throws -> Vocabulary.Method {
        try XCTUnwrap(Vocabulary.Method.allCases.first { method in !method.allows(.waterTempC) && !method.allows(.waterTempSpecial) })
    }

    private func oldBrew(in store: AccountStore, entry: StoredShelfEntry) throws -> StoredBrew {
        let brew = StoredBrew(
            vocabularyVersion: Vocabulary.version - 1,
            brewedAtMilliseconds: 5_000,
            methodID: try methodWithoutTemperature().rawValue
        )
        brew.waterTempC = 94
        brew.doseDg = 180
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    func testARepeatOfAnOldBrewDropsTheFieldTheMethodNoLongerAllows() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let old = try oldBrew(in: store, entry: entry)
        XCTAssertEqual(try old.apiParameters().waterTemperature, .celsius(94), "the old brew itself is left as it is")

        let form = try model(entry, store, start: .lastBrew)

        XCTAssertNil(form.draft.waterTemperature)
        XCTAssertEqual(form.draft.doseDg, 180)
        let localID = try XCTUnwrap(form.save())
        let brew = try XCTUnwrap(try store.brew(localID: localID))
        XCTAssertEqual(brew.vocabularyVersion, Vocabulary.version)
        XCTAssertNil(brew.waterTempC)
        XCTAssertFalse(try brew.apiInput().parameters.violatesMethodRules)
        XCTAssertEqual(old.waterTempC, 94, "the old brew keeps its values and its version")
        XCTAssertEqual(old.vocabularyVersion, Vocabulary.version - 1)
    }

    func testARecipeKeptFromAnOldBrewHasNoDisallowedField() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let old = try oldBrew(in: store, entry: entry)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)

        list.saveAsRecipe(old.localID)

        XCTAssertFalse(list.recipeSaveFailed)
        let recipe = try XCTUnwrap(try store.recipes().first)
        XCTAssertEqual(recipe.vocabularyVersion, Vocabulary.version)
        XCTAssertNil(recipe.waterTempC)
        XCTAssertFalse(try recipe.apiParameters().violatesMethodRules)
        XCTAssertEqual(list.rows.first?.isRecipe, true, "the brew still shows as kept")

        // The repeat of that recipe, too.
        let form = try model(entry, store, start: .recipe(recipe.localID))
        XCTAssertNil(form.draft.waterTemperature)
        XCTAssertEqual(form.draft.parameters.map { parameters in parameters.violatesMethodRules }, false)
    }

    func testAnOldRecipeWithADisallowedFieldIsRepeatedWithoutIt() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        var parameters = try StoreFixtures.parameters()
        parameters.method = try methodWithoutTemperature()
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version - 1, parameters: parameters))
        try store.addRecipe(recipe, syncState: .synced)

        let form = try model(entry, store, start: .recipe(recipe.localID))

        XCTAssertNil(form.draft.waterTemperature)
        XCTAssertEqual(form.draft.grindNormalised, parameters.grindNormalised)
        XCTAssertEqual(form.draft.parameters.map { parameters in parameters.violatesMethodRules }, false)
    }

    func testAReplacementRecipeNeverKeepsADisallowedField() throws {
        let store = try AccountStore.inMemory()
        var parameters = try StoreFixtures.parameters()
        parameters.method = try methodWithoutTemperature()
        XCTAssertTrue(parameters.violatesMethodRules)

        let recipe = try store.saveRecipe(parameters)

        XCTAssertFalse(try recipe.apiParameters().violatesMethodRules)
        XCTAssertEqual(try recipe.apiParameters(), parameters.conformingToMethodRules())
        let other = try store.saveRecipe(try StoreFixtures.parameters())
        XCTAssertEqual(try store.replaceRecipe(other, with: parameters), .alreadyRecipe(recipe.localID))
    }

    // MARK: - Editing an old brew

    func testEditingAnOldBrewKeepsItsVersionUnlessTheEditSetsAV3OnlyField() throws {
        let old = StoredBrew(
            vocabularyVersion: Vocabulary.version - 1,
            brewedAtMilliseconds: 1_000,
            methodID: try methodWithoutTemperature().rawValue
        )
        old.waterTempC = 94
        var edit = try old.apiParameters()
        edit.doseDg = 200

        old.setEditedParameters(edit)

        XCTAssertEqual(old.vocabularyVersion, Vocabulary.version - 1, "no v3-only field, so the version stays")
        XCTAssertEqual(old.doseDg, 200)
        XCTAssertEqual(old.waterTempC, 94, "an old brew is not cleaned by an edit that does not need v3")

        edit.grinder = try grinderWithScale
        edit.grindSetting = try grinderWithScale.scale?.middle
        old.setEditedParameters(edit)

        XCTAssertEqual(old.vocabularyVersion, Vocabulary.version, "a grinder needs the bundled version")
        XCTAssertEqual(old.grinder, try grinderWithScale)
        XCTAssertNil(old.waterTempC, "from v3 on the method rules apply")
        XCTAssertFalse(try old.apiParameters().violatesMethodRules)
    }

    func testEditingABrewOfANewerVersionChangesNothing() throws {
        let newer = StoredBrew(
            vocabularyVersion: Vocabulary.version + 1,
            brewedAtMilliseconds: 1_000,
            methodID: try StoreFixtures.first(Vocabulary.Method.self).rawValue
        )
        newer.doseDg = 180

        var edit = try newer.apiParameters()
        edit.doseDg = 200
        newer.setEditedParameters(edit)

        XCTAssertEqual(newer.vocabularyVersion, Vocabulary.version + 1)
        XCTAssertEqual(newer.doseDg, 180)
    }

    func testAV3BrewKeepsItsVersionAndTheRulesApplyToItsEdit() throws {
        let brew = StoredBrew(
            vocabularyVersion: Vocabulary.version,
            brewedAtMilliseconds: 1_000,
            methodID: try StoreFixtures.first(Vocabulary.Method.self).rawValue
        )
        var edit = try StoreFixtures.parameters()
        edit.method = try methodWithoutTemperature()

        brew.setEditedParameters(edit)

        XCTAssertEqual(brew.vocabularyVersion, Vocabulary.version)
        XCTAssertNil(brew.waterTempC)
    }

    // MARK: - The store keeps the grinder

    func testTheGrinderAndTheSettingSurviveTheStoreAndTheWire() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        var input = try StoreFixtures.brewInput(rated: false)
        let grinder = try grinderWithScale
        input.parameters.method = try XCTUnwrap(Vocabulary.Method.allCases.first { method in method.allows(.grinder) })
        input.parameters.grinder = grinder
        input.parameters.grindSetting = grinder.scale?.middle
        let brew = try StoredBrew(input, serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)

        XCTAssertEqual(brew.grinder, grinder)
        XCTAssertEqual(brew.grindSetting, grinder.scale?.middle)
        XCTAssertEqual(try brew.apiInput().parameters, input.parameters)

        // An id the bundled vocabulary does not know reads as no grinder and cannot be sent.
        brew.grinderID = "grinder_of_a_newer_vocabulary"
        XCTAssertNil(brew.grinder)
        XCTAssertThrowsError(try brew.apiParameters())
    }
}
