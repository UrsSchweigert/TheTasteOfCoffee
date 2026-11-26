import Foundation
import OSLog
import SwiftUI

// The reference recipes: published brew numbers, bundled with the app (M2-T47, ADR 0034).
//
// The set is `contracts/reference/recipes.v1.json`, bundled as a resource (the Xcode project
// has a file reference to it, like the vocabulary and the languages). It holds numbers and
// vocabulary ids only (no name, link, text or rating) and is never community data: nothing
// here counts a rater, and nothing here reads or sends anything over the network.
//
// Decoding is defensive. A resource that is missing, is not JSON, is not a reference recipe
// set of version 1, or was made for a newer vocabulary than this build bundles gives no
// starting points (`ReferenceRecipeSet.load` logs one fixed message, which names no value, and
// returns an empty set), and a recipe that breaks a rule of the bundled vocabulary (an unknown method, a
// number outside its range or off its step, a field the method does not allow) is left out
// on its own. The same rules as `scripts/reference-recipes.test.mjs` apply, from the
// generated ranges and field rules, so no list or range is typed here.

/// One reference recipe: a method and numbers, with the fields that were inferred (not
/// published for this recipe, filled with the typical value of its method).
struct ReferenceRecipe: Identifiable, Equatable, Sendable {
    /// `ref0001` and on: a counter of the dataset, not a pointer to a source.
    let id: String
    /// The numbers, already conformed to the method's field rules.
    let parameters: API.BrewParameters
    /// The fields of `parameters` that were inferred (`water_temp_c`, `brew_time_s`,
    /// `grind_normalised`). Empty when every number was published.
    let inferred: Set<Vocabulary.BrewField>

    var method: Vocabulary.Method { parameters.method }

    /// How the recipe is shown in a list: method, dose, ratio, temperature and grind.
    var summary: BrewSummary { BrewSummary(BrewDraft(parameters)) }
}

/// The reference recipes of one method, in the order they are listed.
struct ReferenceRecipeGroup: Identifiable, Equatable, Sendable {
    let method: Vocabulary.Method
    let recipes: [ReferenceRecipe]

    var id: Vocabulary.Method { method }
}

/// The 10th percentile, the median and the 90th percentile of one number across the
/// reference recipes of a method.
struct ReferenceSpread: Equatable, Sendable {
    let p10: Double
    let median: Double
    let p90: Double
}

/// What is typical for a method among its reference recipes (`typical_ranges`): read-only
/// numbers for the paid Explore screens (M4). They describe published recipes, not what people
/// rate highly, are computed from published values only, and are always shown with the label
/// `ReferenceRange.label` ("Reference"), never as community data.
struct ReferenceRange: Equatable, Sendable {
    /// The label every place that shows these numbers carries.
    static var label: LocalizedStringKey { L10n.referenceLabel }

    /// How many reference recipes of the method the numbers come from.
    let recipes: Int
    let doseG: ReferenceSpread
    let waterG: ReferenceSpread
    /// Grams of water per gram of coffee.
    let ratioWaterPerDose: ReferenceSpread
    /// Nil where the method has no published temperature (moka pot, cezve).
    let waterTempC: ReferenceSpread?
    /// Nil where the method has no published time.
    let brewTimeS: ReferenceSpread?
    let grindNormalised: ReferenceSpread?
}

/// Why the bundled set could not be used. Developer diagnostics only, never shown.
enum ReferenceRecipeError: Error, Equatable, Sendable {
    case missingResource
    case unreadable
    case invalidJSON
    /// Not a reference recipe set, or a version of the format this build does not know.
    case unsupportedFormat
    /// Made for a newer vocabulary than this build bundles: it needs a newer build.
    case newerVocabulary
}

/// The decoded set: the reference recipes this build can show, in the order they are listed,
/// and the typical ranges.
struct ReferenceRecipeSet: Equatable, Sendable {
    /// The format version this build reads (`version` of the file).
    static let formatVersion = 1
    /// The name of the bundled file, without `.json`.
    static let resourceName = "recipes.v1"

    /// Every recipe this build can show, by method in vocabulary order, then by dose, water
    /// and id.
    let recipes: [ReferenceRecipe]
    /// The typical ranges by method; only methods this build knows.
    let ranges: [Vocabulary.Method: ReferenceRange]
    /// How many recipes of the file were left out because they break a rule of the bundled
    /// vocabulary. Zero for the committed set.
    let skippedRecipes: Int

    static let empty = ReferenceRecipeSet(recipes: [], ranges: [:], skippedRecipes: 0)

    var isEmpty: Bool { recipes.isEmpty }

    /// The recipes by method, in vocabulary order; a method without recipes has no group.
    var groups: [ReferenceRecipeGroup] {
        Vocabulary.Method.allCases.compactMap { method in
            let ofMethod = recipes.filter { recipe in recipe.method == method }
            return ofMethod.isEmpty ? nil : ReferenceRecipeGroup(method: method, recipes: ofMethod)
        }
    }

    /// The typical range of `method`, nil when the set has none for it (too few recipes).
    func typicalRange(for method: Vocabulary.Method) -> ReferenceRange? {
        ranges[method]
    }

    // MARK: - Loading

    /// The set bundled with the app, read once.
    static let bundled = load(from: .main)

    /// The set in `bundle`, or an empty one when it cannot be used. Logs one fixed message.
    static func load(from bundle: Bundle) -> ReferenceRecipeSet {
        do {
            return try decode(try resource(in: bundle))
        } catch {
            Logger(subsystem: "Cupmark", category: "ReferenceRecipes").error("The bundled reference recipes could not be used; no starting points are shown.")
            return .empty
        }
    }

    private static func resource(in bundle: Bundle) throws -> Data {
        guard let url = bundle.url(forResource: resourceName, withExtension: "json") else {
            throw ReferenceRecipeError.missingResource
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw ReferenceRecipeError.unreadable
        }
    }

    /// Decodes `data`. Throws for a file that cannot be used as a whole; a recipe or a range
    /// that breaks a rule is left out and does not fail the set.
    static func decode(_ data: Data) throws -> ReferenceRecipeSet {
        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw ReferenceRecipeError.invalidJSON
        }
        guard file.kind == "reference_recipes", file.version == formatVersion else {
            throw ReferenceRecipeError.unsupportedFormat
        }
        guard file.vocabularyVersion <= Vocabulary.version else {
            throw ReferenceRecipeError.newerVocabulary
        }
        var seen = Set<String>()
        var recipes: [ReferenceRecipe] = []
        var skipped = 0
        for entry in file.recipes {
            if let recipe = entry.value.flatMap(RawRecipe.recipe(_:)), seen.insert(recipe.id).inserted {
                recipes.append(recipe)
            } else {
                skipped += 1
            }
        }
        let order = Dictionary(uniqueKeysWithValues: Vocabulary.Method.allCases.enumerated().map { index, method in (method, index) })
        recipes.sort { left, right in
            let leftKey = (order[left.method] ?? 0, left.parameters.doseDg ?? 0, left.parameters.waterG ?? 0)
            let rightKey = (order[right.method] ?? 0, right.parameters.doseDg ?? 0, right.parameters.waterG ?? 0)
            return leftKey == rightKey ? left.id < right.id : leftKey < rightKey
        }
        var ranges: [Vocabulary.Method: ReferenceRange] = [:]
        for (id, entry) in file.typicalRanges ?? [:] {
            if let method = Vocabulary.Method(rawValue: id), let range = entry.value.flatMap(RawRange.range(_:)) {
                ranges[method] = range
            }
        }
        return ReferenceRecipeSet(recipes: recipes, ranges: ranges, skippedRecipes: skipped)
    }

    // MARK: - The file

    /// Decodes a value or, when it does not fit, nothing, without failing the container
    /// around it.
    private struct Lossy<Value: Decodable>: Decodable {
        let value: Value?

        init(from decoder: Decoder) throws {
            value = try? Value(from: decoder)
        }
    }

    private struct File: Decodable {
        let kind: String
        let version: Int
        let vocabularyVersion: Int
        let recipes: [Lossy<RawRecipe>]
        let typicalRanges: [String: Lossy<RawRange>]?

        enum CodingKeys: String, CodingKey {
            case kind
            case version
            case vocabularyVersion = "vocabulary_version"
            case recipes
            case typicalRanges = "typical_ranges"
        }
    }

    private struct RawRecipe: Decodable {
        let id: String
        let parameters: RawParameters
        let inferred: [String]

        /// The recipe if every rule of the bundled vocabulary holds, else nil.
        static func recipe(_ raw: RawRecipe) -> ReferenceRecipe? {
            guard isCounterID(raw.id), let parameters = raw.parameters.apiParameters() else {
                return nil
            }
            var inferred = Set<Vocabulary.BrewField>()
            for name in raw.inferred {
                // Only a field that is set can have been inferred.
                guard let field = Vocabulary.BrewField(rawValue: name), parameters.setFields.contains(field) else {
                    return nil
                }
                inferred.insert(field)
            }
            return ReferenceRecipe(id: raw.id, parameters: parameters, inferred: inferred)
        }

        /// `ref` and four digits.
        private static func isCounterID(_ id: String) -> Bool {
            let digits = id.dropFirst(3)
            return id.hasPrefix("ref") && digits.count == 4 && digits.allSatisfy { character in character.isASCII && character.isNumber }
        }
    }

    private struct RawParameters: Decodable {
        let method: String
        let doseDg: Int?
        let waterG: Int?
        let waterTempC: Int?
        let waterTempSpecial: String?
        let brewTimeS: Int?
        let grindNormalised: Double?

        enum CodingKeys: String, CodingKey {
            case method
            case doseDg = "dose_dg"
            case waterG = "water_g"
            case waterTempC = "water_temp_c"
            case waterTempSpecial = "water_temp_special"
            case brewTimeS = "brew_time_s"
            case grindNormalised = "grind_normalised"
        }

        /// The parameters if the method is known, dose and water are set and every number lies
        /// on its vocabulary range and step, a temperature and `cold` are not both set, and
        /// the method allows every field that is set; else nil.
        func apiParameters() -> API.BrewParameters? {
            guard let method = Vocabulary.Method(rawValue: method),
                  let doseDg, let waterG,
                  BrewNumberField.dose.range.contains(Double(doseDg) / Double(BrewDraft.decigramsPerGram)),
                  BrewNumberField.water.range.contains(Double(waterG)) else {
                return nil
            }
            let temperature: API.WaterTemperature?
            switch (waterTempC, waterTempSpecial) {
            case (nil, nil):
                temperature = nil
            case (.some(let celsius), nil):
                guard BrewNumberField.temperature.range.contains(Double(celsius)) else {
                    return nil
                }
                temperature = .celsius(celsius)
            case (nil, .some(let id)):
                guard let special = Vocabulary.WaterTempSpecial(rawValue: id) else {
                    return nil
                }
                temperature = .special(special)
            case (.some, .some):
                return nil
            }
            if let brewTimeS, !Vocabulary.Ranges.brewTimeS.contains(Double(brewTimeS)) {
                return nil
            }
            if let grindNormalised, !BrewNumberField.grind.range.contains(grindNormalised) {
                return nil
            }
            let parameters = API.BrewParameters(
                method: method,
                doseDg: doseDg,
                waterG: waterG,
                waterTemperature: temperature,
                brewTimeS: brewTimeS,
                grindNormalised: grindNormalised
            )
            // A field the method does not allow means the recipe does not fit the rules.
            return parameters.violatesMethodRules ? nil : parameters
        }
    }

    private struct RawSpread: Decodable {
        let p10: Double
        let median: Double
        let p90: Double

        var spread: ReferenceSpread? {
            guard p10.isFinite, median.isFinite, p90.isFinite, p10 <= median, median <= p90 else {
                return nil
            }
            return ReferenceSpread(p10: p10, median: median, p90: p90)
        }
    }

    private struct RawRange: Decodable {
        let recipes: Int
        let doseG: RawSpread
        let waterG: RawSpread
        let ratioWaterPerDose: RawSpread
        let waterTempC: RawSpread?
        let brewTimeS: RawSpread?
        let grindNormalised: RawSpread?

        enum CodingKeys: String, CodingKey {
            case recipes
            case doseG = "dose_g"
            case waterG = "water_g"
            case ratioWaterPerDose = "ratio_water_per_dose"
            case waterTempC = "water_temp_c"
            case brewTimeS = "brew_time_s"
            case grindNormalised = "grind_normalised"
        }

        /// The range if its required spreads are ordered; an optional one that is present but
        /// not ordered makes the whole range unusable.
        static func range(_ raw: RawRange) -> ReferenceRange? {
            guard raw.recipes > 0, let dose = raw.doseG.spread, let water = raw.waterG.spread, let ratio = raw.ratioWaterPerDose.spread else {
                return nil
            }
            let optional = [raw.waterTempC, raw.brewTimeS, raw.grindNormalised]
            let spreads = optional.map { value in value?.spread }
            for (value, spread) in zip(optional, spreads) where value != nil && spread == nil {
                return nil
            }
            return ReferenceRange(
                recipes: raw.recipes,
                doseG: dose,
                waterG: water,
                ratioWaterPerDose: ratio,
                waterTempC: spreads[0],
                brewTimeS: spreads[1],
                grindNormalised: spreads[2]
            )
        }
    }
}
