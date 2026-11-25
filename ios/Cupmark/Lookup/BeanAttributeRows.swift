import Foundation

/// The attribute fields of `API.BeanAttributes` (contracts/openapi.yaml), in the order the bean
/// screen shows them. These are the schema's properties, not vocabulary entries: the values
/// stay `Vocabulary` enums and their labels come from contracts/i18n.
enum BeanAttributeField: CaseIterable, Hashable, Sendable {
    case origin
    case species
    case variety
    case process
    case roastLevel

    /// The vocabulary list the field's value is from.
    var namespace: Vocabulary.Namespace {
        switch self {
        case .origin: Vocabulary.Origin.namespace
        case .species: Vocabulary.Species.namespace
        case .variety: Vocabulary.Variety.namespace
        case .process: Vocabulary.Process.namespace
        case .roastLevel: Vocabulary.RoastLevel.namespace
        }
    }

    /// The field's vocabulary id in `attributes`, or nil when it is not set.
    func valueID(in attributes: API.BeanAttributes) -> String? {
        switch self {
        case .origin: attributes.origin?.rawValue
        case .species: attributes.species?.rawValue
        case .variety: attributes.variety?.rawValue
        case .process: attributes.process?.rawValue
        case .roastLevel: attributes.roastLevel?.rawValue
        }
    }
}

/// Who set an attribute value of a bean.
enum BeanAttributeSource: Hashable, Sendable {
    /// The operator, when verifying the bean.
    case operatorSet
    /// A user, through the pick lists.
    case picked
}

/// One attribute as the bean screen shows it: the value that counts and where it came from.
struct BeanAttributeRow: Hashable, Identifiable, Sendable {
    let field: BeanAttributeField
    /// A vocabulary id in `field.namespace`.
    let valueID: String
    let source: BeanAttributeSource

    var id: BeanAttributeField { field }
}

extension API.Bean {
    /// Every set attribute, one row per field. Where both groups have a value, the operator's
    /// wins (contracts/openapi.yaml, `Bean`).
    var attributeRows: [BeanAttributeRow] {
        BeanAttributeRow.rows(operatorAttributes: operatorAttributes, pickedAttributes: pickedAttributes)
    }
}

extension BeanAttributeRow {
    /// Every set attribute of the two groups, one row per field, the operator's value first.
    /// Shared by the catalogue bean (`API.Bean.attributeRows`) and the stored bean (M2-T18).
    static func rows(operatorAttributes: API.BeanAttributes, pickedAttributes: API.BeanAttributes) -> [BeanAttributeRow] {
        BeanAttributeField.allCases.compactMap { field in
            if let id = field.valueID(in: operatorAttributes) {
                return BeanAttributeRow(field: field, valueID: id, source: .operatorSet)
            }
            if let id = field.valueID(in: pickedAttributes) {
                return BeanAttributeRow(field: field, valueID: id, source: .picked)
            }
            return nil
        }
    }
}
