import XCTest
@testable import Cupmark

/// The camera permission prompt (M2-T13): set in Info.plist and localised in English and German
/// through InfoPlist.xcstrings. Without it, iOS terminates the app when the scanner starts.
final class CameraPermissionStringTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    func testInfoPlistHasACameraUsageDescription() throws {
        let value = try XCTUnwrap(appBundle.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String)
        XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func testTheCameraUsageDescriptionIsLocalizedInEveryLanguage() throws {
        var values: [String] = []
        for language in VocabularyLanguage.allCases {
            let path = try XCTUnwrap(
                appBundle.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: language.rawValue),
                "no compiled InfoPlist.strings for \(language.rawValue)"
            )
            let table = try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
            let value = try XCTUnwrap(table["NSCameraUsageDescription"], language.rawValue)
            XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, language.rawValue)
            values.append(value)
        }
        XCTAssertEqual(Set(values).count, values.count, "a language is not translated")
    }
}
