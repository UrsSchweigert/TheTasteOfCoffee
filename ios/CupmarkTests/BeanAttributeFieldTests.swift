import XCTest
@testable import Cupmark

/// `BeanAttributeField` names the properties of `API.BeanAttributes` by hand (the bean screen's
/// order and titles). This keeps it equal to the generated schema (M2-T18, from the M2-T14
/// review): a property added to the contract fails here until the field is added.
final class BeanAttributeFieldTests: XCTestCase {
    /// The property of `API.BeanAttributes` that `field` reads: the one key whose value, set
    /// alone to the first id of the field's list, makes `valueID(in:)` return that id.
    private func property(of field: BeanAttributeField) throws -> String {
        let id = try XCTUnwrap(field.namespace.generatedIds.first, "\(field.namespace.rawValue) is empty")
        var matches: [String] = []
        for key in API.BeanAttributes.propertyNames.sorted() {
            let json = try JSONSerialization.data(withJSONObject: [key: id])
            // A key whose list does not have `id` does not decode; that is not this field's key.
            guard let attributes = try? JSONDecoder().decode(API.BeanAttributes.self, from: json) else {
                continue
            }
            if field.valueID(in: attributes) == id {
                matches.append(key)
            }
        }
        XCTAssertEqual(matches.count, 1, "\(field) reads \(matches)")
        return try XCTUnwrap(matches.first, "\(field) reads no property")
    }

    func testTheFieldsAreExactlyThePropertiesOfBeanAttributes() throws {
        let properties = try BeanAttributeField.allCases.map { field in try property(of: field) }
        XCTAssertEqual(Set(properties).count, BeanAttributeField.allCases.count, "two fields read one property")
        XCTAssertEqual(Set(properties), API.BeanAttributes.propertyNames)
    }

    func testEveryFieldNamesTheListOfItsProperty() throws {
        // The property's value decodes from the field's own list, so labels come from the
        // right namespace.
        for field in BeanAttributeField.allCases {
            let key = try property(of: field)
            for id in field.namespace.generatedIds {
                let json = try JSONSerialization.data(withJSONObject: [key: id])
                let attributes = try JSONDecoder().decode(API.BeanAttributes.self, from: json)
                XCTAssertEqual(field.valueID(in: attributes), id, "\(field) \(id)")
            }
        }
    }

    func testAnEmptyBeanAttributesHasNoValueForAnyField() {
        for field in BeanAttributeField.allCases {
            XCTAssertNil(field.valueID(in: API.BeanAttributes()), "\(field)")
        }
    }
}
