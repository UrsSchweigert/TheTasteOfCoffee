import XCTest
@testable import Cupmark

/// The brew photo gallery's model (M2-T43): the order, the method and bag filters alone and
/// together, clearing, the empty states, the photos of another account, brews that are removed,
/// and the label parts in English and German. Fixed dates, a temporary folder per test, no UI.
///
/// The dates of the photos are `BrewPhotoFixtures.at(minute:)`: 18 November 2026 in UTC.
@MainActor
final class BrewPhotoGalleryModelTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()
    private let otherBeanID = "01JD00000000000000000BEAN2"
    private let otherShelfEntryID = "01JD00000000000000000SHEF2"

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }

    private func vocabulary() throws -> VocabularyStore {
        try VocabularyStore.load(from: appBundle)
    }

    private func languageBundle(_ language: VocabularyLanguage) throws -> Bundle {
        let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"))
        return try XCTUnwrap(Bundle(path: path))
    }

    private func makeStore(account: String = "gallery-model-tests") throws -> AccountStore {
        let files = BrewPhotoFolders(root: root.appending(path: "BrewPhotos", directoryHint: .isDirectory)).files(for: AccountID(subject: account))
        return try AccountStore.inMemory(brewPhotoFiles: files)
    }

    private func makeModel(_ store: AccountStore, language: VocabularyLanguage = .en) throws -> BrewPhotoGalleryModel {
        let locale = Locale(identifier: language == .en ? "en_US" : "de_DE")
        let model = BrewPhotoGalleryModel(
            store: store,
            vocabulary: try vocabulary(),
            language: language,
            locale: locale,
            calendar: try StoreFixtures.calendar("UTC"),
            bundle: try languageBundle(language)
        )
        model.reload()
        return model
    }

    private var firstMethod: Vocabulary.Method { Vocabulary.Method.allCases[0] }
    private var lastMethod: Vocabulary.Method { Vocabulary.Method.allCases[Vocabulary.Method.allCases.count - 1] }

    /// Two bags and three brews, four photos:
    ///
    /// - bag A (the Open Food Facts bean "Bohne", bought 20 Nov 2026): brew A1 (first method)
    ///   with photos at minutes 1 and 4, brew A2 (last method) with a photo at minute 3;
    /// - bag B (a bean described by its picks, bought 2 Oct 2026): brew B1 (first method) with a
    ///   photo at minute 2.
    private struct Scenario {
        let store: AccountStore
        let bagA: StoredShelfEntry
        let bagB: StoredShelfEntry
        let brewA1: StoredBrew
        let brewA2: StoredBrew
        let brewB1: StoredBrew
    }

    private func makeScenario(_ store: AccountStore) throws -> Scenario {
        XCTAssertNotEqual(firstMethod, lastMethod)
        let bagA = try StoreFixtures.syncedShelfEntry(in: store)
        let beanB = StoredBean(API.Bean(
            beanId: otherBeanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self)),
            operatorAttributes: API.BeanAttributes()
        ))
        try store.addBean(beanB, syncState: .synced)
        let bagB = StoredShelfEntry(
            API.ShelfEntryInput(
                vocabularyVersion: Vocabulary.version,
                beanId: otherBeanID,
                purchaseDate: try StoreFixtures.day("2026-10-02")
            ),
            serverID: otherShelfEntryID
        )
        try store.addShelfEntry(bagB, bean: beanB, syncState: .synced)

        let brewA1 = try addBrew(in: store, to: bagA, method: firstMethod)
        let brewA2 = try addBrew(in: store, to: bagA, method: lastMethod)
        let brewB1 = try addBrew(in: store, to: bagB, method: firstMethod)
        try addPhoto(in: store, to: brewA1, minute: 1)
        try addPhoto(in: store, to: brewB1, minute: 2)
        try addPhoto(in: store, to: brewA2, minute: 3)
        try addPhoto(in: store, to: brewA1, minute: 4)
        return Scenario(store: store, bagA: bagA, bagB: bagB, brewA1: brewA1, brewA2: brewA2, brewB1: brewB1)
    }

    private func addBrew(in store: AccountStore, to entry: StoredShelfEntry, method: Vocabulary.Method) throws -> StoredBrew {
        let brew = try StoredBrew(try StoreFixtures.brewInput(), serverID: nil)
        brew.methodID = method.rawValue
        try store.addBrew(brew, shelfEntry: entry)
        return brew
    }

    private func addPhoto(in store: AccountStore, to brew: StoredBrew, minute: Int) throws {
        try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: minute))
    }

    /// The minutes of the photos shown, in order.
    private func minutes(_ model: BrewPhotoGalleryModel) -> [Int] {
        model.items.map { item in Int(item.createdAt.timeIntervalSince(BrewPhotoFixtures.start) / 60) }
    }

    // MARK: - Order and count

    func testAllPhotosAreShownNewestFirstWithTheirCount() throws {
        let model = try makeModel(try makeScenario(try makeStore()).store)

        XCTAssertEqual(minutes(model), [4, 3, 2, 1])
        XCTAssertEqual(model.count, 4)
        XCTAssertFalse(model.hasFilter)
        XCTAssertFalse(model.hasNoPhotos)
        XCTAssertFalse(model.loadFailed)
        XCTAssertTrue(model.items.allSatisfy { $0.fileURL != nil })
    }

    func testAnAccountWithoutPhotosHasTheEmptyState() throws {
        let model = try makeModel(try makeStore())

        XCTAssertTrue(model.items.isEmpty)
        XCTAssertTrue(model.hasNoPhotos)
        XCTAssertEqual(model.count, 0)
        XCTAssertEqual(model.summary, "Photos: 0")
    }

    func testANewPhotoAppearsAfterAReload() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        try addPhoto(in: scenario.store, to: scenario.brewB1, minute: 9)
        XCTAssertEqual(model.count, 4, "the model reads the store when it reloads")

        model.reload()

        XCTAssertEqual(minutes(model), [9, 4, 3, 2, 1])
    }

    // MARK: - Filters

    func testTheMethodFilterAlone() throws {
        let model = try makeModel(try makeScenario(try makeStore()).store)

        model.methodFilter = firstMethod
        XCTAssertEqual(minutes(model), [4, 2, 1])
        XCTAssertTrue(model.hasFilter)

        model.methodFilter = lastMethod
        XCTAssertEqual(minutes(model), [3])
    }

    func testTheBagFilterAlone() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)

        model.bagFilter = scenario.bagA.localID
        XCTAssertEqual(minutes(model), [4, 3, 1])

        model.bagFilter = scenario.bagB.localID
        XCTAssertEqual(minutes(model), [2])
    }

    func testBothFiltersTogether() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)

        model.methodFilter = firstMethod
        model.bagFilter = scenario.bagA.localID
        XCTAssertEqual(minutes(model), [4, 1])

        // A bag and a method that no photo has together: empty, but the account has photos.
        model.methodFilter = lastMethod
        model.bagFilter = scenario.bagB.localID
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertFalse(model.hasNoPhotos)
        XCTAssertEqual(model.summary, "Photos: 0, filter: \(model.label(of: lastMethod)) and \(try XCTUnwrap(model.bagFilterTitle))")
    }

    func testClearingTheFiltersShowsEveryPhotoAgain() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        model.methodFilter = lastMethod
        model.bagFilter = scenario.bagA.localID
        XCTAssertEqual(minutes(model), [3])

        model.clearFilters()

        XCTAssertNil(model.methodFilter)
        XCTAssertNil(model.bagFilter)
        XCTAssertFalse(model.hasFilter)
        XCTAssertEqual(minutes(model), [4, 3, 2, 1])
        XCTAssertNil(model.filterDescription)
    }

    func testTheMethodPickListIsTheVocabularysInItsOrder() throws {
        let model = try makeModel(try makeStore())
        XCTAssertEqual(model.methodOptions, Vocabulary.Method.allCases)
    }

    func testTheBagPickListShowsTheBeanAndThePurchaseDateLatestFirst() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        let process = try vocabulary().label(for: try StoreFixtures.first(Vocabulary.Process.self), language: .en)

        XCTAssertEqual(model.bags.map(\.id), [scenario.bagA.localID, scenario.bagB.localID])
        XCTAssertEqual(model.bags.map(\.title), ["Bohne, bought Nov 20, 2026", "\(process), bought Oct 2, 2026"])
    }

    func testAFilterOnABagThatIsGoneIsCleared() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        model.bagFilter = scenario.bagB.localID
        model.methodFilter = firstMethod
        XCTAssertEqual(minutes(model), [2])

        try scenario.store.markDeleted(scenario.brewB1)
        try scenario.store.markDeleted(scenario.bagB)
        model.reload()

        XCTAssertNil(model.bagFilter)
        XCTAssertEqual(model.methodFilter, firstMethod, "the other filter stays")
        XCTAssertEqual(minutes(model), [4, 1])
        XCTAssertEqual(model.bags.map(\.id), [scenario.bagA.localID])
    }

    // MARK: - What is never shown

    func testAnotherAccountsPhotosAreNeverShown() throws {
        let mine = try makeScenario(try makeStore(account: "gallery-account-one"))
        let otherStore = try makeStore(account: "gallery-account-two")
        let other = try makeScenario(otherStore)
        try addPhoto(in: otherStore, to: other.brewA2, minute: 50)

        let model = try makeModel(mine.store)
        let otherModel = try makeModel(otherStore)

        XCTAssertEqual(minutes(model), [4, 3, 2, 1])
        XCTAssertEqual(minutes(otherModel), [50, 4, 3, 2, 1])
        XCTAssertTrue(Set(model.allItems.map(\.id)).isDisjoint(with: otherModel.allItems.map(\.id)))
        XCTAssertTrue(Set(model.allItems.compactMap(\.fileURL)).isDisjoint(with: otherModel.allItems.compactMap(\.fileURL)))
    }

    func testThePhotosOfARemovedBrewAreNotShown() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)

        // The user's delete takes the photos with it.
        try scenario.store.markDeleted(scenario.brewA2)
        model.reload()
        XCTAssertEqual(minutes(model), [4, 2, 1])

        // A brew kept as `pendingDelete` while its record is still there is hidden too.
        scenario.brewB1.syncState = .pendingDelete
        try scenario.store.save()
        model.reload()
        XCTAssertEqual(minutes(model), [4, 1])
        XCTAssertEqual(try scenario.store.allBrewPhotos().count, 3, "the record is still there; the gallery only hides it")
    }

    func testAMissingFileIsKeptWithoutAnImage() throws {
        let scenario = try makeScenario(try makeStore())
        let photo = try XCTUnwrap(try scenario.store.brewPhotos(of: scenario.brewB1).first)
        try FileManager.default.removeItem(at: try scenario.store.brewPhotoFileURL(of: photo))

        let model = try makeModel(scenario.store)

        XCTAssertEqual(model.count, 4)
        XCTAssertNil(model.item(id: photo.localID)?.fileURL)
    }

    // MARK: - Labels

    func testThePhotoLabelIsMethodBagAndDateInEnglish() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        let item = try XCTUnwrap(model.items.first { $0.brewLocalID == scenario.brewA2.localID })

        XCTAssertEqual(item.accessibilityLabel, "\(model.label(of: lastMethod)), Bohne bag, Nov 18, 2026")
    }

    func testThePhotoLabelIsMethodBagAndDateInGerman() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store, language: .de)
        let item = try XCTUnwrap(model.items.first { $0.brewLocalID == scenario.brewA2.localID })
        let label = item.accessibilityLabel

        XCTAssertTrue(label.hasPrefix("\(model.label(of: lastMethod)), Packung Bohne, "), label)
        XCTAssertTrue(label.contains("2026") && label.contains("18"), label)
        XCTAssertFalse(label.contains("%") || label.contains("gallery."), label)
    }

    func testABagWithoutOpenFoodFactsTextIsNamedByItsAttributes() throws {
        let scenario = try makeScenario(try makeStore())
        let model = try makeModel(scenario.store)
        let item = try XCTUnwrap(model.items.first { $0.brewLocalID == scenario.brewB1.localID })
        let process = try vocabulary().label(for: try StoreFixtures.first(Vocabulary.Process.self), language: .en)

        XCTAssertEqual(item.accessibilityLabel, "\(model.label(of: firstMethod)), \(process) bag, Nov 18, 2026")
    }

    func testABrewWithoutABagOrWithAnUnknownMethodHasTheFallbackParts() throws {
        let scenario = try makeScenario(try makeStore())
        scenario.brewA2.shelfEntry = nil
        scenario.brewA2.methodID = "method-from-a-newer-vocabulary"
        try scenario.store.save()

        let model = try makeModel(scenario.store)
        let item = try XCTUnwrap(model.items.first { $0.brewLocalID == scenario.brewA2.localID })

        XCTAssertEqual(item.accessibilityLabel, "Brew, no bag, Nov 18, 2026")
        XCTAssertNil(item.method)
        XCTAssertNil(item.shelfEntryID)
        model.methodFilter = firstMethod
        XCTAssertFalse(model.items.contains { $0.id == item.id }, "an unknown method matches no method filter")
    }

    func testTheCountAndTheActiveFilterAreOneValueInEachLanguage() throws {
        let scenario = try makeScenario(try makeStore())
        let english = try makeModel(scenario.store)
        let german = try makeModel(scenario.store, language: .de)

        XCTAssertEqual(english.summary, "Photos: 4")
        XCTAssertEqual(german.summary, "Fotos: 4")

        english.methodFilter = firstMethod
        german.methodFilter = firstMethod
        XCTAssertEqual(english.summary, "Photos: 3, filter: \(english.label(of: firstMethod))")
        XCTAssertEqual(german.summary, "Fotos: 3, Filter: \(german.label(of: firstMethod))")

        english.bagFilter = scenario.bagA.localID
        let both = english.summary
        XCTAssertTrue(both.hasPrefix("Photos: 2, filter: "), both)
        XCTAssertTrue(both.contains(english.label(of: firstMethod)) && both.contains("Bohne, bought Nov 20, 2026"), both)
    }

    func testVoiceOverReadsOnlyTheNumberAndTheFilterAfterTheLabel() throws {
        let scenario = try makeScenario(try makeStore())
        let english = try makeModel(scenario.store)
        let german = try makeModel(scenario.store, language: .de)

        // The element's label is "Brew photos"; its value does not say "photos" again.
        XCTAssertEqual(english.spokenValue, "4")
        XCTAssertEqual(german.spokenValue, "4")

        english.methodFilter = firstMethod
        german.methodFilter = firstMethod
        XCTAssertEqual(english.spokenValue, "3, filter: \(english.label(of: firstMethod))")
        XCTAssertEqual(german.spokenValue, "3, Filter: \(german.label(of: firstMethod))")
        XCTAssertEqual(english.summary, "Photos: 3, filter: \(english.label(of: firstMethod))", "the text shown is unchanged")
    }

    func testAReloadKeepsEveryItemAndLabelWhenManyPhotosShareBrewsAndBags() throws {
        let scenario = try makeScenario(try makeStore())
        // At most 6 photos a brew (`BrewPhotoLimits.maxPerBrew`): the scenario's brews hold 2, 1
        // and 1; one more brew of bag A takes a full 6. 4 + 5 + 5 + 6 = 20 more photos.
        let extra = try addBrew(in: scenario.store, to: scenario.bagA, method: firstMethod)
        var minute = 10
        for (brew, number) in [(scenario.brewA1, 4), (scenario.brewB1, 5), (scenario.brewA2, 5), (extra, 6)] {
            for _ in 0..<number {
                try addPhoto(in: scenario.store, to: brew, minute: minute)
                minute += 1
            }
        }
        let model = try makeModel(scenario.store)

        XCTAssertEqual(model.count, 24)
        // Method, bag and day: bag A with the first method (two brews), bag A with the last, bag B.
        XCTAssertEqual(Set(model.allItems.map(\.accessibilityLabel)).count, 3)
        XCTAssertTrue(model.allItems.allSatisfy { $0.fileURL != nil })
        model.reload()
        XCTAssertEqual(model.count, 24)
    }

    func testEveryGalleryStringResolvesInEachLanguage() throws {
        for language in VocabularyLanguage.allCases {
            let bundle = try languageBundle(language)
            let texts = [
                L10n.galleryCount("2", bundle: bundle),
                L10n.galleryCountFiltered("2", filter: "X", bundle: bundle),
                L10n.galleryPhotoLabel("A", bag: "B", date: "C", bundle: bundle),
                L10n.galleryPhotoBag("B", bundle: bundle),
                L10n.galleryMethodUnknown(bundle: bundle),
                L10n.galleryNoBag(bundle: bundle),
                L10n.galleryBagOption("B", bought: "D", bundle: bundle),
                L10n.galleryBeanUnnamed(bundle: bundle),
            ]
            for text in texts {
                XCTAssertFalse(text.isEmpty || text.contains("%") || text.hasPrefix("gallery."), "\(language.rawValue): \(text)")
            }
        }
    }
}
