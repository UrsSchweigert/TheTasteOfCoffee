import XCTest
@testable import Cupmark

/// The coffee look (M2-T41, ADR 0032): the colour sets are read from the asset catalogue JSON
/// in the source tree (`#filePath`, so no bundle is needed) and every text and tint pairing the
/// ADR lists is checked at 4.5:1 or better in both appearances. The same check runs on Linux in
/// `scripts/ios-colours.test.mjs`.
final class ThemeColourTests: XCTestCase {
    struct RGB: Equatable {
        let red: Double
        let green: Double
        let blue: Double

        /// WCAG 2.x relative luminance.
        var luminance: Double {
            func linear(_ value: Double) -> Double {
                value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }

        var hex: String {
            [red, green, blue].map { String(format: "%02X", Int(($0 * 255).rounded())) }.joined()
        }
    }

    enum Appearance: String, CaseIterable {
        case light
        case dark
    }

    struct ColourSet: Decodable {
        struct Entry: Decodable {
            struct Appearance: Decodable {
                let appearance: String
                let value: String
            }

            struct Colour: Decodable {
                struct Components: Decodable {
                    let red: String
                    let green: String
                    let blue: String
                    let alpha: String
                }

                let colorSpace: String
                let components: Components

                enum CodingKeys: String, CodingKey {
                    case colorSpace = "color-space"
                    case components
                }
            }

            let appearances: [Appearance]?
            let color: Colour
        }

        let colors: [Entry]
    }

    static let names = ["AccentColor", "OnAccent", "FormBackground", "ListBackground", "Surface", "TextPrimary", "TextSecondary", "SwipeAction", "SwipeActionSecondary", "ErrorText"]

    /// Every pairing of ADR 0032, point 2: foreground, background.
    static let pairings: [(foreground: String, background: String)] = [
        ("AccentColor", "FormBackground"),
        ("AccentColor", "ListBackground"),
        ("AccentColor", "Surface"),
        ("TextPrimary", "FormBackground"),
        ("TextPrimary", "ListBackground"),
        ("TextPrimary", "Surface"),
        ("TextSecondary", "FormBackground"),
        ("TextSecondary", "ListBackground"),
        ("TextSecondary", "Surface"),
        ("OnAccent", "AccentColor"),
        // The system draws a swipe action's label in white.
        ("White", "SwipeAction"),
        ("White", "SwipeActionSecondary"),
        ("ErrorText", "FormBackground"),
        ("ErrorText", "ListBackground"),
        ("ErrorText", "Surface")
    ]

    static let minimumContrast = 4.5

    private static var assetsURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Cupmark")
            .appendingPathComponent("Assets.xcassets")
    }

    /// The light and dark values of one colour set.
    static func load(_ name: String) throws -> [Appearance: RGB] {
        let url = assetsURL.appendingPathComponent("\(name).colorset").appendingPathComponent("Contents.json")
        let set = try JSONDecoder().decode(ColourSet.self, from: Data(contentsOf: url))
        var result: [Appearance: RGB] = [:]
        for entry in set.colors {
            let isDark = entry.appearances?.contains { $0.appearance == "luminosity" && $0.value == "dark" } ?? false
            let appearance: Appearance = isDark ? .dark : .light
            XCTAssertEqual(entry.color.colorSpace, "srgb", "\(name) \(appearance)")
            XCTAssertEqual(Double(entry.color.components.alpha), 1, "\(name) \(appearance) is opaque")
            guard let red = Double(entry.color.components.red),
                  let green = Double(entry.color.components.green),
                  let blue = Double(entry.color.components.blue) else {
                throw ColourError.notANumber(name)
            }
            result[appearance] = RGB(red: red, green: green, blue: blue)
        }
        return result
    }

    enum ColourError: Error {
        case notANumber(String)
    }

    static func contrast(_ first: RGB, _ second: RGB) -> Double {
        let high = max(first.luminance, second.luminance)
        let low = min(first.luminance, second.luminance)
        return (high + 0.05) / (low + 0.05)
    }

    static func loadAll() throws -> [String: [Appearance: RGB]] {
        var sets: [String: [Appearance: RGB]] = [:]
        for name in names {
            sets[name] = try load(name)
        }
        sets["White"] = [.light: RGB(red: 1, green: 1, blue: 1), .dark: RGB(red: 1, green: 1, blue: 1)]
        return sets
    }

    /// Pairings below the minimum, as readable lines. Public to the tests so a failing value can
    /// be shown to be caught.
    static func failures(in sets: [String: [Appearance: RGB]]) -> [String] {
        var failures: [String] = []
        for pairing in pairings {
            for appearance in Appearance.allCases {
                guard let foreground = sets[pairing.foreground]?[appearance],
                      let background = sets[pairing.background]?[appearance] else {
                    failures.append("\(pairing.foreground) or \(pairing.background) has no \(appearance) value")
                    continue
                }
                let ratio = contrast(foreground, background)
                if ratio < minimumContrast {
                    failures.append("\(pairing.foreground) on \(pairing.background) (\(appearance)) is \(ratio):1")
                }
            }
        }
        return failures
    }

    func testEverySetHasALightAndADarkValue() throws {
        let sets = try Self.loadAll()
        for name in Self.names {
            XCTAssertEqual(Set(sets[name]?.keys.map(\.rawValue) ?? []), ["light", "dark"], name)
        }
    }

    func testValuesAreTheOnesOfADR0032() throws {
        let sets = try Self.loadAll()
        let expected: [String: (light: String, dark: String)] = [
            "AccentColor": ("6B4428", "E0B27E"),
            "OnAccent": ("FFFBF4", "1B120D"),
            "FormBackground": ("F4EBDD", "1B120D"),
            "ListBackground": ("F7F0E6", "1E1510"),
            "Surface": ("FFFBF4", "2A1E17"),
            "TextPrimary": ("2B1D14", "F3E9DC"),
            "TextSecondary": ("5E4B3C", "BFAE9C"),
            "SwipeAction": ("6B4428", "8A5A36"),
            "SwipeActionSecondary": ("5E4B3C", "6B5645"),
            "ErrorText": ("A3261A", "FF9B8F")
        ]
        for (name, values) in expected {
            XCTAssertEqual(sets[name]?[.light]?.hex, values.light, "\(name) light")
            XCTAssertEqual(sets[name]?[.dark]?.hex, values.dark, "\(name) dark")
        }
    }

    func testEveryPairingPassesAtFourPointFiveToOneInBothAppearances() throws {
        let sets = try Self.loadAll()
        XCTAssertEqual(Self.failures(in: sets), [])
    }

    func testAChangedValueThatFailsIsCaught() throws {
        var sets = try Self.loadAll()
        // Secondary text turned into a pale tan on cream, and an accent as dark as its background.
        sets["TextSecondary"]?[.light] = RGB(red: 0.75, green: 0.70, blue: 0.65)
        let formBackgroundDark = sets["FormBackground"]?[.dark]
        sets["AccentColor"]?[.dark] = formBackgroundDark
        let failures = Self.failures(in: sets)
        XCTAssertTrue(failures.contains { $0.hasPrefix("TextSecondary on FormBackground (light)") }, "\(failures)")
        XCTAssertTrue(failures.contains { $0.hasPrefix("AccentColor on FormBackground (dark)") }, "\(failures)")
        XCTAssertTrue(failures.contains { $0.hasPrefix("OnAccent on AccentColor (dark)") }, "\(failures)")
    }

    func testBlackOnWhiteIsTwentyOneToOne() {
        let ratio = Self.contrast(RGB(red: 0, green: 0, blue: 0), RGB(red: 1, green: 1, blue: 1))
        XCTAssertEqual(ratio, 21, accuracy: 0.001)
    }
}
