import XCTest
@testable import Cupmark

/// The loader on small in-memory fixtures: errors are thrown, never crashes.
/// Fixture ids are made up on purpose; they test the loader's rules, not the
/// contract, so they are not a copy of any vocabulary list.
final class VocabularyStoreTests: XCTestCase {
    private let version = Vocabulary.version

    private func data(_ json: String) -> Data {
        Data(json.utf8)
    }

    private func languageFile(_ language: VocabularyLanguage, label: String) -> Data {
        data("""
        {"language": "\(language.rawValue)",
         "labels": {"methods": {"alpha": "\(label)"}},
         "questions": {"criteria": {}}}
        """)
    }

    private func makeStore(methods: String = #"[{"id": "alpha"}, {"id": "beta"}]"#, label: String = "Alpha") throws -> VocabularyStore {
        var languages: [VocabularyLanguage: Data] = [:]
        for language in VocabularyLanguage.allCases {
            languages[language] = languageFile(language, label: label)
        }
        return try VocabularyStore(
            files: ["brew": data(#"{"version": \#(version), "status": "published", "methods": \#(methods)}"#)],
            languages: languages
        )
    }

    func testLoadingFromABundleWithoutTheVocabularyThrowsMissingResource() {
        let testBundle = Bundle(for: VocabularyStoreTests.self)
        XCTAssertThrowsError(try VocabularyStore.load(from: testBundle)) { error in
            guard case VocabularyError.missingResource = error else {
                return XCTFail("expected missingResource, got \(error)")
            }
        }
    }

    func testLoadStateReportsFailureInsteadOfCrashing() {
        let state = VocabularyLoadState.load(from: Bundle(for: VocabularyStoreTests.self))
        guard case .failed = state else {
            return XCTFail("expected a failed load from the test bundle")
        }
    }

    func testIdsKeepFileOrder() throws {
        let store = try makeStore()
        XCTAssertEqual(store.ids(in: .methods), ["alpha", "beta"])
        XCTAssertEqual(store.namespaceFiles["methods"], "brew")
    }

    func testLabelResolves() throws {
        let store = try makeStore()
        for language in VocabularyLanguage.allCases {
            XCTAssertEqual(try store.label(namespace: .methods, id: "alpha", language: language), "Alpha")
        }
    }

    func testMissingLabelThrows() throws {
        let store = try makeStore()
        XCTAssertThrowsError(try store.label(namespace: .methods, id: "beta", language: .fallback)) { error in
            XCTAssertEqual(error as? VocabularyError, .missingLabel(namespace: "methods", id: "beta", language: VocabularyLanguage.fallback.rawValue))
        }
    }

    func testEmptyLabelThrows() throws {
        let store = try makeStore(label: "  ")
        XCTAssertThrowsError(try store.label(namespace: .methods, id: "alpha", language: .fallback)) { error in
            XCTAssertEqual(error as? VocabularyError, .emptyLabel(namespace: "methods", id: "alpha", language: VocabularyLanguage.fallback.rawValue))
        }
    }

    func testUnknownIdThrows() throws {
        let store = try makeStore()
        XCTAssertThrowsError(try store.label(namespace: .methods, id: "gamma", language: .fallback)) { error in
            XCTAssertEqual(error as? VocabularyError, .unknownId(namespace: "methods", id: "gamma"))
        }
    }

    func testNamespaceNotInTheFilesThrows() throws {
        let store = try makeStore()
        XCTAssertThrowsError(try store.label(namespace: .criteria, id: "alpha", language: .fallback)) { error in
            XCTAssertEqual(error as? VocabularyError, .unknownNamespace("criteria"))
        }
    }

    func testInvalidJSONThrows() {
        XCTAssertThrowsError(try VocabularyStore(files: ["brew": data("{")], languages: [:])) { error in
            XCTAssertEqual(error as? VocabularyError, .invalidJSON("brew.json"))
        }
    }

    func testWrongVersionThrows() {
        let file = data(#"{"version": \#(version + 1), "methods": [{"id": "alpha"}]}"#)
        XCTAssertThrowsError(try VocabularyStore(files: ["brew": file], languages: [:])) { error in
            XCTAssertEqual(error as? VocabularyError, .versionMismatch(file: "brew.json"))
        }
    }

    func testArrayWithoutIdsThrows() {
        XCTAssertThrowsError(try makeStore(methods: #"["alpha"]"#)) { error in
            guard case VocabularyError.invalidShape = error else {
                return XCTFail("expected invalidShape, got \(error)")
            }
        }
    }

    func testEmptyListThrows() {
        XCTAssertThrowsError(try makeStore(methods: "[]")) { error in
            guard case VocabularyError.invalidShape = error else {
                return XCTFail("expected invalidShape, got \(error)")
            }
        }
    }

    func testDuplicateIdThrows() {
        XCTAssertThrowsError(try makeStore(methods: #"[{"id": "alpha"}, {"id": "alpha"}]"#)) { error in
            XCTAssertEqual(error as? VocabularyError, .invalidShape("methods: duplicate id alpha"))
        }
    }

    func testNamespaceInTwoFilesThrows() {
        let one = data(#"{"version": \#(version), "methods": [{"id": "alpha"}]}"#)
        let two = data(#"{"version": \#(version), "methods": [{"id": "beta"}]}"#)
        XCTAssertThrowsError(try VocabularyStore(files: ["brew": one, "bean": two], languages: [:])) { error in
            guard case VocabularyError.invalidShape = error else {
                return XCTFail("expected invalidShape, got \(error)")
            }
        }
    }

    func testNestedListsMergeIntoOneNamespaceInFileOrder() throws {
        let file = data(#"""
        {"version": \#(version), "groups": [
          {"id": "g1", "items": [{"id": "a"}, {"id": "b"}]},
          {"id": "g2", "items": [{"id": "c"}]}
        ]}
        """#)
        let store = try VocabularyStore(files: ["things": file], languages: [:])
        XCTAssertEqual(store.ids["groups"], ["g1", "g2"])
        XCTAssertEqual(store.ids["items"], ["a", "b", "c"])
    }

    func testRangesAreFoundByPath() throws {
        let file = data(#"""
        {"version": \#(version), "ranges": {"x": {"minimum": 1, "maximum": 2, "multipleOf": 0.5}},
         "scale": {"minimum": 0, "maximum": 10, "multipleOf": 1}}
        """#)
        let store = try VocabularyStore(files: ["things": file], languages: [:])
        XCTAssertEqual(store.ranges["things.ranges.x"], VocabularyRange(minimum: 1, maximum: 2, multipleOf: 0.5))
        XCTAssertEqual(store.ranges["things.scale"], VocabularyRange(minimum: 0, maximum: 10, multipleOf: 1))
    }

    /// Vocabulary v3 shapes (M2-T3): a range on a list entry is recorded by
    /// namespace and id, never by index and never among the file's ranges;
    /// rule objects of booleans are neither ranges nor lists.
    func testEntryRangesAreKeyedByIdAndRulesAreNotRanges() throws {
        let file = data(#"""
        {"version": \#(version),
         "tools": [{"id": "t1", "scale": {"minimum": 0, "maximum": 50, "multipleOf": 0.5}}, {"id": "t2"}],
         "ranges": {"x": {"minimum": 1, "maximum": 2, "multipleOf": 1}},
         "rules": {"field_a": {"allowed": {"t1": true}}}}
        """#)
        let store = try VocabularyStore(files: ["things": file], languages: [:])
        XCTAssertEqual(store.ids["tools"], ["t1", "t2"])
        XCTAssertEqual(store.entryRanges, ["tools.t1.scale": VocabularyRange(minimum: 0, maximum: 50, multipleOf: 0.5)])
        XCTAssertEqual(store.ranges, ["things.ranges.x": VocabularyRange(minimum: 1, maximum: 2, multipleOf: 1)])
        XCTAssertNil(store.ids["rules"])
        XCTAssertNil(store.ids["allowed"])
        XCTAssertEqual(store.value(at: "things.rules.field_a.allowed.t1"), .bool(true))
    }

    func testLanguageFileForTheWrongLanguageThrows() throws {
        guard let other = VocabularyLanguage.allCases.first(where: { $0 != .fallback }) else {
            throw XCTSkip("only one language")
        }
        let file = data(#"{"version": \#(version), "methods": [{"id": "alpha"}]}"#)
        XCTAssertThrowsError(
            try VocabularyStore(files: ["brew": file], languages: [.fallback: languageFile(other, label: "Alpha")])
        ) { error in
            XCTAssertEqual(error as? VocabularyError, .languageMismatch(expected: VocabularyLanguage.fallback.rawValue, found: other.rawValue))
        }
    }

    func testRangeContainsOnlyValuesOnItsSteps() {
        let range = VocabularyRange(minimum: 5, maximum: 100, multipleOf: 0.1)
        XCTAssertTrue(range.contains(5))
        XCTAssertTrue(range.contains(18.3))
        XCTAssertTrue(range.contains(100))
        XCTAssertFalse(range.contains(4.9))
        XCTAssertFalse(range.contains(18.35))
        XCTAssertFalse(range.contains(100.1))
        XCTAssertEqual(range.stepCount, 950)
    }

    // MARK: - The language rule (M2-T32)

    func testTheLanguageRuleIsTheFirstPreferredLanguageThatIsGermanOrEnglish() {
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["de"]), .de)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["de-CH", "en-US"]), .de)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["de-AT"]), .de)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["de-Latn-DE"]), .de)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["en-US"]), .en)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["en-GB", "de-DE"]), .en, "the first supported language counts")
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["fr-FR"]), .en, "French falls back to English")
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["fr"]), .en)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["fr-FR", "de-DE"]), .de, "an unsupported language is skipped, as the UI does")
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["fr", "en", "de"]), .en)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: ["fr", "it"]), .en)
        XCTAssertEqual(VocabularyLanguage.resolving(preferredLanguages: []), .en)
    }

    func testTheProfileLocaleUsesTheSameRuleAsTheVocabularyLabels() {
        for languages in [["de"], ["de-AT"], ["en-GB"], ["fr-FR"], ["fr-FR", "de-DE"], ["fr", "en", "de"], []] {
            XCTAssertEqual(
                OnboardingRules.profileLocale(preferredLanguages: languages),
                VocabularyLanguage.resolving(preferredLanguages: languages),
                "\(languages)"
            )
        }
    }

    /// A store whose German file lacks `beta` and has an empty `alpha`; English has both.
    private func storeMissingGerman() throws -> VocabularyStore {
        func file(_ language: VocabularyLanguage, labels: String) -> Data {
            data(#"{"language": "\#(language.rawValue)", "labels": {"methods": \#(labels)}, "questions": {"criteria": {}}}"#)
        }
        return try VocabularyStore(
            files: ["brew": data(#"{"version": \#(version), "status": "published", "methods": [{"id": "alpha"}, {"id": "beta"}]}"#)],
            languages: [
                .en: file(.en, labels: #"{"alpha": "Alpha", "beta": "Beta"}"#),
                .de: file(.de, labels: #"{"alpha": " "}"#),
            ]
        )
    }

    func testALabelMissingInGermanFallsBackToEnglish() throws {
        let store = try storeMissingGerman()
        XCTAssertEqual(try store.label(namespace: .methods, id: "beta", language: .de), "Beta", "missing in de")
        XCTAssertEqual(try store.label(namespace: .methods, id: "alpha", language: .de), "Alpha", "empty in de")
        XCTAssertEqual(try store.label(namespace: .methods, id: "beta", language: .en), "Beta")
    }

    func testALabelMissingInEnglishStillThrowsAndAnUnknownIdDoesNotFallBack() throws {
        let store = try makeStore()
        XCTAssertThrowsError(try store.label(namespace: .methods, id: "beta", language: .de)) { error in
            XCTAssertEqual(error as? VocabularyError, .missingLabel(namespace: "methods", id: "beta", language: "en"))
        }
        XCTAssertThrowsError(try store.label(namespace: .methods, id: "gamma", language: .de)) { error in
            XCTAssertEqual(error as? VocabularyError, .unknownId(namespace: "methods", id: "gamma"))
        }
    }
}
