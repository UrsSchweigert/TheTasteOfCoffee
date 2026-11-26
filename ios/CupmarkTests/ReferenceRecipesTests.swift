import XCTest
@testable import Cupmark

/// The bundled reference recipes and the starting points built on them (M2-T47, ADR 0034): the
/// committed set decodes in the app and every recipe holds the rules of the bundled vocabulary
/// (the same rules as `scripts/reference-recipes.test.mjs`, from the generated ranges and field
/// rules), a file that cannot be used gives no starting points instead of a crash, a recipe that
/// breaks a rule is left out alone, and the numbers, ordering and typical ranges are right.
/// Vocabulary values come from the generated enums, never from a list typed here. Dates and ids
/// are fixed.
final class ReferenceRecipesTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func bundledData() throws -> Data {
        let url = try XCTUnwrap(appBundle.url(forResource: ReferenceRecipeSet.resourceName, withExtension: "json"), "recipes.v1.json is not bundled")
        return try Data(contentsOf: url)
    }

    private func bundledSet() throws -> ReferenceRecipeSet {
        try ReferenceRecipeSet.decode(try bundledData())
    }

    private func rawFile() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: try bundledData()) as? [String: Any])
    }

    /// A file of `recipes` (each `[id, parameters, inferred]` as the file has them) and ranges.
    private func file(
        kind: String = "reference_recipes",
        version: Int = 1,
        vocabularyVersion: Int = Vocabulary.version,
        recipes: [[String: Any]],
        ranges: [String: Any]? = nil
    ) throws -> Data {
        var object: [String: Any] = [
            "kind": kind,
            "version": version,
            "vocabulary_version": vocabularyVersion,
            "note": "Published brew recipes reduced to numbers. Not ratings, not community data.",
            "recipes": recipes,
        ]
        if let ranges {
            object["typical_ranges"] = ranges
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func entry(_ id: String, _ parameters: [String: Any], inferred: [String] = []) -> [String: Any] {
        ["id": id, "parameters": parameters, "inferred": inferred]
    }

    /// A method that allows `field`, and one that does not, from the generated rules.
    private func methodAllowing(_ fields: Vocabulary.BrewField...) throws -> Vocabulary.Method {
        try XCTUnwrap(Vocabulary.Method.allCases.first { method in fields.allSatisfy { field in method.allows(field) } })
    }

    private func methodForbidding(_ field: Vocabulary.BrewField) throws -> Vocabulary.Method {
        try XCTUnwrap(Vocabulary.Method.allCases.first { method in !method.allows(field) })
    }

    private func english() throws -> Bundle {
        let path = try XCTUnwrap(appBundle.path(forResource: "en", ofType: "lproj"))
        return try XCTUnwrap(Bundle(path: path))
    }

    // MARK: - The committed set

    func testTheBundledSetDecodesInTheAppWithoutLosingARecipe() throws {
        let file = try rawFile()
        let raw = try XCTUnwrap(file["recipes"] as? [[String: Any]])
        let set = try bundledSet()

        XCTAssertGreaterThanOrEqual(raw.count, 100)
        XCTAssertEqual(set.recipes.count, raw.count, "every recipe of the committed set is shown")
        XCTAssertEqual(set.skippedRecipes, 0)
        XCTAssertEqual(file["vocabulary_version"] as? Int, Vocabulary.version, "a newer vocabulary needs a regenerated set")
        XCTAssertEqual(Set(set.recipes.map(\.id)), Set(raw.compactMap { $0["id"] as? String }))
        XCTAssertEqual(set.recipes.count, Set(set.recipes.map(\.id)).count, "ids are unique")
    }

    /// The same rules as the committed-set test of `scripts/reference-recipes.test.mjs`.
    func testEveryBundledRecipeHoldsTheRangesAndFieldRulesOfTheBundledVocabulary() throws {
        let set = try bundledSet()
        for recipe in set.recipes {
            let p = recipe.parameters
            let id = recipe.id
            XCTAssertTrue(id.hasPrefix("ref") && id.count == 7, id)
            XCTAssertFalse(p.violatesMethodRules, "\(id): a field its method does not allow")
            let dose = try XCTUnwrap(p.doseDg, "\(id): dose")
            XCTAssertTrue(Vocabulary.Ranges.doseG.contains(Double(dose) / 10), "\(id): dose \(dose)")
            let water = try XCTUnwrap(p.waterG, "\(id): water")
            XCTAssertTrue(Vocabulary.Ranges.waterG.contains(Double(water)), "\(id): water \(water)")
            switch p.waterTemperature {
            case .some(.celsius(let celsius)):
                XCTAssertTrue(Vocabulary.Ranges.waterTempC.contains(Double(celsius)), "\(id): temperature \(celsius)")
                XCTAssertTrue(p.method.allows(.waterTempC), "\(id): a temperature is not allowed for \(p.method.rawValue)")
            case .some(.special):
                XCTAssertTrue(p.method.allows(.waterTempSpecial), "\(id): \(p.method.rawValue) has no special temperature")
            case .none:
                break
            }
            if let seconds = p.brewTimeS {
                XCTAssertTrue(Vocabulary.Ranges.brewTimeS.contains(Double(seconds)), "\(id): time \(seconds)")
            }
            if let grind = p.grindNormalised {
                XCTAssertTrue(Vocabulary.Ranges.grindNormalised.contains(grind), "\(id): grind \(grind)")
            }
            XCTAssertNil(p.waterType)
            XCTAssertNil(p.milk)
            XCTAssertNil(p.grinder)
            XCTAssertNil(p.grindSetting)
            // The summary of the list shows what the recipe saves: nothing is dropped between them.
            XCTAssertEqual(BrewDraft(p).parameters, p, id)
            XCTAssertTrue(recipe.inferred.isSubset(of: p.setFields), "\(id): an inferred field that is not set")
        }
    }

    func testTheDecodedNumbersAreTheFilesNumbers() throws {
        let raw = try XCTUnwrap(try rawFile()["recipes"] as? [[String: Any]])
        let set = try bundledSet()
        for entry in raw {
            let id = try XCTUnwrap(entry["id"] as? String)
            let numbers = try XCTUnwrap(entry["parameters"] as? [String: Any])
            let recipe = try XCTUnwrap(set.recipes.first { $0.id == id }, id)
            XCTAssertEqual(recipe.method.rawValue, numbers["method"] as? String, id)
            XCTAssertEqual(recipe.parameters.doseDg, numbers["dose_dg"] as? Int, id)
            XCTAssertEqual(recipe.parameters.waterG, numbers["water_g"] as? Int, id)
            XCTAssertEqual(recipe.parameters.brewTimeS, numbers["brew_time_s"] as? Int, id)
            XCTAssertEqual(recipe.parameters.grindNormalised, numbers["grind_normalised"] as? Double, id)
            if let celsius = numbers["water_temp_c"] as? Int {
                XCTAssertEqual(recipe.parameters.waterTemperature, API.WaterTemperature.celsius(celsius), id)
            } else if let special = numbers["water_temp_special"] as? String {
                XCTAssertEqual(recipe.parameters.waterTemperature, Vocabulary.WaterTempSpecial(rawValue: special).map { API.WaterTemperature.special($0) }, id)
            } else {
                XCTAssertNil(recipe.parameters.waterTemperature, id)
            }
            XCTAssertEqual(recipe.inferred.map(\.rawValue).sorted(), (entry["inferred"] as? [String] ?? []).sorted(), id)
        }
    }

    func testTheSetIsShownByMethodInVocabularyOrderThenByDose() throws {
        let groups = try bundledSet().groups
        XCTAssertFalse(groups.isEmpty)
        let order = Vocabulary.Method.allCases
        XCTAssertEqual(groups.map(\.method), order.filter { method in groups.contains { $0.method == method } }, "vocabulary order")
        for group in groups {
            XCTAssertFalse(group.recipes.isEmpty)
            XCTAssertTrue(group.recipes.allSatisfy { $0.method == group.method })
            let doses = group.recipes.map { $0.parameters.doseDg ?? 0 }
            XCTAssertEqual(doses, doses.sorted(), "\(group.method.rawValue): by dose")
        }
        XCTAssertEqual(groups.map(\.recipes.count).reduce(0, +), try bundledSet().recipes.count)
    }

    func testTheAppLoadsTheBundledSetAndAnEmptyBundleGivesNothing() {
        let set = ReferenceRecipeSet.load(from: appBundle)
        XCTAssertFalse(set.isEmpty)
        XCTAssertEqual(set, ReferenceRecipeSet.bundled, "the app reads the same file once")

        // The test bundle has no recipes.v1.json: no starting points, no crash.
        let withoutResource = ReferenceRecipeSet.load(from: Bundle(for: ReferenceRecipesTests.self))
        XCTAssertEqual(withoutResource, .empty)
        XCTAssertTrue(withoutResource.groups.isEmpty)
    }

    // MARK: - A file that cannot be used

    func testAFileThatIsNotAReferenceRecipeSetGivesNoStartingPoints() throws {
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(Data("not json".utf8))) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .invalidJSON)
        }
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(Data())) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .invalidJSON)
        }
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(Data("{\"recipes\": 3}".utf8))) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .invalidJSON)
        }
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(try file(kind: "ratings", recipes: []))) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .unsupportedFormat)
        }
        // A newer format of the file.
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(try file(version: ReferenceRecipeSet.formatVersion + 1, recipes: []))) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .unsupportedFormat)
        }
        // A set made for a newer vocabulary than this build bundles.
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(try file(vocabularyVersion: Vocabulary.version + 1, recipes: []))) { error in
            XCTAssertEqual(error as? ReferenceRecipeError, .newerVocabulary)
        }
    }

    func testATruncatedBundledFileGivesNoStartingPointsAndNoCrash() throws {
        let data = try bundledData()
        XCTAssertThrowsError(try ReferenceRecipeSet.decode(data.prefix(data.count / 2)))
    }

    // MARK: - A recipe that breaks a rule is left out alone

    func testARecipeThatBreaksARuleOfTheBundledVocabularyIsLeftOutAndTheRestIsKept() throws {
        let good = try methodAllowing(.doseDg)
        let noTemperature = try methodForbidding(.waterTempC)
        let noSpecial = try methodForbidding(.waterTempSpecial)
        let special = try XCTUnwrap(Vocabulary.WaterTempSpecial.allCases.first).rawValue
        let data = try file(recipes: [
            entry("ref0001", ["method": good.rawValue, "dose_dg": 180, "water_g": 300]),
            entry("ref0002", ["method": "method_of_a_newer_vocabulary", "dose_dg": 180, "water_g": 300]),
            entry("ref0003", ["method": good.rawValue, "dose_dg": 1, "water_g": 300]),
            entry("ref0004", ["method": good.rawValue, "dose_dg": 180, "water_g": 99_999]),
            entry("ref0005", ["method": good.rawValue, "dose_dg": 181, "water_g": 300, "water_temp_c": 1]),
            entry("ref0006", ["method": noTemperature.rawValue, "dose_dg": 180, "water_g": 300, "water_temp_c": 90]),
            entry("ref0007", ["method": noSpecial.rawValue, "dose_dg": 180, "water_g": 300, "water_temp_special": special]),
            entry("ref0008", ["method": good.rawValue, "dose_dg": 182, "water_g": 300, "water_temp_c": 90, "water_temp_special": special]),
            entry("ref0009", ["method": good.rawValue, "dose_dg": 183, "water_g": 300, "water_temp_special": "not_a_special"]),
            entry("ref0010", ["method": good.rawValue, "dose_dg": 184, "water_g": 300, "grind_normalised": 4.25]),
            entry("ref0011", ["method": good.rawValue, "dose_dg": 185, "water_g": 300, "brew_time_s": 0]),
            entry("ref0012", ["method": good.rawValue, "dose_dg": 186]),
            entry("not-an-id", ["method": good.rawValue, "dose_dg": 187, "water_g": 300]),
            entry("ref0001", ["method": good.rawValue, "dose_dg": 188, "water_g": 300]),
            ["id": "ref0013", "parameters": "not an object", "inferred": []],
            entry("ref0014", ["method": good.rawValue, "dose_dg": 189, "water_g": 300]),
        ])

        let set = try ReferenceRecipeSet.decode(data)

        XCTAssertEqual(set.recipes.map(\.id), ["ref0001", "ref0014"])
        XCTAssertEqual(set.skippedRecipes, 14)
    }

    func testAnInferredFieldMustBeSetAndKnown() throws {
        let method = try methodAllowing(.brewTimeS)
        let data = try file(recipes: [
            entry("ref0001", ["method": method.rawValue, "dose_dg": 180, "water_g": 300, "brew_time_s": 150], inferred: ["brew_time_s"]),
            entry("ref0002", ["method": method.rawValue, "dose_dg": 181, "water_g": 300], inferred: ["grind_normalised"]),
            entry("ref0003", ["method": method.rawValue, "dose_dg": 182, "water_g": 300, "brew_time_s": 150], inferred: ["a_field_of_a_newer_vocabulary"]),
        ])

        let set = try ReferenceRecipeSet.decode(data)

        XCTAssertEqual(set.recipes.map(\.id), ["ref0001"])
        XCTAssertEqual(set.recipes.first?.inferred, [.brewTimeS])
    }

    func testRecipesAreOrderedByMethodThenDoseThenWaterThenID() throws {
        let methods = Array(Vocabulary.Method.allCases.filter { $0.allows(.doseDg) }.prefix(2))
        XCTAssertEqual(methods.count, 2)
        let first = methods[0].rawValue
        let second = methods[1].rawValue
        let data = try file(recipes: [
            entry("ref0001", ["method": second, "dose_dg": 100, "water_g": 200]),
            entry("ref0002", ["method": first, "dose_dg": 200, "water_g": 300]),
            entry("ref0003", ["method": first, "dose_dg": 100, "water_g": 300]),
            entry("ref0004", ["method": first, "dose_dg": 100, "water_g": 250]),
            entry("ref0005", ["method": first, "dose_dg": 100, "water_g": 250]),
        ])

        let set = try ReferenceRecipeSet.decode(data)

        // `ref0005` repeats the numbers of `ref0004`; the file is not deduplicated by numbers
        // (the converter does that), only by id.
        XCTAssertEqual(set.recipes.map(\.id), ["ref0004", "ref0005", "ref0003", "ref0002", "ref0001"])
        XCTAssertEqual(set.groups.map(\.method), methods)
    }

    // MARK: - Typical ranges for the paid Explore screens

    func testTypicalRangesAreAReadOnlyModelPerMethodComputedFromTheSet() throws {
        let set = try bundledSet()
        XCTAssertFalse(set.ranges.isEmpty)
        for (method, range) in set.ranges {
            let count = set.recipes.filter { $0.method == method }.count
            XCTAssertEqual(range.recipes, count, "\(method.rawValue): the range describes the recipes of the set")
            XCTAssertGreaterThanOrEqual(range.recipes, 5, "\(method.rawValue): too few for a range")
            for spread in [range.doseG, range.waterG, range.ratioWaterPerDose] + [range.waterTempC, range.brewTimeS, range.grindNormalised].compactMap({ $0 }) {
                XCTAssertTrue(spread.p10 <= spread.median && spread.median <= spread.p90, method.rawValue)
            }
            XCTAssertEqual(set.typicalRange(for: method), range)
            if !method.allows(.waterTempC) {
                XCTAssertNil(range.waterTempC, "\(method.rawValue) has no temperature range")
            }
        }
        // A method without a range (too few recipes, or none) has none.
        let without = Vocabulary.Method.allCases.filter { set.ranges[$0] == nil }
        XCTAssertFalse(without.isEmpty)
        for method in without {
            XCTAssertNil(set.typicalRange(for: method))
        }
    }

    func testARangeThatIsNotOrderedOrNotForAKnownMethodIsLeftOut() throws {
        let method = try methodAllowing(.doseDg)
        let spread: [String: Double] = ["p10": 1, "median": 2, "p90": 3]
        let unordered: [String: Double] = ["p10": 3, "median": 2, "p90": 1]
        func range(dose: [String: Double]) -> [String: Any] {
            ["recipes": 6, "dose_g": dose, "water_g": spread, "ratio_water_per_dose": spread, "water_temp_c": NSNull(), "brew_time_s": spread, "grind_normalised": spread]
        }
        let data = try file(
            recipes: [],
            ranges: [method.rawValue: range(dose: spread), "method_of_a_newer_vocabulary": range(dose: spread)]
        )
        let set = try ReferenceRecipeSet.decode(data)
        XCTAssertEqual(set.ranges.keys.sorted { $0.rawValue < $1.rawValue }, [method])
        XCTAssertNil(set.ranges[method]?.waterTempC)
        XCTAssertEqual(set.ranges[method]?.doseG, ReferenceSpread(p10: 1, median: 2, p90: 3))

        let broken = try ReferenceRecipeSet.decode(try file(recipes: [], ranges: [method.rawValue: range(dose: unordered)]))
        XCTAssertTrue(broken.ranges.isEmpty)
    }

    // MARK: - The numbers of one recipe

    func testTheNumbersShowDoseWaterRatioTemperatureTimeAndGrindInTheDeviceLocale() throws {
        let method = try methodAllowing(.waterTempC, .brewTimeS, .grindNormalised)
        let data = try file(recipes: [
            entry("ref0001", ["method": method.rawValue, "dose_dg": 180, "water_g": 300, "water_temp_c": 94, "brew_time_s": 150, "grind_normalised": 4.5]),
        ])
        let recipe = try XCTUnwrap(try ReferenceRecipeSet.decode(data).recipes.first)
        let vocabulary = try VocabularyStore.load(from: appBundle)
        let us = Locale(identifier: "en_US")

        let numbers = StartingPointNumbers.make(for: recipe, vocabulary: vocabulary, language: .en, locale: us, bundle: try english())

        XCTAssertEqual(numbers.map(\.field), [.dose, .water, .ratio, .temperature, .time, .grind])
        XCTAssertEqual(numbers.map(\.title), ["Dose", "Water", "Ratio", "Temperature", "Brew Time", "Grind"])
        XCTAssertEqual(numbers[0].value, BrewFormat.value(18, of: .dose, locale: us))
        XCTAssertEqual(numbers[1].value, BrewFormat.value(300, of: .water, locale: us))
        XCTAssertEqual(numbers[2].value, "1:16.7")
        XCTAssertEqual(numbers[3].value, BrewFormat.value(94, of: .temperature, locale: us))
        XCTAssertEqual(numbers[4].value, "2:30")
        XCTAssertEqual(numbers[4].spokenValue, BrewTimerFormat.spoken(150, locale: us), "VoiceOver reads the time in words")
        XCTAssertEqual(numbers[5].value, BrewFormat.value(4.5, of: .grind, locale: us))
        XCTAssertTrue(numbers.allSatisfy { !$0.isInferred })
        XCTAssertTrue(numbers.filter { $0.field != .time }.allSatisfy { $0.spokenValue == $0.value }, "only the time is read differently")

        // The decimal separator follows the device locale.
        let german = StartingPointNumbers.make(for: recipe, vocabulary: vocabulary, language: .de, locale: Locale(identifier: "de_DE"), bundle: try english())
        XCTAssertEqual(german[2].value, BrewFormat.ratio(300.0 / 18.0, locale: Locale(identifier: "de_DE"), bundle: try english()))
        XCTAssertTrue(german[2].value.contains("16,7"), german[2].value)
    }

    func testAnInferredNumberIsMarkedAndReadAsEstimated() throws {
        let method = try methodAllowing(.brewTimeS)
        let data = try file(recipes: [
            entry("ref0001", ["method": method.rawValue, "dose_dg": 180, "water_g": 300, "brew_time_s": 150, "grind_normalised": 5.5], inferred: ["brew_time_s"]),
        ])
        let recipe = try XCTUnwrap(try ReferenceRecipeSet.decode(data).recipes.first)
        let vocabulary = try VocabularyStore.load(from: appBundle)

        let numbers = StartingPointNumbers.make(for: recipe, vocabulary: vocabulary, language: .en, locale: Locale(identifier: "en_US"), bundle: try english())

        XCTAssertEqual(numbers.filter(\.isInferred).map(\.field), [.time])
        let time = try XCTUnwrap(numbers.first { $0.field == .time })
        XCTAssertEqual(time.spokenValue, "\(BrewTimerFormat.spoken(150, locale: Locale(identifier: "en_US"))), estimated")
        XCTAssertEqual(L10n.startingPointInferred(bundle: try english()), "Estimated")
        XCTAssertFalse(try XCTUnwrap(numbers.first { $0.field == .grind }).isInferred)
    }

    func testTheColdLabelReplacesTheTemperature() throws {
        let method = try methodAllowing(.waterTempSpecial)
        let special = try XCTUnwrap(Vocabulary.WaterTempSpecial.allCases.first)
        let data = try file(recipes: [
            entry("ref0001", ["method": method.rawValue, "dose_dg": 500, "water_g": 625, "water_temp_special": special.rawValue]),
        ])
        let recipe = try XCTUnwrap(try ReferenceRecipeSet.decode(data).recipes.first)
        let vocabulary = try VocabularyStore.load(from: appBundle)

        for language in VocabularyLanguage.allCases {
            let numbers = StartingPointNumbers.make(for: recipe, vocabulary: vocabulary, language: language, locale: Locale(identifier: language.rawValue), bundle: try english())
            let temperature = try XCTUnwrap(numbers.first { $0.field == .temperature })
            XCTAssertEqual(temperature.value, VocabularyLabels.label(for: special, in: vocabulary, language: language))
            XCTAssertNotEqual(temperature.value, special.rawValue, "the label, not the id (\(language.rawValue))")
        }
    }

    func testEveryNumberLabelAndMarkIsTranslated() throws {
        for language in VocabularyLanguage.allCases {
            let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"))
            let bundle = try XCTUnwrap(Bundle(path: path))
            let texts = [
                L10n.startingPointFieldDose(bundle: bundle), L10n.startingPointFieldWater(bundle: bundle), L10n.startingPointFieldRatio(bundle: bundle),
                L10n.startingPointFieldTemperature(bundle: bundle), L10n.startingPointFieldTime(bundle: bundle), L10n.startingPointFieldGrind(bundle: bundle),
                L10n.startingPointInferred(bundle: bundle), L10n.startingPointCopied(bundle: bundle),
                L10n.startingPointInferredSpoken("2:30", bundle: bundle), L10n.startingPointsGroupCount("32", bundle: bundle),
            ]
            for text in texts {
                XCTAssertFalse(text.hasPrefix("starting_point"), "\(language.rawValue) is not translated: \(text)")
                XCTAssertFalse(text.contains("%@"), "\(language.rawValue): \(text)")
            }
            XCTAssertTrue(L10n.startingPointInferredSpoken("2:30", bundle: bundle).contains("2:30"))
            XCTAssertTrue(L10n.startingPointsGroupCount("32", bundle: bundle).contains("32"))
        }
    }
}
