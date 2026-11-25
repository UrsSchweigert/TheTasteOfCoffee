import XCTest
@testable import Cupmark

/// The String Catalog compiles into one table per language. Every key must
/// exist in English and German with a non-empty value.
final class LocalizationTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func table(_ language: String) throws -> [String: String] {
        let path = try XCTUnwrap(
            appBundle.path(forResource: "Localizable", ofType: "strings", inDirectory: nil, forLocalization: language),
            "no compiled Localizable.strings for \(language)"
        )
        let dictionary = try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
        return dictionary
    }

    func testAppIsLocalizedInEnglishAndGerman() {
        let localizations = Set(appBundle.localizations)
        for language in VocabularyLanguage.allCases {
            XCTAssertTrue(localizations.contains(language.rawValue), "\(language.rawValue) is not a bundle localization")
        }
    }

    func testEveryCatalogKeyHasANonEmptyValueInEveryLanguage() throws {
        let source = try table(VocabularyLanguage.fallback.rawValue)
        XCTAssertFalse(source.isEmpty)
        for language in VocabularyLanguage.allCases {
            let strings = try table(language.rawValue)
            XCTAssertEqual(Set(strings.keys), Set(source.keys), "keys differ in \(language.rawValue)")
            for (key, value) in strings {
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(language.rawValue) \(key)")
                XCTAssertNotEqual(value, key, "\(language.rawValue) \(key) is not translated")
            }
        }
    }
}
