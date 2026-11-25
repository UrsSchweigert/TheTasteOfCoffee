import Foundation
import XCTest
@testable import Cupmark

/// Values for the store tests. Vocabulary values come from the generated enums (first or
/// last entry of a list), never from a list typed here, so the tests follow the vocabulary.
enum StoreFixtures {
    static let beanID = "01JD000000000000000000BEAN"
    static let shelfEntryID = "01JD0000000000000000SHELF1"
    static let brewID = "01JD00000000000000000BREW1"
    static let recipeID = "01JD000000000000000RECIPE1"

    static func first<Item: VocabularyItem>(_ type: Item.Type) throws -> Item {
        try XCTUnwrap(Item.allCases.first, "\(Item.namespace.rawValue) is empty")
    }

    static func last<Item: VocabularyItem>(_ type: Item.Type) throws -> Item {
        try XCTUnwrap(Item.allCases.last, "\(Item.namespace.rawValue) is empty")
    }

    static func day(_ text: String) throws -> API.CalendarDate {
        try XCTUnwrap(API.CalendarDate(text), "not a day: \(text)")
    }

    static func timestamp(_ text: String) throws -> API.Timestamp {
        try XCTUnwrap(API.Timestamp(rfc3339: text), "not a timestamp: \(text)")
    }

    /// A Gregorian calendar in the time zone `identifier`, as a device there would have.
    static func calendar(_ identifier: String) throws -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: identifier), "unknown time zone \(identifier)")
        return calendar
    }

    /// One score for every criterion of the bundled vocabulary, 5.0, 5.5, 6.0, ...
    static func scores() throws -> API.Scores {
        var values: [String: Double] = [:]
        for (index, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            values[criterion.rawValue] = 5 + Double(index % 10) * 0.5
        }
        return try JSONDecoder().decode(API.Scores.self, from: JSONEncoder().encode(values))
    }

    static func rating() throws -> API.Rating {
        var intensities = API.Intensities()
        let level = try first(Vocabulary.IntensityLevel.self)
        for dimension in Vocabulary.IntensityDimension.allCases {
            intensities[dimension] = level
        }
        return API.Rating(
            scores: try scores(),
            intensities: intensities,
            flavourNotes: [try first(Vocabulary.FlavourNote.self), try last(Vocabulary.FlavourNote.self)],
            buyAgain: true
        )
    }

    static func parameters() throws -> API.BrewParameters {
        API.BrewParameters(
            method: try first(Vocabulary.Method.self),
            doseDg: 180,
            waterG: 300,
            waterTemperature: .celsius(94),
            brewTimeS: 210,
            grindNormalised: 4.5,
            waterType: try first(Vocabulary.WaterType.self),
            milk: try first(Vocabulary.MilkType.self)
        )
    }

    static func brewInput(brewedAt: String = "2026-11-25T08:30:00.123Z", rated: Bool = true) throws -> API.BrewInput {
        var ratingValue: API.Rating?
        if rated {
            ratingValue = try rating()
        }
        return API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: shelfEntryID,
            brewedAt: try timestamp(brewedAt),
            parameters: try parameters(),
            rating: ratingValue
        )
    }

    static func shelfEntryInput(roastDate: String? = "2026-11-18") throws -> API.ShelfEntryInput {
        API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: beanID,
            purchaseDate: try day("2026-11-20"),
            roastDate: try roastDate.map { text in try day(text) },
            bagSize: try first(Vocabulary.BagSize.self),
            priceBand: try last(Vocabulary.PriceBand.self)
        )
    }

    static func bean() throws -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: "4006381333931",
            openFoodFactsMatch: true,
            openFoodFacts: API.OpenFoodFactsProduct(name: "Bohne", brand: "Röster", imageId: "01JD00000000000000000IMAGE"),
            pickedAttributes: API.BeanAttributes(
                process: try first(Vocabulary.Process.self),
                roastLevel: try first(Vocabulary.RoastLevel.self)
            ),
            operatorAttributes: API.BeanAttributes(
                origin: try last(Vocabulary.Origin.self),
                species: try first(Vocabulary.Species.self),
                variety: try first(Vocabulary.Variety.self)
            )
        )
    }

    /// A bean, a shelf entry and nothing else, all synced, in `store`.
    static func syncedShelfEntry(in store: AccountStore, roastDate: String? = "2026-11-18") throws -> StoredShelfEntry {
        let bean = StoredBean(try bean())
        try store.addBean(bean, syncState: .synced)
        let entry = StoredShelfEntry(try shelfEntryInput(roastDate: roastDate), serverID: shelfEntryID)
        try store.addShelfEntry(entry, bean: bean, syncState: .synced)
        return entry
    }
}
