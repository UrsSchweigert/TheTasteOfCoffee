import XCTest
@testable import Cupmark

/// The generated API types (Generated/API.swift, M2-T7): JSON round trips, the
/// integer dose, the single water temperature, dates, and decoding of ids the
/// bundled vocabulary does not know. Vocabulary values are taken from the
/// generated enums (`allCases.first`), never typed here.
final class APITypesTests: XCTestCase {
    /// An id that is in no vocabulary list.
    private let unknownId = "zz_not_in_any_vocabulary"

    // MARK: - Helpers

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private func first<T: VocabularyItem>(_ type: T.Type) throws -> T {
        try XCTUnwrap(T.allCases.first, "\(T.self) has no entries")
    }

    private func last<T: VocabularyItem>(_ type: T.Type) throws -> T {
        try XCTUnwrap(T.allCases.last, "\(T.self) has no entries")
    }

    /// A server-style ULID; `n` is 0 to 9.
    private func id(_ n: Int) -> API.Id {
        "01JDQ6Y8Z5W4V3T2S1R0P9N8M" + String(n)
    }

    private func timestamp(_ text: String) throws -> API.Timestamp {
        try XCTUnwrap(API.Timestamp(rfc3339: text), text)
    }

    private func day(_ text: String) throws -> API.CalendarDate {
        try XCTUnwrap(API.CalendarDate(text), text)
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try encoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// `object` with the value at `path` replaced.
    private func replacing(_ path: [String], with value: Any, in object: [String: Any]) -> [String: Any] {
        guard let key = path.first else {
            return object
        }
        var copy = object
        if path.count == 1 {
            copy[key] = value
        } else {
            let child = copy[key] as? [String: Any] ?? [:]
            copy[key] = replacing(Array(path.dropFirst()), with: value, in: child)
        }
        return copy
    }

    // MARK: - Samples, every optional property set

    private func makeAttributes() throws -> API.BeanAttributes {
        try API.BeanAttributes(
            process: first(Vocabulary.Process.self),
            roastLevel: first(Vocabulary.RoastLevel.self),
            origin: last(Vocabulary.Origin.self),
            species: first(Vocabulary.Species.self),
            variety: last(Vocabulary.Variety.self)
        )
    }

    private func makeParameters() throws -> API.BrewParameters {
        var parameters = try API.BrewParameters(
            method: first(Vocabulary.Method.self),
            waterG: 300,
            waterTemperature: .celsius(94),
            brewTimeS: 180,
            grindNormalised: 5.5,
            waterType: first(Vocabulary.WaterType.self),
            milk: last(Vocabulary.MilkType.self),
            grinder: first(Vocabulary.Grinder.self),
            grindSetting: 30.5
        )
        parameters.doseGrams = 18.5
        return parameters
    }

    private func makeShelfEntry() throws -> API.ShelfEntry {
        let values = try API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: id(2),
            purchaseDate: day("2026-11-20"),
            roastDate: day("2026-11-12"),
            bagSize: first(Vocabulary.BagSize.self),
            priceBand: last(Vocabulary.PriceBand.self)
        )
        return API.ShelfEntry(shelfEntryId: id(4), values: values)
    }

    private func makeBrew() throws -> API.Brew {
        let scores = API.Scores(aroma: 7.5, flavour: 8, aftertaste: 6.5, acidity: 7, body: 6, sweetness: 8.5, balance: 7, overall: 8)
        let intensities = try API.Intensities(
            acidity: first(Vocabulary.IntensityLevel.self),
            body: last(Vocabulary.IntensityLevel.self),
            bitterness: first(Vocabulary.IntensityLevel.self)
        )
        let notes = Array(Vocabulary.FlavourNote.allCases.prefix(Vocabulary.Constants.maxPicks))
        let rating = API.Rating(scores: scores, intensities: intensities, flavourNotes: notes, buyAgain: true)
        let values = try API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: id(4),
            brewedAt: timestamp("2026-11-25T08:30:00.123Z"),
            parameters: makeParameters(),
            rating: rating
        )
        return API.Brew(brewId: id(5), values: values)
    }

    private func makeRecipe() throws -> API.Recipe {
        var parameters = try makeParameters()
        let special = try first(Vocabulary.WaterTempSpecial.self)
        parameters.waterTemperature = .special(special)
        return API.Recipe(recipeId: id(6), values: API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters))
    }

    private func samples() throws -> [any APIObject] {
        let attributes = try makeAttributes()
        let product = API.OpenFoodFactsProduct(name: "Example product", brand: "Example roaster", imageId: id(1))
        let bean = API.Bean(
            beanId: id(2),
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: "4006381333931",
            openFoodFactsMatch: true,
            openFoodFacts: product,
            pickedAttributes: attributes,
            operatorAttributes: API.BeanAttributes()
        )
        let create = API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: "4006381333931",
            openFoodFactsConfirmed: true,
            attributes: attributes
        )
        let fields = API.LabelPhotoUploadFields(
            key: "uploads/\(id(3)).jpg",
            bucket: "cupmark-test-photos",
            contentType: "image/jpeg",
            policy: "cG9saWN5",
            xAmzAlgorithm: "AWS4-HMAC-SHA256",
            xAmzCredential: "TESTCREDENTIAL0000/20261125/eu-central-1/s3/aws4_request",
            xAmzDate: "20261125T083000Z",
            xAmzSecurityToken: "dG9rZW4=",
            xAmzSignature: String(repeating: "0", count: 64)
        )
        let form = API.LabelPhotoUploadForm(url: "https://cupmark-test-photos.s3.eu-central-1.amazonaws.com/", fields: fields)
        let upload = try API.LabelPhotoUpload(
            photoId: id(3),
            upload: form,
            expiresAt: timestamp("2026-11-25T08:40:00.000Z"),
            maxBytes: 8_388_608
        )
        let shelfEntry = try makeShelfEntry()
        let shelfPage = API.ShelfEntryPage(items: [shelfEntry], nextCursor: "page_2")
        let brew = try makeBrew()
        let rating = try XCTUnwrap(brew.values.rating)
        let intensities = try XCTUnwrap(rating.intensities)
        let bareParameters = API.BrewParameters(method: brew.values.parameters.method)
        let brewPage = API.BrewPage(items: [brew, brew], nextCursor: "page_3")
        let recipe = try makeRecipe()
        let recipePage = API.RecipePage(items: [recipe], nextCursor: "page_4")
        let consent = API.Consent(contributeToAggregates: true)
        let profile = try API.Profile(locale: XCTUnwrap(VocabularyLanguage.allCases.first), consent: consent)

        var all: [any APIObject] = []
        all.append(attributes)
        all.append(API.BeanAttributes())
        all.append(create)
        all.append(bean)
        all.append(product)
        all.append(fields)
        all.append(form)
        all.append(upload)
        all.append(shelfEntry.values)
        all.append(shelfEntry)
        all.append(shelfPage)
        all.append(brew.values.parameters)
        all.append(recipe.values.parameters)
        all.append(bareParameters)
        all.append(rating.scores)
        all.append(intensities)
        all.append(rating)
        all.append(brew.values)
        all.append(brew)
        all.append(brewPage)
        all.append(recipe.values)
        all.append(recipe)
        all.append(recipePage)
        all.append(consent)
        all.append(profile)
        return all
    }

    // MARK: - Contract walk

    /// Fails on any property of `json` that `schema` does not have, and on any null; records the
    /// properties seen per schema in `seen`.
    private func assertContractProperties(
        _ json: Any,
        schema: String,
        path: String,
        seen: inout [String: Set<String>],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let object = json as? [String: Any] else {
            return XCTFail("\(path) is not a JSON object", file: file, line: line)
        }
        guard let allowed = API.Schemas.properties[schema] else {
            return XCTFail("\(schema) is not a generated schema", file: file, line: line)
        }
        let nested = API.Schemas.nested[schema] ?? [:]
        seen[schema, default: []].formUnion(object.keys)
        for (key, value) in object {
            XCTAssertTrue(allowed.contains(key), "\(path).\(key) is not a property of \(schema)", file: file, line: line)
            XCTAssertFalse(value is NSNull, "\(path).\(key) is encoded as null", file: file, line: line)
            guard let child = nested[key] else {
                continue
            }
            if let list = value as? [Any] {
                for (index, element) in list.enumerated() {
                    assertContractProperties(element, schema: child, path: "\(path).\(key)[\(index)]", seen: &seen, file: file, line: line)
                }
            } else {
                assertContractProperties(value, schema: child, path: "\(path).\(key)", seen: &seen, file: file, line: line)
            }
        }
    }

    private func assertRoundTrip<T: APIObject>(_ value: T, seen: inout [String: Set<String>]) throws {
        let data = try encoder().encode(value)
        let decoded = try JSONDecoder().decode(T.self, from: data)
        XCTAssertEqual(decoded, value, "\(T.schemaName) changed in a JSON round trip")
        XCTAssertEqual(try encoder().encode(decoded), data, "\(T.schemaName) encodes differently after a round trip")
        let json = try JSONSerialization.jsonObject(with: data)
        assertContractProperties(json, schema: T.schemaName, path: T.schemaName, seen: &seen)
    }

    // MARK: - Round trips and unknown properties

    func testEveryGeneratedTypeRoundTripsThroughJSON() throws {
        let all = try samples()
        var seen: [String: Set<String>] = [:]
        for sample in all {
            try assertRoundTrip(sample, seen: &seen)
        }
        let covered = Set(all.map { type(of: $0).schemaName })
        XCTAssertEqual(covered, Set(API.Schemas.properties.keys), "every generated type needs a sample")
        // Together the samples set every property of every schema, so the walk saw all of them.
        for (schema, properties) in API.Schemas.properties {
            XCTAssertEqual(seen[schema] ?? [], properties, "\(schema): properties not exercised or unknown")
        }
    }

    func testPropertyNamesMatchTheContractShape() {
        let types: [any APIObject.Type] = [
            API.BeanAttributes.self, API.BeanCreate.self, API.Bean.self, API.OpenFoodFactsProduct.self,
            API.LabelPhotoUpload.self, API.LabelPhotoUploadForm.self, API.LabelPhotoUploadFields.self,
            API.ShelfEntryInput.self, API.ShelfEntry.self, API.ShelfEntryPage.self,
            API.BrewParameters.self, API.Scores.self, API.Intensities.self, API.Rating.self,
            API.BrewInput.self, API.Brew.self, API.BrewPage.self,
            API.RecipeInput.self, API.Recipe.self, API.RecipePage.self,
            API.Consent.self, API.Profile.self,
        ]
        XCTAssertEqual(Set(types.map { $0.schemaName }), Set(API.Schemas.properties.keys))
        for type in types {
            XCTAssertEqual(type.propertyNames, API.Schemas.properties[type.schemaName], type.schemaName)
        }
    }

    func testNoUnknownPropertyIsEverEncoded() throws {
        // Unset optionals are left out, not sent as null.
        let bare = try jsonObject(API.BrewParameters(method: first(Vocabulary.Method.self)))
        XCTAssertEqual(Set(bare.keys), ["method"])
        XCTAssertEqual(Set(try jsonObject(API.BeanAttributes()).keys), [])

        // undecodableItems is never encoded.
        let good = try jsonObject(makeBrew())
        let bad = replacing(["values", "parameters", "method"], with: unknownId, in: good)
        let data = try JSONSerialization.data(withJSONObject: ["items": [good, bad]])
        let page = try JSONDecoder().decode(API.BrewPage.self, from: data)
        XCTAssertEqual(page.undecodableItems.count, 1)
        XCTAssertEqual(Set(try jsonObject(page).keys), ["items"])

        // Every key that is encoded is a contract property, at every depth.
        var seen: [String: Set<String>] = [:]
        for sample in try samples() {
            let json = try JSONSerialization.jsonObject(with: encoder().encode(sample))
            assertContractProperties(json, schema: type(of: sample).schemaName, path: "sample", seen: &seen)
        }
    }

    // MARK: - Dose (ADR 0004)

    func testDoseOf18Point5GramsEncodesAsDoseDg185() throws {
        var parameters = try API.BrewParameters(method: first(Vocabulary.Method.self))
        parameters.doseGrams = 18.5
        XCTAssertEqual(parameters.doseDg, 185)
        let data = try encoder().encode(parameters)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"dose_dg\":185"), String(decoding: data, as: UTF8.self))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["dose_dg"] as? Int, 185)
        XCTAssertEqual(try XCTUnwrap(parameters.doseGrams), 18.5, accuracy: 1e-9)
    }

    func testDoseGramsRoundsToADecigramAndNeverTraps() throws {
        var parameters = try API.BrewParameters(method: first(Vocabulary.Method.self))
        parameters.doseGrams = 18.3
        XCTAssertEqual(parameters.doseDg, 183)
        parameters.doseGrams = 18.04
        XCTAssertEqual(parameters.doseDg, 180)
        parameters.doseGrams = .nan
        XCTAssertNil(parameters.doseDg)
        parameters.doseGrams = .infinity
        XCTAssertNil(parameters.doseDg)
        parameters.doseGrams = 1e300
        XCTAssertNil(parameters.doseDg)
        parameters.doseGrams = nil
        XCTAssertNil(parameters.doseDg)
    }

    // MARK: - Water temperature

    func testWaterTemperatureIsOneValueOnTheWire() throws {
        let method = try first(Vocabulary.Method.self)
        let special = try first(Vocabulary.WaterTempSpecial.self)

        let celsius = try jsonObject(API.BrewParameters(method: method, waterTemperature: .celsius(94)))
        XCTAssertEqual(celsius["water_temp_c"] as? Int, 94)
        XCTAssertNil(celsius["water_temp_special"])

        let cold = try jsonObject(API.BrewParameters(method: method, waterTemperature: .special(special)))
        XCTAssertEqual(cold["water_temp_special"] as? String, special.rawValue)
        XCTAssertNil(cold["water_temp_c"])

        let decoded = try JSONDecoder().decode(API.BrewParameters.self, from: JSONSerialization.data(withJSONObject: cold))
        XCTAssertEqual(decoded.waterTemperature, .special(special))
    }

    func testBothWaterTemperaturesFailToDecode() throws {
        var object = try jsonObject(API.BrewParameters(method: first(Vocabulary.Method.self), waterTemperature: .celsius(94)))
        object["water_temp_special"] = try first(Vocabulary.WaterTempSpecial.self).rawValue
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try JSONDecoder().decode(API.BrewParameters.self, from: data)) { error in
            guard case DecodingError.dataCorrupted = error else {
                return XCTFail("expected dataCorrupted, got \(error)")
            }
        }
    }

    // MARK: - Unknown vocabulary ids

    func testABrewWithAnUnknownIdFailsAloneInItsPage() throws {
        XCTAssertNil(Vocabulary.Method(rawValue: unknownId))
        XCTAssertNil(Vocabulary.FlavourNote(rawValue: unknownId))
        let brew = try makeBrew()
        let good = try jsonObject(brew)
        let badMethod = replacing(["values", "parameters", "method"], with: unknownId, in: good)
        let badNote = replacing(["values", "rating", "flavour_notes"], with: [unknownId], in: good)
        let body: [String: Any] = ["items": [good, badMethod, good, badNote], "next_cursor": "page_2"]
        let data = try JSONSerialization.data(withJSONObject: body)

        let page = try JSONDecoder().decode(API.BrewPage.self, from: data)
        XCTAssertEqual(page.items, [brew, brew])
        XCTAssertEqual(page.nextCursor, "page_2")
        XCTAssertEqual(page.undecodableItems.map(\.index), [1, 3])
        XCTAssertEqual(page.undecodableItems.map(\.property), ["items", "items"])

        // The same item on its own throws a decoding error; it never traps.
        for bad in [badMethod, badNote] {
            let single = try JSONSerialization.data(withJSONObject: bad)
            XCTAssertThrowsError(try JSONDecoder().decode(API.Brew.self, from: single)) { error in
                XCTAssertTrue(error is DecodingError, "\(error)")
            }
        }
    }

    func testShelfEntriesAndRecipesWithUnknownIdsFailAlone() throws {
        let entry = try makeShelfEntry()
        let goodEntry = try jsonObject(entry)
        let badEntry = replacing(["values", "bag_size"], with: unknownId, in: goodEntry)
        let shelf = try JSONDecoder().decode(
            API.ShelfEntryPage.self,
            from: JSONSerialization.data(withJSONObject: ["items": [badEntry, goodEntry]])
        )
        XCTAssertEqual(shelf.items, [entry])
        XCTAssertEqual(shelf.undecodableItems.map(\.index), [0])

        let recipe = try makeRecipe()
        let goodRecipe = try jsonObject(recipe)
        let badRecipe = replacing(["values", "parameters", "milk"], with: unknownId, in: goodRecipe)
        let recipes = try JSONDecoder().decode(
            API.RecipePage.self,
            from: JSONSerialization.data(withJSONObject: ["items": [goodRecipe, badRecipe]])
        )
        XCTAssertEqual(recipes.items, [recipe])
        XCTAssertEqual(recipes.undecodableItems.map(\.index), [1])
    }

    func testAPageOfOnlyUnknownItemsDecodesEmpty() throws {
        let bad = replacing(["values", "parameters", "method"], with: unknownId, in: try jsonObject(makeBrew()))
        let page = try JSONDecoder().decode(API.BrewPage.self, from: JSONSerialization.data(withJSONObject: ["items": [bad, bad]]))
        XCTAssertEqual(page.items, [])
        XCTAssertEqual(page.undecodableItems.count, 2)
    }

    func testAnUnknownLocaleFailsToDecodeTheProfile() throws {
        let profile = try API.Profile(locale: XCTUnwrap(VocabularyLanguage.allCases.first), consent: API.Consent(contributeToAggregates: false))
        let bad = replacing(["locale"], with: unknownId, in: try jsonObject(profile))
        XCTAssertThrowsError(try JSONDecoder().decode(API.Profile.self, from: JSONSerialization.data(withJSONObject: bad)))
    }

    // MARK: - Criteria and intensity subscripts

    func testScoresAndIntensitiesBySubscript() throws {
        var scores = API.Scores(aroma: 1, flavour: 1, aftertaste: 1, acidity: 1, body: 1, sweetness: 1, balance: 1, overall: 1)
        for (offset, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            scores[criterion] = 1 + Double(offset) / 2
        }
        for (offset, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            XCTAssertEqual(scores[criterion], 1 + Double(offset) / 2, criterion.rawValue)
        }
        var intensities = API.Intensities()
        let level = try last(Vocabulary.IntensityLevel.self)
        for dimension in Vocabulary.IntensityDimension.allCases {
            XCTAssertNil(intensities[dimension])
            intensities[dimension] = level
            XCTAssertEqual(intensities[dimension], level)
        }
    }

    // MARK: - Calendar dates

    func testCalendarDateIsADayWithoutATimeZone() throws {
        let date = try day("2026-11-25")
        XCTAssertEqual(date.description, "2026-11-25")
        XCTAssertEqual(String(decoding: try encoder().encode([date]), as: UTF8.self), "[\"2026-11-25\"]")
        XCTAssertEqual(try JSONDecoder().decode([API.CalendarDate].self, from: Data("[\"2026-11-25\"]".utf8)), [date])

        // The day a moment falls on depends only on the time zone passed in.
        let instant = try timestamp("2026-11-25T23:30:00.000Z").date
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let east = try XCTUnwrap(TimeZone(secondsFromGMT: 2 * 3600))
        XCTAssertEqual(API.CalendarDate(date: instant, timeZone: utc), date)
        XCTAssertEqual(API.CalendarDate(date: instant, timeZone: east), try day("2026-11-26"))
        XCTAssertLessThan(date, try day("2026-11-26"))
        XCTAssertLessThan(try day("2025-12-31"), date)
    }

    func testCalendarDateRejectsAnythingButAnExistingDay() throws {
        XCTAssertNotNil(API.CalendarDate("2024-02-29"))
        for text in ["2023-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "0000-01-01", "2026-1-05", "26-11-25", "2026-11-25T00:00:00Z", "+026-11-25", "2026/11/25", ""] {
            XCTAssertNil(API.CalendarDate(text), text)
        }
        XCTAssertThrowsError(try JSONDecoder().decode([API.CalendarDate].self, from: Data("[\"2026-02-30\"]".utf8)))
        XCTAssertNil(API.CalendarDate(year: 2026, month: 2, day: 29))
    }

    // MARK: - Timestamps

    func testTimestampsAreRFC3339WithFractionalSeconds() throws {
        let value = try timestamp("2026-11-25T09:30:00.123+01:00")
        XCTAssertEqual(value.description, "2026-11-25T08:30:00.123Z")
        XCTAssertEqual(String(decoding: try encoder().encode([value]), as: UTF8.self), "[\"2026-11-25T08:30:00.123Z\"]")
        XCTAssertEqual(try timestamp("2026-11-25T08:30:00Z").description, "2026-11-25T08:30:00.000Z")
        XCTAssertEqual(API.Timestamp(millisecondsSince1970: -1)?.description, "1969-12-31T23:59:59.999Z")
        XCTAssertNil(API.Timestamp(rfc3339: "2026-11-25"))
        XCTAssertThrowsError(try JSONDecoder().decode([API.Timestamp].self, from: Data("[\"yesterday\"]".utf8)))
    }

    func testTimestampsSurviveARoundTripExactly() throws {
        for milliseconds: Int64 in [0, 1, 999, 1_764_059_400_123, -62_135_596_800_000, 253_402_300_799_999] {
            let value = try XCTUnwrap(API.Timestamp(millisecondsSince1970: milliseconds))
            let decoded = try JSONDecoder().decode([API.Timestamp].self, from: encoder().encode([value]))
            XCTAssertEqual(decoded, [value], "\(milliseconds)")
        }
        XCTAssertNil(API.Timestamp(millisecondsSince1970: API.Timestamp.validRange.upperBound + 1))
        XCTAssertNotNil(API.Timestamp(Date()))
        XCTAssertNil(API.Timestamp(Date.distantFuture.addingTimeInterval(1e12)))
    }

    // MARK: - Endpoints

    func testEveryEndpointNamesGeneratedSchemas() {
        XCTAssertFalse(API.Endpoint.allCases.isEmpty)
        for endpoint in API.Endpoint.allCases {
            XCTAssertTrue(endpoint.path.hasPrefix("/"), endpoint.rawValue)
            XCTAssertTrue((200...299).contains(endpoint.successStatus), endpoint.rawValue)
            if let schema = endpoint.requestSchema {
                XCTAssertNotNil(API.Schemas.properties[schema], "\(endpoint.rawValue): \(schema)")
            }
            if let schema = endpoint.responseSchema {
                XCTAssertNotNil(API.Schemas.properties[schema], "\(endpoint.rawValue): \(schema)")
                XCTAssertEqual(endpoint.responseContentType, "application/json", endpoint.rawValue)
            }
        }
    }
}
