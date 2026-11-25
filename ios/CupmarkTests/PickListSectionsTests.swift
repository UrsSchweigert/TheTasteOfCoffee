import XCTest
@testable import Cupmark

/// The origin grouping by country (ADR 0011) and the A to Z sections of the long pick lists
/// (M2-T22).
final class PickListSectionsTests: XCTestCase {
    private let english = Locale(identifier: "en")
    private let german = Locale(identifier: "de")

    private func store() throws -> VocabularyStore {
        try VocabularyStore.load(from: Bundle(for: AppBundleToken.self))
    }

    // MARK: - Grouping by country

    func testEveryOriginIsInExactlyOneGroup() {
        let groups = Vocabulary.Origin.groupedByCountry
        let listed = groups.flatMap { [$0.country] + $0.regions }
        XCTAssertEqual(listed.count, Vocabulary.Origin.allCases.count)
        XCTAssertEqual(Set(listed), Set(Vocabulary.Origin.allCases))
    }

    func testRegionsAreGroupedUnderTheirCountry() throws {
        let groups = Vocabulary.Origin.groupedByCountry
        // Every group heads with a top-level entry and holds only entries naming it.
        for group in groups {
            XCTAssertNil(group.country.country, "\(group.country) heads a group but is a region")
            for region in group.regions {
                XCTAssertEqual(region.country, group.country)
            }
        }
        let indonesia = try XCTUnwrap(groups.first { $0.country == .indonesia })
        XCTAssertEqual(Set(indonesia.regions), [.sumatra, .java, .sulawesi, .bali, .flores])
        let usa = try XCTUnwrap(groups.first { $0.country == .usa })
        XCTAssertEqual(usa.regions, [.hawaii])
        XCTAssertNil(groups.first { $0.country == .sumatra }, "a region is never a group of its own")
    }

    func testOtherUnknownAndBlendAreOfferedAsTopLevelEntries() {
        let countries = Vocabulary.Origin.groupedByCountry.map(\.country)
        XCTAssertTrue(countries.contains(.other))
        XCTAssertTrue(countries.contains(.unknown))
        XCTAssertTrue(countries.contains(.blend))
    }

    func testTheGroupsKeepVocabularyOrder() {
        let countries = Vocabulary.Origin.groupedByCountry.map(\.country)
        XCTAssertEqual(countries, Vocabulary.Origin.allCases.filter { $0.country == nil })
    }

    // MARK: - Origin sections

    func testOriginSectionsPutRegionsRightAfterTheirCountry() throws {
        let sections = PickListSections.origins(locale: english) { $0.rawValue }
        let rows = sections.flatMap(\.rows)
        XCTAssertEqual(rows.count, Vocabulary.Origin.allCases.count)
        XCTAssertEqual(Set(rows.map(\.item)), Set(Vocabulary.Origin.allCases))

        let indonesiaIndex = try XCTUnwrap(rows.firstIndex { $0.item == .indonesia })
        let regions = rows[(indonesiaIndex + 1)...].prefix { $0.isRegion }
        // Under the country, sorted by label (here the id).
        XCTAssertEqual(regions.map(\.item), [.bali, .flores, .java, .sulawesi, .sumatra])
        XCTAssertFalse(rows[indonesiaIndex].isRegion)

        let usaIndex = try XCTUnwrap(rows.firstIndex { $0.item == .usa })
        XCTAssertEqual(rows[usaIndex + 1].item, .hawaii)
        XCTAssertTrue(rows[usaIndex + 1].isRegion)

        // Every region row follows its country or a sibling region.
        for (index, row) in rows.enumerated() where row.isRegion {
            let country = try XCTUnwrap(row.item.country)
            let head = rows[..<index].last { !$0.isRegion }
            XCTAssertEqual(head?.item, country, "\(row.item) is not under \(country)")
        }
    }

    func testARegionStaysUnderItsCountrysLetter() throws {
        let sections = PickListSections.origins(locale: english) { $0.rawValue }
        let i = try XCTUnwrap(sections.first { $0.letter == "I" })
        XCTAssertTrue(i.rows.contains { $0.item == .sumatra })
        let s = sections.first { $0.letter == "S" }
        XCTAssertFalse(s?.rows.contains { $0.item == .sumatra } ?? false)
    }

    func testCountriesAreSortedByLabelInLetterSections() {
        let sections = PickListSections.origins(locale: english) { $0.rawValue }
        let letters = sections.map(\.letter)
        XCTAssertEqual(letters, letters.sorted())
        XCTAssertEqual(Set(letters).count, letters.count, "one section per letter")
        let countries = sections.flatMap(\.rows).filter { !$0.isRegion }.map(\.label)
        XCTAssertEqual(countries, countries.sorted())
        for section in sections {
            let head = section.rows.first
            XCTAssertEqual(head.map { PickListSections.indexLetter(for: $0.label, locale: english) }, section.letter)
            XCTAssertEqual(head?.isRegion, false)
        }
    }

    func testGermanLabelsSortIgnoringDiacritics() throws {
        let vocabulary = try store()
        let sections = PickListSections.origins(locale: german) { origin in
            VocabularyLabels.label(for: origin, in: vocabulary, language: .de)
        }
        // "Äthiopien" is under A, not after Z.
        let a = try XCTUnwrap(sections.first { $0.letter == "A" })
        XCTAssertTrue(a.rows.contains { $0.item == .ethiopia })
        XCTAssertEqual(sections.flatMap(\.rows).count, Vocabulary.Origin.allCases.count)
        let indonesien = try XCTUnwrap(sections.first { $0.letter == "I" })
        XCTAssertTrue(indonesien.rows.contains { $0.item == .bali && $0.isRegion })
    }

    // MARK: - Alphabetical lists

    func testVarietiesAreSortedAndSectionedByLetter() throws {
        let vocabulary = try store()
        let sections = PickListSections.alphabetical(Vocabulary.Variety.self, locale: english) { variety in
            VocabularyLabels.label(for: variety, in: vocabulary, language: .en)
        }
        let rows = sections.flatMap(\.rows)
        XCTAssertEqual(Set(rows.map(\.item)), Set(Vocabulary.Variety.allCases))
        XCTAssertEqual(rows.count, Vocabulary.Variety.allCases.count)
        XCTAssertFalse(rows.contains { $0.isRegion })
        XCTAssertTrue(rows.contains { $0.item == .other })
        XCTAssertTrue(rows.contains { $0.item == .unknown })
        for pair in zip(rows, rows.dropFirst()) {
            XCTAssertTrue(PickListSections.precedes(pair.0, pair.1, locale: english), "\(pair.0.label) before \(pair.1.label)")
        }
        for section in sections {
            for row in section.rows {
                XCTAssertEqual(PickListSections.indexLetter(for: row.label, locale: english), section.letter)
            }
        }
    }

    func testIndexLetters() {
        XCTAssertEqual(PickListSections.indexLetter(for: "Äthiopien", locale: german), "A")
        XCTAssertEqual(PickListSections.indexLetter(for: "côte", locale: english), "C")
        XCTAssertEqual(PickListSections.indexLetter(for: "74110", locale: english), PickListSections.otherLetter)
        XCTAssertEqual(PickListSections.indexLetter(for: "", locale: english), PickListSections.otherLetter)
    }
}
