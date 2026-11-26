import XCTest
@testable import Cupmark

/// The brew photo viewer's model (M2-T43b): the brew's details in each language, the three links
/// present and absent (a brew without a bag, a recipe found by its parameters and no match),
/// delete (record and file go, the brew stays, a photo that is already gone, a failed delete),
/// a photo whose file is missing, and the label shared with the gallery. Fixed dates, a temporary
/// folder per test, no UI.
@MainActor
final class BrewPhotoViewerModelTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()

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

    private func locale(_ language: VocabularyLanguage) -> Locale {
        Locale(identifier: language == .en ? "en_US" : "de_DE")
    }

    private func makeStore() throws -> AccountStore {
        let files = BrewPhotoFolders(root: root.appending(path: "BrewPhotos", directoryHint: .isDirectory)).files(for: AccountID(subject: "viewer-model-tests"))
        return try AccountStore.inMemory(brewPhotoFiles: files)
    }

    private func makeModel(_ store: AccountStore, photo: StoredBrewPhoto, language: VocabularyLanguage = .en) throws -> BrewPhotoViewerModel {
        try makeModel(store, photoID: photo.localID, language: language)
    }

    private func makeModel(_ store: AccountStore, photoID: UUID, language: VocabularyLanguage = .en) throws -> BrewPhotoViewerModel {
        let model = BrewPhotoViewerModel(
            store: store,
            photo: photoID,
            vocabulary: try vocabulary(),
            language: language,
            locale: locale(language),
            calendar: try StoreFixtures.calendar("UTC"),
            bundle: try languageBundle(language)
        )
        model.reload()
        return model
    }

    /// A rated brew of the fixture bag (espresso, 18.0 g, 300 g, 94 °C, grind 4.5) with one photo.
    private struct Scenario {
        let store: AccountStore
        let entry: StoredShelfEntry
        let brew: StoredBrew
        let photo: StoredBrewPhoto
    }

    private func makeScenario(rated: Bool = true) throws -> Scenario {
        let store = try makeStore()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(rated: rated), serverID: nil)
        try store.addBrew(brew, shelfEntry: entry)
        let photo = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 1))
        return Scenario(store: store, entry: entry, brew: brew, photo: photo)
    }

    private func detail(_ field: BrewPhotoViewerDetail.Field, in model: BrewPhotoViewerModel) throws -> BrewPhotoViewerDetail {
        try XCTUnwrap(model.content?.details.first { $0.field == field }, "no \(field) detail")
    }

    // MARK: - Details

    func testTheDetailsOfARatedBrewInEnglish() throws {
        let scenario = try makeScenario()
        let model = try makeModel(scenario.store, photo: scenario.photo)
        let content = try XCTUnwrap(model.content)
        let overall = try XCTUnwrap(scenario.brew.rating?.score(for: .overall))

        XCTAssertEqual(content.details.map(\.field), [.method, .dose, .ratio, .temperature, .grind, .score])
        XCTAssertEqual(content.details.map(\.title), ["Method", "Dose", "Ratio", "Temperature", "Grind", "Overall"])
        XCTAssertEqual(try detail(.method, in: model).value, try vocabulary().label(for: Vocabulary.Method.espresso, language: .en))
        XCTAssertEqual(try detail(.dose, in: model).value, BrewFormat.value(18, of: .dose, locale: locale(.en)))
        XCTAssertEqual(try detail(.ratio, in: model).value, "1:16.7")
        XCTAssertEqual(try detail(.temperature, in: model).value, BrewFormat.value(94, of: .temperature, locale: locale(.en)))
        XCTAssertEqual(try detail(.grind, in: model).value, BrewFormat.value(4.5, of: .grind, locale: locale(.en)))
        XCTAssertEqual(try detail(.score, in: model).value, RatingFormat.score(overall, locale: locale(.en)))
        XCTAssertEqual(try detail(.score, in: model).spokenValue, "\(RatingFormat.score(overall, locale: locale(.en))) of 10")
        XCTAssertEqual(try detail(.dose, in: model).spokenValue, try detail(.dose, in: model).value, "only a score is read differently")
    }

    func testTheDetailsAreInTheDeviceLanguage() throws {
        let scenario = try makeScenario()
        let model = try makeModel(scenario.store, photo: scenario.photo, language: .de)

        XCTAssertEqual(try detail(.method, in: model).title, "Methode")
        XCTAssertEqual(try detail(.dose, in: model).title, "Dosis")
        XCTAssertEqual(try detail(.ratio, in: model).value, "1:16,7", "a German decimal comma")
        let doseValue = try detail(.dose, in: model).value
        XCTAssertTrue(doseValue.contains("18,0"), doseValue)
        let scoreSpoken = try detail(.score, in: model).spokenValue
        XCTAssertTrue(scoreSpoken.contains(" von 10"), scoreSpoken)
    }

    func testAnUnratedBrewHasNoScoreAndValuesThatAreNotSetAreLeftOut() throws {
        let scenario = try makeScenario(rated: false)
        scenario.brew.doseDg = nil
        scenario.brew.waterTemperature = nil
        scenario.brew.grindNormalised = nil
        try scenario.store.save()

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(model.content?.details.map(\.field), [.method], "no dose, ratio, temperature, grind or score")
    }

    func testAColdTemperatureShowsItsVocabularyLabel() throws {
        let scenario = try makeScenario()
        scenario.brew.methodID = Vocabulary.Method.coldBrew.rawValue
        scenario.brew.waterTemperature = .special(.cold)
        try scenario.store.save()

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(try detail(.temperature, in: model).value, try vocabulary().label(for: Vocabulary.WaterTempSpecial.cold, language: .en))
    }

    func testAMethodTheVocabularyDoesNotKnowIsNamedBrewAndHasNoRecipe() throws {
        let scenario = try makeScenario()
        scenario.brew.methodID = "method-from-a-newer-vocabulary"
        try scenario.store.save()

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(try detail(.method, in: model).value, "Brew")
        XCTAssertNil(model.content?.recipeID)
        XCTAssertEqual(model.content?.brewLocalID, scenario.brew.localID, "the link to the brew stays")
    }

    func testTheImageHasTheLabelOfTheGalleryCell() throws {
        let scenario = try makeScenario()
        let gallery = BrewPhotoGalleryModel(
            store: scenario.store,
            vocabulary: try vocabulary(),
            language: .en,
            locale: locale(.en),
            calendar: try StoreFixtures.calendar("UTC"),
            bundle: try languageBundle(.en)
        )
        gallery.reload()
        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(model.content?.accessibilityLabel, gallery.item(id: scenario.photo.localID)?.accessibilityLabel)
        XCTAssertEqual(model.content?.accessibilityLabel, "\(try vocabulary().label(for: Vocabulary.Method.espresso, language: .en)), Bohne bag, Nov 18, 2026")
    }

    // MARK: - Links

    func testTheBrewAndBagLinksArePresent() throws {
        let scenario = try makeScenario()
        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(model.content?.brewLocalID, scenario.brew.localID)
        XCTAssertEqual(model.content?.shelfEntryID, scenario.entry.localID)
    }

    func testABrewWithoutABagHasNoBagLink() throws {
        let scenario = try makeScenario()
        scenario.brew.shelfEntry = nil
        try scenario.store.save()

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertNil(model.content?.shelfEntryID)
        XCTAssertEqual(model.content?.brewLocalID, scenario.brew.localID, "the brew link stays")
        XCTAssertTrue(model.content?.accessibilityLabel.contains("no bag") == true, model.content?.accessibilityLabel ?? "")
    }

    func testABagThatWasRemovedHasNoBagLink() throws {
        let scenario = try makeScenario()
        scenario.entry.syncState = .pendingDelete
        try scenario.store.save()

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertNil(model.content?.shelfEntryID)
    }

    func testTheRecipeLinkIsTheSavedRecipeWithTheBrewsParameters() throws {
        let scenario = try makeScenario()
        XCTAssertNil(try makeModel(scenario.store, photo: scenario.photo).content?.recipeID, "no recipe yet")

        let recipe = try scenario.store.saveRecipe(try scenario.brew.apiParameters())
        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(model.content?.recipeID, recipe.localID)
    }

    func testARecipeWithOtherParametersIsNotTheBrewsRecipe() throws {
        let scenario = try makeScenario()
        var other = try scenario.brew.apiParameters()
        other.doseDg = 200
        try scenario.store.saveRecipe(other)

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertNil(model.content?.recipeID)
    }

    func testARemovedRecipeIsNoLongerLinked() throws {
        let scenario = try makeScenario()
        let recipe = try scenario.store.saveRecipe(try scenario.brew.apiParameters())
        try scenario.store.deleteRecipe(recipe)

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertNil(model.content?.recipeID)
    }

    func testABrewOfAMethodWithoutATemperatureMatchesTheRecipeSavedFromIt() throws {
        // The brew keeps a temperature its method does not allow; a recipe saved from the brew
        // leaves it out (`saveRecipe` conforms to the method rules), and still is its recipe.
        let scenario = try makeScenario()
        scenario.brew.methodID = Vocabulary.Method.mokaPot.rawValue
        try scenario.store.save()
        let parameters = try scenario.brew.apiParameters()
        XCTAssertTrue(parameters.violatesMethodRules, "the fixture must break a method rule")
        let recipe = try scenario.store.saveRecipe(parameters)

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertEqual(model.content?.recipeID, recipe.localID)
    }

    // MARK: - The photo

    func testAPhotoWhoseFileIsMissingIsKeptWithoutAnImage() throws {
        let scenario = try makeScenario()
        try FileManager.default.removeItem(at: try scenario.store.brewPhotoFileURL(of: scenario.photo))

        let model = try makeModel(scenario.store, photo: scenario.photo)

        XCTAssertNotNil(model.content)
        XCTAssertNil(model.content?.fileURL)
        XCTAssertEqual(model.content?.details.first?.field, .method, "the details are still shown")
        XCTAssertFalse(model.isGone)
    }

    func testAPhotoThatIsGoneIsToldFromOneThatIsNotReadYet() throws {
        let scenario = try makeScenario()
        let model = BrewPhotoViewerModel(
            store: scenario.store,
            photo: UUID(),
            vocabulary: try vocabulary(),
            language: .en
        )
        XCTAssertFalse(model.isGone, "not read yet")

        model.reload()

        XCTAssertTrue(model.isGone)
        XCTAssertNil(model.content)
        XCTAssertFalse(model.loadFailed)
    }

    func testThePhotoOfARemovedBrewIsGone() throws {
        let scenario = try makeScenario()
        scenario.brew.syncState = .pendingDelete
        try scenario.store.save()

        XCTAssertTrue(try makeModel(scenario.store, photo: scenario.photo).isGone)
    }

    // MARK: - Delete

    func testDeleteAsksFirstAndCancelChangesNothing() throws {
        let scenario = try makeScenario()
        let model = try makeModel(scenario.store, photo: scenario.photo)

        model.requestDelete()
        XCTAssertTrue(model.isConfirmingDelete)
        XCTAssertFalse(model.isDeleted)
        XCTAssertNotNil(try scenario.store.brewPhoto(localID: scenario.photo.localID), "asking deleted nothing")

        model.cancelDelete()

        XCTAssertFalse(model.isConfirmingDelete)
        XCTAssertFalse(model.isDeleted)
        XCTAssertNotNil(try scenario.store.brewPhoto(localID: scenario.photo.localID))
        XCTAssertTrue(BrewPhotoFixtures.exists(try scenario.store.brewPhotoFileURL(of: scenario.photo)))
    }

    func testConfirmingDeletesTheRecordAndTheFileButNotTheBrew() throws {
        let scenario = try makeScenario()
        let other = try scenario.store.addBrewPhoto(to: scenario.brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 2))
        let url = try scenario.store.brewPhotoFileURL(of: scenario.photo)
        let otherURL = try scenario.store.brewPhotoFileURL(of: other)
        let parameters = try scenario.brew.apiParameters()
        let rating = scenario.brew.rating
        let model = try makeModel(scenario.store, photo: scenario.photo)

        model.requestDelete()
        model.confirmDelete()

        XCTAssertTrue(model.isDeleted)
        XCTAssertFalse(model.isConfirmingDelete)
        XCTAssertFalse(model.deleteFailed)
        XCTAssertNil(try scenario.store.brewPhoto(localID: scenario.photo.localID), "the record is gone")
        XCTAssertFalse(BrewPhotoFixtures.exists(url), "the file is gone")
        XCTAssertNotNil(try scenario.store.brewPhoto(localID: other.localID), "the brew's other photo stays")
        XCTAssertTrue(BrewPhotoFixtures.exists(otherURL))
        let brew = try XCTUnwrap(try scenario.store.brew(localID: scenario.brew.localID))
        XCTAssertNotEqual(brew.syncState, .pendingDelete)
        XCTAssertEqual(try brew.apiParameters(), parameters, "the brew is as it was")
        XCTAssertEqual(brew.rating, rating)
        XCTAssertTrue(model.isGone, "the viewer has nothing left to show")
    }

    func testTheGalleryNoLongerListsADeletedPhoto() throws {
        let scenario = try makeScenario()
        let gallery = BrewPhotoGalleryModel(
            store: scenario.store,
            vocabulary: try vocabulary(),
            language: .en,
            locale: locale(.en),
            calendar: try StoreFixtures.calendar("UTC"),
            bundle: try languageBundle(.en)
        )
        gallery.reload()
        XCTAssertEqual(gallery.count, 1)
        let model = try makeModel(scenario.store, photo: scenario.photo)

        model.confirmDelete()
        gallery.reload()

        XCTAssertEqual(gallery.count, 0)
        XCTAssertTrue(gallery.hasNoPhotos)
    }

    func testDeletingAPhotoThatIsAlreadyGoneCountsAsDeleted() throws {
        let scenario = try makeScenario()
        let model = try makeModel(scenario.store, photo: scenario.photo)
        try scenario.store.deleteBrewPhoto(localID: scenario.photo.localID)

        model.requestDelete()
        model.confirmDelete()

        XCTAssertTrue(model.isDeleted)
        XCTAssertFalse(model.deleteFailed)
    }

    // MARK: - Strings

    func testEveryViewerStringResolvesInEachLanguage() throws {
        for language in VocabularyLanguage.allCases {
            let bundle = try languageBundle(language)
            let texts = [
                L10n.viewerDetailMethod(bundle: bundle),
                L10n.viewerDetailDose(bundle: bundle),
                L10n.viewerDetailRatio(bundle: bundle),
                L10n.viewerDetailTemperature(bundle: bundle),
                L10n.viewerDetailGrind(bundle: bundle),
                L10n.galleryCountValueFiltered("2", filter: "X", bundle: bundle),
            ]
            for text in texts {
                XCTAssertFalse(text.isEmpty || text.contains("%") || text.hasPrefix("viewer.") || text.hasPrefix("gallery."), "\(language.rawValue): \(text)")
            }
        }
    }
}

/// The recipe screen the viewer links to (M2-T43b): the recipe's values, and a brew from it only
/// when the bag is there.
@MainActor
final class RecipeDetailModelTests: XCTestCase {
    private func makeStore() throws -> AccountStore {
        try AccountStore.inMemory()
    }

    func testTheRecipeShowsItsValuesAndOffersABrewForTheBag() throws {
        let store = try makeStore()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = try store.saveRecipe(try StoreFixtures.parameters())
        let model = RecipeDetailModel(store: store, recipe: recipe.localID, shelfEntry: entry.localID)
        XCTAssertFalse(model.isGone, "not read yet")

        model.reload()

        XCTAssertEqual(model.summary?.method, try StoreFixtures.first(Vocabulary.Method.self))
        XCTAssertTrue(model.canBrew)
        XCTAssertEqual(model.brewRoute, BrewRoute(shelfEntryLocalID: entry.localID, start: .recipe(recipe.localID)))
    }

    func testWithoutABagThereIsNoBrew() throws {
        let store = try makeStore()
        let recipe = try store.saveRecipe(try StoreFixtures.parameters())
        let model = RecipeDetailModel(store: store, recipe: recipe.localID, shelfEntry: nil)

        model.reload()

        XCTAssertNotNil(model.summary)
        XCTAssertFalse(model.canBrew)
        XCTAssertNil(model.brewRoute)
    }

    func testARecipeThatIsGoneIsToldSo() throws {
        let store = try makeStore()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = try store.saveRecipe(try StoreFixtures.parameters())
        try store.deleteRecipe(recipe)
        let model = RecipeDetailModel(store: store, recipe: recipe.localID, shelfEntry: entry.localID)

        model.reload()

        XCTAssertTrue(model.isGone)
        XCTAssertNil(model.brewRoute)
    }
}

/// The thumbnail rules of M2-T43b: a failed load keeps the last good image of the same file.
@MainActor
final class BrewPhotoThumbnailUpdateTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func goodFile() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: "good.jpg", directoryHint: .notDirectory)
        try BrewPhotoFixtures.photo().data.write(to: url)
        return url
    }

    func testAFileThatCannotBeReadShowsNothingWithoutAnImageBefore() async throws {
        let missing = root.appending(path: "missing.jpg", directoryHint: .notDirectory)

        let result = await BrewPhotoThumbnails.updated(nil, for: missing, maxPixelSize: 64)

        XCTAssertNil(result)
    }

    func testNoFileShowsNothing() async throws {
        let url = try goodFile()
        let current = await BrewPhotoThumbnails.updated(nil, for: url, maxPixelSize: 64)
        XCTAssertNotNil(current)

        let result = await BrewPhotoThumbnails.updated(current, for: nil, maxPixelSize: 64)

        XCTAssertNil(result)
    }

    func testAFailedLoadKeepsTheLastGoodImageOfTheSameFile() async throws {
        let url = try goodFile()
        let good = await BrewPhotoThumbnails.updated(nil, for: url, maxPixelSize: 64)
        XCTAssertEqual(good?.url, url)
        // The file becomes unreadable; a larger size asks for a new load, which fails.
        try FileManager.default.removeItem(at: url)

        let result = await BrewPhotoThumbnails.updated(good, for: url, maxPixelSize: 128)

        XCTAssertEqual(result?.url, url)
        XCTAssertEqual(result?.pixels, 64, "the image that was good is kept as it was")
    }

    func testAnImageAlreadyShownIsNotReadAgain() async throws {
        let url = try goodFile()
        let good = await BrewPhotoThumbnails.updated(nil, for: url, maxPixelSize: 64)
        try FileManager.default.removeItem(at: url)

        let result = await BrewPhotoThumbnails.updated(good, for: url, maxPixelSize: 64)

        XCTAssertEqual(result?.url, url, "no read was needed, so the missing file did not matter")
    }

    func testTheImageOfAnotherFileIsNeverKept() async throws {
        let url = try goodFile()
        let good = await BrewPhotoThumbnails.updated(nil, for: url, maxPixelSize: 64)
        let missing = root.appending(path: "other.jpg", directoryHint: .notDirectory)

        let result = await BrewPhotoThumbnails.updated(good, for: missing, maxPixelSize: 64)

        XCTAssertNil(result)
    }
}
