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
    /// The one language rule of the app (M2-T32): the first preferred language whose language
    /// code is German or English, in any region or script (`de-CH`, `de-AT`, `de-Latn`, `en-GB`);
    /// every other language (`fr`, `it`, ...) is skipped, and if none matches, English. This is
    /// the language the UI text shows (the app is localised in these two only, and iOS picks
    /// the first supported one), so labels and UI text never mix languages. The profile's
    /// `locale` (`OnboardingRules.profileLocale`) and every vocabulary label use this function.
    /// A label missing in this language falls back to `VocabularyLanguage.fallback`
    /// (`VocabularyStore.label`).
    static func resolving(preferredLanguages: [String]) -> VocabularyLanguage {
        for identifier in preferredLanguages {
            let code = Locale.Language(identifier: identifier).languageCode
            if code == Locale.LanguageCode.german {
                return .de
            }
            if code == Locale.LanguageCode.english {
                return .en
            }
        }
        return .fallback
    }

    /// The language for the device's preferred languages (`Locale.preferredLanguages`, which
    /// follows the per-app language setting).
    static var current: VocabularyLanguage {
        resolving(preferredLanguages: Locale.preferredLanguages)
    }
}
