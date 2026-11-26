import Foundation
import Observation

/// One number of a reference recipe, as the detail screen shows and VoiceOver reads it
/// (M2-T47).
struct StartingPointNumber: Identifiable, Equatable, Sendable {
    enum Field: String, Sendable {
        case dose, water, ratio, temperature, time, grind
    }

    let field: Field
    /// "Dose", "Water", "Ratio", "Temperature", "Brew Time", "Grind".
    let title: String
    /// "18.0 g", "1:16.7", "94°C" or the label of `cold`, "2:30", "5.5".
    let value: String
    /// What VoiceOver reads as the value: the time in words, and for an inferred number
    /// "<value>, estimated".
    let spokenValue: String
    /// The number was not published for this recipe; it is the typical value of its method.
    let isInferred: Bool

    var id: Field { field }
}

/// The numbers of a reference recipe, in the device locale (M2-T47, docs/04 F2): dose, water,
/// ratio, temperature or the cold label, time and grind, each only when the recipe has it, the
/// inferred ones marked. Dose and water always exist (the decoder requires them), so the ratio
/// does too.
enum StartingPointNumbers {
    static func make(
        for recipe: ReferenceRecipe,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        locale: Locale = .current,
        bundle: Bundle = .main
    ) -> [StartingPointNumber] {
        let draft = BrewDraft(recipe.parameters)
        var result: [StartingPointNumber] = []
        func add(_ field: StartingPointNumber.Field, _ title: String, _ value: String, spoken: String? = nil, inferredField: Vocabulary.BrewField? = nil) {
            let isInferred = inferredField.map { recipe.inferred.contains($0) } ?? false
            let spokenValue = spoken ?? value
            result.append(StartingPointNumber(
                field: field,
                title: title,
                value: value,
                spokenValue: isInferred ? L10n.startingPointInferredSpoken(spokenValue, bundle: bundle) : spokenValue,
                isInferred: isInferred
            ))
        }
        if let dose = draft.value(of: .dose) {
            add(.dose, L10n.startingPointFieldDose(bundle: bundle), BrewFormat.value(dose, of: .dose, locale: locale))
        }
        if let water = draft.value(of: .water) {
            add(.water, L10n.startingPointFieldWater(bundle: bundle), BrewFormat.value(water, of: .water, locale: locale))
        }
        if let ratio = draft.ratio {
            add(.ratio, L10n.startingPointFieldRatio(bundle: bundle), BrewFormat.ratio(ratio, locale: locale, bundle: bundle))
        }
        switch draft.waterTemperature {
        case .some(.celsius(let celsius)):
            add(
                .temperature,
                L10n.startingPointFieldTemperature(bundle: bundle),
                BrewFormat.value(Double(celsius), of: .temperature, locale: locale),
                inferredField: .waterTempC
            )
        case .some(.special(let special)):
            add(
                .temperature,
                L10n.startingPointFieldTemperature(bundle: bundle),
                VocabularyLabels.label(for: special, in: vocabulary, language: language),
                inferredField: .waterTempSpecial
            )
        case .none:
            break
        }
        if let seconds = draft.brewTimeS {
            add(
                .time,
                L10n.startingPointFieldTime(bundle: bundle),
                BrewTimerFormat.readout(seconds, locale: locale),
                spoken: BrewTimerFormat.spoken(seconds, locale: locale),
                inferredField: .brewTimeS
            )
        }
        if let grind = draft.value(of: .grind) {
            add(
                .grind,
                L10n.startingPointFieldGrind(bundle: bundle),
                BrewFormat.value(grind, of: .grind, locale: locale),
                inferredField: .grindNormalised
            )
        }
        return result
    }
}

/// One reference recipe on its screen, and the copy into the user's own recipes (M2-T47,
/// ADR 0034, ADR 0028).
///
/// The copy goes through the existing save path (`AccountStore.saveRecipe`): the recipe is
/// stored, and its create is queued in the outbox, in one save, so it syncs like any recipe,
/// has no name and starts a brew with one tap. The device never holds two equal recipes: a
/// recipe with the same parameters (`AccountStore.recipe(matching:)`), one the user copied
/// before or made from a brew, is not copied again, and the screen says it is already there.
/// `reload()` reads the store again; the screen calls it when it appears and after every save.
@MainActor
@Observable
final class StartingPointModel {
    let recipe: ReferenceRecipe
    let store: AccountStore
    private let now: @MainActor () -> Date

    /// The user has a recipe with these numbers: copied from here, or made otherwise.
    private(set) var isKept = false
    /// The recipe became the user's own by the last `copy()`, as opposed to being there before.
    private(set) var justCopied = false
    /// The last copy failed; nothing was written.
    private(set) var copyFailed = false
    /// The last read of the store failed.
    private(set) var loadFailed = false

    init(recipe: ReferenceRecipe, store: AccountStore, now: @escaping @MainActor () -> Date = { Date.now }) {
        self.recipe = recipe
        self.store = store
        self.now = now
    }

    func reload() {
        do {
            isKept = try store.recipe(matching: recipe.parameters) != nil
            if !isKept {
                justCopied = false
            }
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    /// Copies the recipe into the user's own recipes unless the user already has one with the
    /// same numbers. Returns whether a recipe was added.
    @discardableResult
    func copy() -> Bool {
        do {
            if try store.recipe(matching: recipe.parameters) != nil {
                isKept = true
                justCopied = false
                copyFailed = false
                return false
            }
            try store.saveRecipe(recipe.parameters, createdAt: now())
            isKept = true
            justCopied = true
            copyFailed = false
            return true
        } catch {
            copyFailed = true
            return false
        }
    }
}
