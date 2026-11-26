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

    /// Format placeholders in `text`: `%@`, `%1$@`, `%d`, `%ld`, `%lld`, `%f`, `%s`. `%%` is not one.
    /// The same pattern as `placeholderCount` in `scripts/check-ios-strings.mjs`.
    private func placeholderCount(_ text: String) -> Int {
        guard let pattern = try? NSRegularExpression(pattern: "%(?:\\d+\\$)?(?:l{0,2}[dfs]|@)") else {
            XCTFail("placeholder pattern does not compile")
            return 0
        }
        let range = NSRange(text.startIndex..., in: text)
        return pattern.numberOfMatches(in: text, range: range)
    }

    func testPlaceholdersAreCountedPositionalAndPlain() {
        XCTAssertEqual(placeholderCount("Step %1$@ of %2$@"), 2)
        XCTAssertEqual(placeholderCount("onboarding.step %@ %@"), 2)
        XCTAssertEqual(placeholderCount("%d of %ld and %lld, %f %s"), 5)
        XCTAssertEqual(placeholderCount("100%% done"), 0)
        XCTAssertEqual(placeholderCount("No placeholder"), 0)
    }

    /// `scripts/check-ios-strings.mjs` proves every key of `L10n.swift` is in the catalogue, and
    /// the catalogue has no other key; the compiled tables here are that catalogue. A key with
    /// `%@` in a language that drops it would show a broken sentence.
    func testEveryFormatKeyKeepsItsPlaceholdersInEveryLanguage() throws {
        let tables = try VocabularyLanguage.allCases.map { try table($0.rawValue) }
        var formatKeys = 0
        for key in try table(VocabularyLanguage.fallback.rawValue).keys {
            for strings in tables {
                XCTAssertEqual(placeholderCount(strings[key] ?? ""), placeholderCount(key), key)
            }
            if key.contains("%@") { formatKeys += 1 }
        }
        XCTAssertGreaterThan(formatKeys, 0)
    }

    func testTheFormatFunctionsOfL10nResolveInEveryLanguage() throws {
        for language in VocabularyLanguage.allCases {
            let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"))
            let bundle = try XCTUnwrap(Bundle(path: path))
            let text = L10n.brewRatioValue("16.2", bundle: bundle)
            XCTAssertTrue(text.contains("16.2"), "\(language.rawValue): \(text)")
            XCTAssertFalse(text.contains("%@"), "\(language.rawValue): \(text)")
            XCTAssertFalse(text.hasPrefix("brew.ratio"), "\(language.rawValue) is not translated: \(text)")
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
