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
    /// The first of the bundle's preferred localizations that has labels,
    /// otherwise the fallback language.
    static func preferred(in bundle: Bundle) -> VocabularyLanguage {
        for localization in bundle.preferredLocalizations {
            let code = Locale(identifier: localization).language.languageCode?.identifier ?? localization
            if let language = VocabularyLanguage(rawValue: code) {
                return language
            }
        }
        return .fallback
    }
}
