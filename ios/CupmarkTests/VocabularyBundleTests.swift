import XCTest
@testable import Cupmark

/// Loads the vocabulary exactly as the app bundles it and checks it against
/// the generated Swift types and both label languages (M0-T6 acceptance).
final class VocabularyBundleTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func loadStore() throws -> VocabularyStore {
        try VocabularyStore.load(from: appBundle)
    }

    func testBundleHoldsExactlyTheGeneratedVocabularyFiles() {
        XCTAssertEqual(VocabularyStore.bundledFileNames(in: appBundle), Vocabulary.files.sorted())
    }

    func testEveryVocabularyFileLoads() throws {
        let store = try loadStore()
        XCTAssertEqual(Set(store.files.keys), Set(Vocabulary.files))
        for name in Vocabulary.files {
            XCTAssertEqual(store.value(at: "\(name).version"), .number(Double(Vocabulary.version)), name)
        }
    }

    func testEveryLanguageFileLoads() throws {
        for language in VocabularyLanguage.allCases {
            let url = appBundle.url(
                forResource: language.rawValue,
                withExtension: "json",
                subdirectory: VocabularyStore.i18nDirectory
            )
            XCTAssertNotNil(url, "\(language.rawValue).json is not bundled")
        }
    }

    func testGeneratedNamespacesMatchBundledLists() throws {
        let store = try loadStore()
        XCTAssertEqual(Set(store.ids.keys), Set(Vocabulary.Namespace.allCases.map(\.rawValue)))
        for namespace in Vocabulary.Namespace.allCases {
            XCTAssertEqual(store.namespaceFiles[namespace.rawValue], namespace.file, namespace.rawValue)
        }
    }

    func testGeneratedIdsMatchBundledIdsExactly() throws {
        let store = try loadStore()
        for namespace in Vocabulary.Namespace.allCases {
            let bundled = store.ids(in: namespace)
            XCTAssertFalse(bundled.isEmpty, namespace.rawValue)
            XCTAssertEqual(namespace.generatedIds, bundled, "ids or their order differ in \(namespace.rawValue)")
        }
    }

    func testEveryIdHasANonEmptyLabelInEveryLanguage() throws {
        let store = try loadStore()
        var failures: [String] = []
        var resolved = 0
        for namespace in Vocabulary.Namespace.allCases {
            for id in store.ids(in: namespace) {
                for language in VocabularyLanguage.allCases {
                    do {
                        let label = try store.label(namespace: namespace, id: id, language: language)
                        XCTAssertFalse(label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        resolved += 1
                    } catch {
                        failures.append("\(language.rawValue) \(namespace.rawValue).\(id): \(error)")
                    }
                }
            }
        }
        XCTAssertEqual(failures, [], "labels that did not resolve")
        XCTAssertGreaterThan(resolved, 0)
    }

    func testEveryQuestionListHasANonEmptyQuestionInEveryLanguage() throws {
        let store = try loadStore()
        let namespaces = Vocabulary.Namespace.allCases.filter(\.hasQuestions)
        XCTAssertFalse(namespaces.isEmpty)
        var failures: [String] = []
        for namespace in namespaces {
            for id in store.ids(in: namespace) {
                for language in VocabularyLanguage.allCases {
                    do {
                        _ = try store.question(namespace: namespace, id: id, language: language)
                    } catch {
                        failures.append("\(language.rawValue) \(namespace.rawValue).\(id): \(error)")
                    }
                }
            }
        }
        XCTAssertEqual(failures, [], "questions that did not resolve")
    }

    func testGeneratedRangesMatchBundledRanges() throws {
        let store = try loadStore()
        XCTAssertEqual(store.ranges, Vocabulary.Ranges.all)
    }

    func testGeneratedConstantsMatchBundledValues() throws {
        let store = try loadStore()
        XCTAssertFalse(Vocabulary.Constants.all.isEmpty)
        for (path, expected) in Vocabulary.Constants.all {
            XCTAssertEqual(store.value(at: path), expected, path)
        }
    }

    func testGeneratedAttributesMatchBundledValues() throws {
        let store = try loadStore()
        let bagSizes = try listObjects(store, file: Vocabulary.Namespace.bagSizes.file, key: "bag_sizes")
        XCTAssertEqual(bagSizes.map { $0["id"]?.stringValue ?? "" }, Vocabulary.BagSize.allCases.map(\.rawValue))
        for (object, size) in zip(bagSizes, Vocabulary.BagSize.allCases) {
            XCTAssertEqual(object["grams"]?.numberValue, Double(size.grams), size.rawValue)
        }

        let bands = try listObjects(store, file: Vocabulary.Namespace.priceBands.file, key: "price_bands")
        XCTAssertEqual(bands.map { $0["id"]?.stringValue ?? "" }, Vocabulary.PriceBand.allCases.map(\.rawValue))
        for (object, band) in zip(bands, Vocabulary.PriceBand.allCases) {
            XCTAssertEqual(object["minimum"]?.numberValue, Double(band.minimum), band.rawValue)
            XCTAssertEqual(object["maximum_exclusive"]?.numberValue, band.maximumExclusive.map { Double($0) }, band.rawValue)
        }
    }

    func testGeneratedFlavourHierarchyMatchesBundledFile() throws {
        let store = try loadStore()
        let categories = try listObjects(
            store,
            file: Vocabulary.Namespace.flavourCategories.file,
            key: "flavour_categories"
        )
        XCTAssertEqual(categories.count, Vocabulary.FlavourCategory.allCases.count)
        for (object, category) in zip(categories, Vocabulary.FlavourCategory.allCases) {
            guard case .array(let notes)? = object["flavour_notes"] else {
                XCTFail("\(category.rawValue) has no flavour_notes")
                continue
            }
            XCTAssertEqual(notes.map { $0["id"]?.stringValue ?? "" }, category.flavourNotes.map(\.rawValue))
            for note in category.flavourNotes {
                XCTAssertEqual(note.flavourCategory, category, note.rawValue)
            }
        }
    }

    /// The milk id `none` is the case `noMilk`, so `.none` on an optional
    /// milk type always means nil; the raw value is still the contract id.
    func testMilkIdNoneIsTheCaseNoMilkWithRawValueNone() throws {
        XCTAssertEqual(Vocabulary.MilkType.noMilk.rawValue, "none")
        XCTAssertEqual(Vocabulary.MilkType(rawValue: "none"), .noMilk)
        let unset: Vocabulary.MilkType? = .none
        XCTAssertNil(unset)
        let decoded = try JSONDecoder().decode([Vocabulary.MilkType].self, from: Data(#"["none"]"#.utf8))
        XCTAssertEqual(decoded, [.noMilk])
        let label = try loadStore().label(for: Vocabulary.MilkType.noMilk, language: .en)
        XCTAssertFalse(label.isEmpty)
    }

    private func listObjects(_ store: VocabularyStore, file: String, key: String) throws -> [JSONValue] {
        guard case .array(let items)? = store.value(at: "\(file).\(key)") else {
            throw MissingList(path: "\(file).\(key)")
        }
        return items
    }
}

private struct MissingList: Error {
    let path: String
}
