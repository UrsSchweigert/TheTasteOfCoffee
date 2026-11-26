import XCTest
@testable import Cupmark

/// What VoiceOver reads as the value of a score, a grind or a grind setting (M2-T33): the value
/// on its scale, in each language of the String Catalog, with explicit locales and bundles.
final class AccessibilityValueTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func bundle(_ language: VocabularyLanguage) throws -> Bundle {
        let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"), "no \(language.rawValue).lproj")
        return try XCTUnwrap(Bundle(path: path))
    }

    private let english = Locale(identifier: "en_US")
    private let german = Locale(identifier: "de_DE")

    func testAScoreReadsOnItsScaleInEnglish() throws {
        XCTAssertEqual(RatingFormat.spokenScore(7.5, locale: english, bundle: try bundle(.en)), "7.5 of 10")
    }

    func testAScoreReadsOnItsScaleInGerman() throws {
        XCTAssertEqual(RatingFormat.spokenScore(7.5, locale: german, bundle: try bundle(.de)), "7,5 von 10")
    }

    func testTheTopOfTheScaleHasOnlyTheDigitsItNeeds() throws {
        // The score keeps the scale's one decimal ("10.0"); the top of the scale does not.
        XCTAssertEqual(RatingFormat.spokenScore(RatingDraft.scale.maximum, locale: english, bundle: try bundle(.en)), "10.0 of 10")
        XCTAssertEqual(AccessibilityValue.ofScale("12", maximum: 40, locale: english, bundle: try bundle(.en)), "12 of 40")
        XCTAssertEqual(AccessibilityValue.ofScale("9,5", maximum: 10.5, locale: german, bundle: try bundle(.de)), "9,5 von 10,5")
    }

    func testTheScaleIsTheVocabularysScale() throws {
        // The maximum is read from Vocabulary.Ranges.scale, never typed: a changed scale changes it.
        let maximum = RatingDraft.scale.maximum.formatted(FloatingPointFormatStyle<Double>(locale: english))
        XCTAssertTrue(RatingFormat.spokenScore(RatingDraft.scale.minimum, locale: english, bundle: try bundle(.en)).hasSuffix(" of \(maximum)"))
    }

    func testEveryLanguageResolvesTheFormatWithBothNumbers() throws {
        for language in VocabularyLanguage.allCases {
            let text = AccessibilityValue.ofScale("3", maximum: 7, locale: english, bundle: try bundle(language))
            XCTAssertTrue(text.contains("3") && text.contains("7"), "\(language.rawValue): \(text)")
            XCTAssertFalse(text.contains("%@") || text.hasPrefix("accessibility."), "\(language.rawValue) is not translated: \(text)")
        }
    }
}
