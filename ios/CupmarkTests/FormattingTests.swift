import XCTest
@testable import Cupmark

/// Numbers, units, dates and durations go through Foundation formatters in the device locale
/// (M2-T32). Every test pins the formatter locale, so none depends on the runner's settings.
final class FormattingTests: XCTestCase {
    private let english = Locale(identifier: "en_US")
    private let german = Locale(identifier: "de_DE")

    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func languageBundle(_ language: VocabularyLanguage) throws -> Bundle {
        let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"), "no \(language.rawValue).lproj")
        return try XCTUnwrap(Bundle(path: path))
    }

    /// Foundation puts a no-break or narrow no-break space between a number and its unit in
    /// some locales; the tests compare with a plain space.
    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    // MARK: - Numbers and units

    func testGramsUseTheLocalesDecimalSeparator() {
        XCTAssertEqual(plain(BrewFormat.grams(18.5, fractionDigits: 1, locale: english)), "18.5 g")
        XCTAssertEqual(plain(BrewFormat.grams(18.5, fractionDigits: 1, locale: german)), "18,5 g")
        XCTAssertEqual(plain(BrewFormat.value(18.5, of: .dose, locale: english)), "18.5 g")
        XCTAssertEqual(plain(BrewFormat.value(18.5, of: .dose, locale: german)), "18,5 g")
        XCTAssertEqual(plain(BrewFormat.value(300, of: .water, locale: german)), "300 g")
    }

    func testTheGrindSettingAndTheScoreUseTheLocalesSeparator() {
        XCTAssertEqual(BrewFormat.value(4.5, of: .grind, locale: english), "4.5")
        XCTAssertEqual(BrewFormat.value(4.5, of: .grind, locale: german), "4,5")
        XCTAssertEqual(RatingFormat.score(8.5, locale: english), "8.5")
        XCTAssertEqual(RatingFormat.score(8.5, locale: german), "8,5")
    }

    // MARK: - The ratio and its catalogue prefix

    func testTheRatioPrefixComesFromTheCatalogueInEveryLanguage() throws {
        let en = try languageBundle(.en)
        let de = try languageBundle(.de)
        XCTAssertEqual(BrewFormat.ratio(300.0 / 18.5, locale: english, bundle: en), "1:16.2")
        XCTAssertEqual(BrewFormat.ratio(300.0 / 18.5, locale: german, bundle: de), "1:16,2")
        XCTAssertEqual(L10n.brewRatioValue("16.2", bundle: en), "1:16.2")
        XCTAssertEqual(L10n.brewRatioValue("16,2", bundle: de), "1:16,2")
        XCTAssertFalse(L10n.brewRatioValue("16.2", bundle: en).contains("%@"))
    }

    // MARK: - Dates

    private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 0, minute: Int = 0) throws -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.gmt
        return try XCTUnwrap(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)))
    }

    private func pinned(_ style: Date.FormatStyle, _ locale: Locale) -> Date.FormatStyle {
        var style = style.locale(locale)
        style.timeZone = TimeZone.gmt
        style.calendar = Calendar(identifier: .gregorian)
        return style
    }

    func testADayIsWrittenInTheDeviceLocale() throws {
        let day = try date(2026, 11, 25)
        let en = day.formatted(pinned(DisplayDate.day, english))
        let de = day.formatted(pinned(DisplayDate.day, german))
        XCTAssertEqual(en, "Nov 25, 2026")
        XCTAssertTrue(de.hasPrefix("25."), de)
        XCTAssertTrue(de.hasSuffix("2026"), de)
        XCTAssertNotEqual(en, de)
    }

    func testABrewMomentHasADayAndATimeInTheDeviceLocale() throws {
        let moment = try date(2026, 11, 25, hour: 14, minute: 5)
        let en = moment.formatted(pinned(DisplayDate.dayAndTime, english))
        let de = moment.formatted(pinned(DisplayDate.dayAndTime, german))
        XCTAssertTrue(en.contains("2:05"), en)
        XCTAssertTrue(de.contains("14:05"), de)
        XCTAssertNotEqual(en, de)
    }

    // MARK: - The brew timer

    func testTheReadoutIsMinutesAndSecondsAndHoursOnlyFromOneHour() {
        for locale in [english, german] {
            XCTAssertEqual(BrewTimerFormat.readout(0, locale: locale), "0:00")
            XCTAssertEqual(BrewTimerFormat.readout(9, locale: locale), "0:09")
            XCTAssertEqual(BrewTimerFormat.readout(150, locale: locale), "2:30")
            XCTAssertEqual(BrewTimerFormat.readout(3_599, locale: locale), "59:59")
            XCTAssertEqual(BrewTimerFormat.readout(3_600, locale: locale), "1:00:00", "beyond 59:59 the hours join")
            XCTAssertEqual(BrewTimerFormat.readout(3_723, locale: locale), "1:02:03")
            XCTAssertEqual(BrewTimerFormat.readout(172_800, locale: locale), "48:00:00", "the largest brew_time_s; hours never roll into days")
            XCTAssertEqual(BrewTimerFormat.readout(-5, locale: locale), "0:00", "never negative")
        }
    }

    // MARK: - Data for the server and files stay locale-independent

    func testTheExportFileNameDoesNotDependOnTheLocale() throws {
        let day = try date(2026, 11, 25, hour: 12)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.gmt
        let name = ExportFileStore.fileName(for: day, calendar: calendar)
        XCTAssertTrue(name.contains("2026-11-25"), name)
        XCTAssertFalse(name.contains(","), name)
    }
}
