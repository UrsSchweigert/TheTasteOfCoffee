import Foundation

/// One entry of a closed vocabulary list. Every generated enum in
/// `Generated/Vocabulary.swift` conforms; its raw value is the contract id.
protocol VocabularyItem: RawRepresentable, CaseIterable, Hashable, Codable, Identifiable, Sendable
where RawValue == String, AllCases == [Self], ID == String {
    /// The list this entry belongs to.
    static var namespace: Vocabulary.Namespace { get }
}

extension VocabularyItem {
    var id: String { rawValue }
}

/// A numeric range from the vocabulary: inclusive bounds and a step.
struct VocabularyRange: Equatable, Sendable {
    let minimum: Double
    let maximum: Double
    let multipleOf: Double

    /// Number of steps from minimum to maximum.
    var stepCount: Int {
        Int(((maximum - minimum) / multipleOf).rounded())
    }

    /// Whether `value` lies within the bounds and on a step from the minimum.
    func contains(_ value: Double) -> Bool {
        guard value >= minimum, value <= maximum else { return false }
        let steps = (value - minimum) / multipleOf
        return abs(steps - steps.rounded()) < 1e-9
    }
}

extension VocabularyLanguage {
    /// The one language rule of the app (M2-T32): German when the first preferred language is
    /// German (`de`, `de-CH`, `de-AT` and so on), otherwise English. The profile's `locale`
    /// (`OnboardingRules.profileLocale`) and the language of every vocabulary label use this
    /// function, so they never disagree. A label missing in this language falls back to
    /// `VocabularyLanguage.fallback` (`VocabularyStore.label`).
    static func resolving(preferredLanguages: [String]) -> VocabularyLanguage {
        guard let first = preferredLanguages.first else {
            return .fallback
        }
        let code: Locale.LanguageCode? = Locale.Language(identifier: first).languageCode
        return code == Locale.LanguageCode.german ? .de : .fallback
    }

    /// The language for the device's preferred languages (`Locale.preferredLanguages`, which
    /// follows the per-app language setting).
    static var current: VocabularyLanguage {
        resolving(preferredLanguages: Locale.preferredLanguages)
    }
}
