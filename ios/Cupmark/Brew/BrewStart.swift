import Foundation

/// What a new brew starts from (M2-T27, docs/04 F2). A repeat opens the brew form prefilled
/// with every parameter, the timer ready, so it can be saved at once and rated.
enum BrewStart: Hashable, Sendable {
    /// An empty form; only the method of the bag's latest brew is preselected (M2-T19).
    case blank
    /// A copy of the last brew (`AccountStore.lastBrewToRepeat(for:)`): the bag's newest brew,
    /// or the newest brew on the device.
    case lastBrew
    /// A copy of the recipe with this local id.
    case recipe(UUID)
}

/// How a recipe, or the brew a repeat copies, is shown. A recipe has no name (invariant 1),
/// so it is shown by its method, dose, ratio, temperature and grind, each only when set.
struct BrewSummary: Equatable, Sendable {
    let draft: BrewDraft

    init(_ draft: BrewDraft) {
        self.draft = draft
    }

    /// The method, nil for one the bundled vocabulary does not know.
    var method: Vocabulary.Method? {
        draft.method
    }

    /// The dose, ratio, temperature and grind that are set, in that order, as shown in
    /// `locale`. `special` gives the label of a `water_temp_special` value (`cold`).
    func details(locale: Locale = .current, special: (Vocabulary.WaterTempSpecial) -> String) -> [String] {
        var parts: [String] = []
        if let dose = draft.value(of: .dose) {
            parts.append(BrewFormat.value(dose, of: .dose, locale: locale))
        }
        if let ratio = draft.ratio {
            parts.append(BrewFormat.ratio(ratio, locale: locale))
        }
        switch draft.waterTemperature {
        case .some(.celsius(let celsius)):
            parts.append(BrewFormat.value(Double(celsius), of: .temperature, locale: locale))
        case .some(.special(let value)):
            parts.append(special(value))
        case .none:
            break
        }
        if let grind = draft.value(of: .grind) {
            parts.append(L10n.recipeGrindValue(BrewFormat.value(grind, of: .grind, locale: locale)))
        }
        return parts
    }

    /// `details` as one line, joined with the catalogue's separator (`recipe.summary.separator`,
    /// " · "), so no conjunction is read into a list of values.
    func detailLine(locale: Locale = .current, special: (Vocabulary.WaterTempSpecial) -> String) -> String {
        details(locale: locale, special: special).joined(separator: L10n.recipeSummarySeparator)
    }
}
