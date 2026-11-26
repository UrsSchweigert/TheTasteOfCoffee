import SwiftData
import XCTest
@testable import Cupmark

/// Recipes and one-tap repeats (M2-T27, docs/04 F2, docs/03 Goals): a repeat of a recipe or of
/// the last brew gives a `BrewInput` with those parameters, a new `brewed_at` and the chosen
/// shelf entry; the flow saves it with no further input and goes on to the rating; recipes are
/// kept, replaced and removed offline through the outbox, and the engine sends them. Vocabulary
/// values come from the generated enums, never from a list typed here. Every `FakeSyncServer`
/// is held for the whole test.
@MainActor
final class RecipeTests: XCTestCase {
    private struct WriteFailed: Error {}

    private static let otherShelfEntryID = "01JD00000000000000000SHEF2"
    private static let otherRecipeID = "01JD000000000000000000RCP2"
    private static let otherBeanID = "01JD00000000000000000BEAN3"
    private static let otherBeanEntryID = "01JD00000000000000000SHEF3"

    private func now() throws -> Date {
        try StoreFixtures.timestamp("2026-11-26T07:15:00.250Z").date
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    /// The parameters of the recipes and earlier brews here: every field set.
    private func parameters() throws -> API.BrewParameters {
        try StoreFixtures.parameters()
    }

    /// Other parameters: another method and dose, `cold` when the vocabulary has it.
    private func otherParameters() throws -> API.BrewParameters {
        var parameters = try StoreFixtures.parameters()
        parameters.method = try StoreFixtures.last(Vocabulary.Method.self)
        parameters.doseDg = 200
        parameters.waterTemperature = Vocabulary.WaterTempSpecial.allCases.first.map { special in API.WaterTemperature.special(special) }
        return parameters
    }

    private func syncedRecipe(_ parameters: API.BrewParameters, in store: AccountStore, serverID: String = StoreFixtures.recipeID) throws -> StoredRecipe {
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters), serverID: serverID)
        try store.addRecipe(recipe, syncState: .synced)
        return recipe
    }

    /// A second synced shelf entry, of the same bean as `entry`.
    private func otherEntry(like entry: StoredShelfEntry, in store: AccountStore) throws -> StoredShelfEntry {
        let bean = try XCTUnwrap(entry.bean)
        let other = StoredShelfEntry(try StoreFixtures.shelfEntryInput(), serverID: RecipeTests.otherShelfEntryID)
        try store.addShelfEntry(other, bean: bean, syncState: .synced)
        return other
    }

    /// A synced shelf entry of another bean than the fixtures' one.
    private func otherBeanEntry(in store: AccountStore) throws -> StoredShelfEntry {
        let bean = StoredBean(API.Bean(
            beanId: RecipeTests.otherBeanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(process: try StoreFixtures.last(Vocabulary.Process.self)),
            operatorAttributes: API.BeanAttributes()
        ))
        try store.addBean(bean, syncState: .synced)
        var values = try StoreFixtures.shelfEntryInput()
        values.beanId = RecipeTests.otherBeanID
        let entry = StoredShelfEntry(values, serverID: RecipeTests.otherBeanEntryID)
        try store.addShelfEntry(entry, bean: bean, syncState: .synced)
        return entry
    }

    /// A rated brew on `entry`, brewed at `brewedAt`, with buy again set to `buyAgain` so the
    /// tests can tell ratings apart.
    @discardableResult
    private func ratedBrew(on entry: StoredShelfEntry, at brewedAt: String, buyAgain: Bool, in store: AccountStore) throws -> StoredBrew {
        var values = try StoreFixtures.brewInput(brewedAt: brewedAt, rated: true)
        values.rating?.buyAgain = buyAgain
        let brew = try StoredBrew(values)
        try store.addBrew(brew, shelfEntry: entry)
        return brew
    }

    private func flow(_ entry: StoredShelfEntry, _ start: BrewStart, _ store: AccountStore) throws -> BrewFlowModel {
        let now = try now()
        return BrewFlowModel(
            route: BrewRoute(shelfEntryLocalID: entry.localID, start: start),
            store: store,
            now: { now },
            calendar: try StoreFixtures.calendar("Europe/Berlin")
        )
    }

    func testFixtureIDsAreValidContractIDs() {
        for id in [RecipeTests.otherShelfEntryID, RecipeTests.otherRecipeID, RecipeTests.otherBeanID, RecipeTests.otherBeanEntryID] {
            XCTAssertNotNil(ResourceID(id), "\(id) is not a ULID")
        }
    }

    // MARK: - A repeat gives the BrewInput

    func testARepeatOfARecipeGivesItsParametersANewBrewedAtAndTheChosenShelfEntry() throws {
        let store = try AccountStore.inMemory()
        let first = try StoreFixtures.syncedShelfEntry(in: store)
        let chosen = try otherEntry(like: first, in: store)
        let recipe = try syncedRecipe(try parameters(), in: store)

        let flow = try flow(chosen, .recipe(recipe.localID), store)

        XCTAssertEqual(flow.phase, .brewing)
        XCTAssertEqual(flow.form.startedFrom, .recipe(recipe.localID))
        XCTAssertEqual(flow.form.draft.parameters, try parameters(), "every parameter of the recipe is prefilled")
        XCTAssertFalse(flow.form.timer.isRunning, "the timer is ready, not running")
        XCTAssertTrue(flow.form.canSave, "a repeat can be saved with no further input")

        let brewID = try XCTUnwrap(flow.save())

        XCTAssertEqual(flow.phase, .rating(brewLocalID: brewID), "saving goes on to the rating")
        let brew = try XCTUnwrap(try store.brew(localID: brewID))
        let expected = API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: RecipeTests.otherShelfEntryID,
            brewedAt: try StoreFixtures.timestamp("2026-11-26T07:15:00.250Z"),
            parameters: try parameters(),
            rating: nil
        )
        XCTAssertEqual(try brew.apiInput(), expected)
        XCTAssertEqual(brew.shelfEntry?.localID, chosen.localID)
        XCTAssertEqual(try queue(store), ["create brew"], "the recipe is not touched")
        XCTAssertEqual(recipe.syncState, .synced)
    }

    func testARepeatOfTheLastBrewCopiesItsParametersButNotItsBrewedAtOrRating() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let earlier = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:30:00.123Z", rated: true), serverID: StoreFixtures.brewID)
        try store.addBrew(earlier, shelfEntry: entry, syncState: .synced)

        let flow = try flow(entry, .lastBrew, store)

        XCTAssertEqual(flow.form.startedFrom, .lastBrew)
        XCTAssertTrue(flow.form.canSave)
        let brewID = try XCTUnwrap(flow.save())
        XCTAssertEqual(flow.phase, .rating(brewLocalID: brewID))
        let input = try XCTUnwrap(try store.brew(localID: brewID)).apiInput()
        XCTAssertEqual(input.parameters, try StoreFixtures.parameters())
        XCTAssertEqual(input.shelfEntryId, StoreFixtures.shelfEntryID)
        XCTAssertEqual(input.brewedAt, try StoreFixtures.timestamp("2026-11-26T07:15:00.250Z"), "a new brewed_at, not the copied one")
        XCTAssertNotEqual(input.brewedAt, try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z"))
        XCTAssertNil(input.rating, "the rating is not copied; the rating screen offers the last one")
        XCTAssertEqual(try queue(store), ["create brew"])
        XCTAssertEqual(try store.brewsNewestFirst().count, 2)
    }

    func testANewBagRepeatsTheNewestBrewOfAnyBag() throws {
        let store = try AccountStore.inMemory()
        let first = try StoreFixtures.syncedShelfEntry(in: store)
        let older = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-20T08:00:00.000Z", rated: false))
        try store.addBrew(older, shelfEntry: first)
        var newerValues = try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z", rated: false)
        newerValues.parameters = try otherParameters()
        try store.addBrew(try StoredBrew(newerValues), shelfEntry: first)
        let newBag = try otherEntry(like: first, in: store)
        XCTAssertTrue(newBag.liveBrewsNewestFirst.isEmpty)

        let flow = try flow(newBag, .lastBrew, store)

        XCTAssertEqual(flow.form.draft.parameters, try otherParameters())
        let input = try XCTUnwrap(try store.brew(localID: try XCTUnwrap(flow.save()))).apiInput()
        XCTAssertEqual(input.shelfEntryId, RecipeTests.otherShelfEntryID, "the brew is on the chosen bag")
        XCTAssertEqual(input.parameters, try otherParameters())
    }

    func testTheBagsOwnLastBrewComesBeforeANewerBrewOfAnotherBag() throws {
        let store = try AccountStore.inMemory()
        let first = try StoreFixtures.syncedShelfEntry(in: store)
        let second = try otherEntry(like: first, in: store)
        try store.addBrew(try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-20T08:00:00.000Z", rated: false)), shelfEntry: second)
        var newerValues = try StoreFixtures.brewInput(brewedAt: "2026-11-25T08:00:00.000Z", rated: false)
        newerValues.parameters = try otherParameters()
        try store.addBrew(try StoredBrew(newerValues), shelfEntry: first)

        XCTAssertEqual(try flow(second, .lastBrew, store).form.draft.parameters, try StoreFixtures.parameters())
    }

    func testAStartThatIsGoneOpensAnEmptyFormThatCanStillBeSaved() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try parameters()))
        try store.addRecipe(recipe)
        let recipeID = recipe.localID
        try store.deleteRecipe(recipe)

        let flow = try flow(entry, .recipe(recipeID), store)

        XCTAssertEqual(flow.form.failure, .startNotFound)
        XCTAssertEqual(flow.form.startedFrom, .blank)
        XCTAssertNil(flow.form.draft.method)
        XCTAssertFalse(flow.form.replacesStartedRecipe)
        flow.form.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        XCTAssertNotNil(flow.save())
        XCTAssertNil(flow.form.failure)

        let noBrew = try self.flow(entry, .lastBrew, try AccountStore.inMemory())
        XCTAssertEqual(noBrew.form.failure, .notFound, "an entry of another store is not found")
    }

    func testRepeatingTheLastBrewOnADeviceWithNoBrewSaysSo() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)

        let flow = try flow(entry, .lastBrew, store)

        XCTAssertEqual(flow.form.failure, .startNotFound)
        XCTAssertEqual(flow.form.startedFrom, .blank)
    }

    func testABlankBrewStartsAsBefore() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        try store.addBrew(try StoredBrew(try StoreFixtures.brewInput(rated: false), serverID: StoreFixtures.brewID), shelfEntry: entry, syncState: .synced)

        let flow = try flow(entry, .blank, store)

        XCTAssertNil(flow.form.failure)
        XCTAssertEqual(flow.form.draft.method, try parameters().method, "only the method is preselected")
        XCTAssertNil(flow.form.draft.doseDg)
    }

    // MARK: - Keeping a brew as a recipe

    func testABrewCanBeKeptAsARecipeInTheSameSave() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let flow = try flow(entry, .blank, store)
        flow.form.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        flow.form.draft.setValue(18.5, of: .dose)
        flow.form.draft.setValue(300, of: .water)
        flow.form.keepsAsRecipe = true

        let brewID = try XCTUnwrap(flow.save())

        XCTAssertEqual(try queue(store), ["create brew", "create recipe"], "the recipe goes out after the brew, never holding it")
        let recipeID = try XCTUnwrap(flow.form.savedRecipeID)
        let recipe = try XCTUnwrap(try store.liveRecipe(localID: recipeID))
        let brew = try XCTUnwrap(try store.brew(localID: brewID))
        XCTAssertEqual(try recipe.apiInput(), API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try brew.apiParameters()))
        XCTAssertEqual(recipe.syncState, .pendingCreate)
        XCTAssertEqual(recipe.createdAt, try now())

        // The same values again keep the one recipe.
        let again = try self.flow(entry, .recipe(recipeID), store)
        again.form.keepsAsRecipe = true
        XCTAssertNotNil(again.save())
        XCTAssertEqual(try store.recipes().count, 1)
        XCTAssertEqual(try queue(store), ["create brew", "create recipe", "create brew"], "an unchanged recipe queues nothing")
    }

    func testABrewStartedFromARecipeCanReplaceIt() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = try syncedRecipe(try parameters(), in: store)
        let flow = try flow(entry, .recipe(recipe.localID), store)
        XCTAssertTrue(flow.form.replacesStartedRecipe)
        flow.form.increment(.dose)
        flow.form.keepsAsRecipe = true

        XCTAssertNotNil(flow.save())

        XCTAssertEqual(flow.form.savedRecipeID, recipe.localID)
        XCTAssertEqual(recipe.doseDg, try parameters().doseDg.map { dose in dose + 1 })
        XCTAssertEqual(recipe.syncState, .pendingUpdate)
        XCTAssertEqual(try queue(store), ["create brew", "update recipe"])
        XCTAssertEqual(try store.recipes().count, 1)
    }

    func testARecipeOfANewerVocabularyIsNotReplacedButKeptAsANewOne() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let newer = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version + 1, parameters: try parameters()), serverID: StoreFixtures.recipeID)
        try store.addRecipe(newer, syncState: .synced)
        let flow = try flow(entry, .recipe(newer.localID), store)
        XCTAssertFalse(flow.form.replacesStartedRecipe)
        flow.form.increment(.dose)
        flow.form.keepsAsRecipe = true

        XCTAssertNotNil(flow.save())

        XCTAssertEqual(newer.doseDg, try parameters().doseDg, "the newer recipe is left as it is")
        XCTAssertEqual(newer.vocabularyVersion, Vocabulary.version + 1)
        XCTAssertEqual(try store.recipes().count, 2)
        XCTAssertEqual(try queue(store), ["create brew", "create recipe"])
        XCTAssertThrowsError(try store.replaceRecipe(newer, with: try otherParameters())) { error in
            XCTAssertEqual(error as? RecipeWriteError, .newerVocabulary)
        }
    }

    func testAFailedBrewSaveKeepsNoRecipeEither() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let now = try now()
        let model = BrewFormModel(
            shelfEntry: entry.localID,
            store: store,
            now: { now },
            calendar: try StoreFixtures.calendar("Europe/Berlin")
        )
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        model.keepsAsRecipe = true
        // The real write stages the brew and then the recipe; only its one save fails, so the
        // rollback has to drop both, and both of their queued creates.
        store.willSave = { throw WriteFailed() }

        XCTAssertNil(model.save())
        store.willSave = nil

        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertNil(model.savedRecipeID)
        XCTAssertTrue(try store.recipes().isEmpty)
        XCTAssertTrue(try queue(store).isEmpty)
        XCTAssertFalse(store.context.hasChanges)
    }

    func testAFailedReplacementInTheBrewFormPutsTheRecipeBack() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = try syncedRecipe(try parameters(), in: store)
        let flow = try flow(entry, .recipe(recipe.localID), store)
        flow.form.increment(.dose)
        flow.form.keepsAsRecipe = true
        store.willSave = { throw WriteFailed() }

        XCTAssertNil(flow.save())

        store.willSave = nil
        XCTAssertEqual(flow.phase, .brewing)
        XCTAssertEqual(recipe.doseDg, try parameters().doseDg)
        XCTAssertEqual(recipe.syncState, .synced)
        XCTAssertTrue(try queue(store).isEmpty)
        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
    }

    // MARK: - Store writes reach the outbox

    func testSavingARecipeQueuesItsCreateOnceForTheSameParameters() throws {
        let store = try AccountStore.inMemory()

        let recipe = try store.saveRecipe(try parameters())
        let again = try store.saveRecipe(try parameters())

        XCTAssertEqual(again.localID, recipe.localID)
        XCTAssertEqual(try queue(store), ["create recipe"])
        XCTAssertEqual(try recipe.apiInput(), API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try parameters()))
        XCTAssertNotNil(try store.recipe(matching: try parameters()))
        XCTAssertNil(try store.recipe(matching: try otherParameters()))
    }

    func testReplacingARecipeQueuesOneUpdateAndAnUnchangedOneNothing() throws {
        let store = try AccountStore.inMemory()
        let recipe = try syncedRecipe(try parameters(), in: store)

        XCTAssertEqual(try store.replaceRecipe(recipe, with: try parameters()), .unchanged)
        XCTAssertTrue(try queue(store).isEmpty)

        XCTAssertEqual(try store.replaceRecipe(recipe, with: try otherParameters()), .replaced)
        XCTAssertEqual(try store.replaceRecipe(recipe, with: try parameters()), .replaced)

        XCTAssertEqual(try queue(store), ["update recipe"], "one update carries both changes")
        XCTAssertEqual(recipe.syncState, .pendingUpdate)
        XCTAssertEqual(try recipe.apiParameters(), try parameters())
    }

    func testReplacingAnUnsentRecipeChangesItsCreate() throws {
        let store = try AccountStore.inMemory()
        let recipe = try store.saveRecipe(try parameters())

        XCTAssertEqual(try store.replaceRecipe(recipe, with: try otherParameters()), .replaced)

        XCTAssertEqual(try queue(store), ["create recipe"])
        XCTAssertEqual(recipe.syncState, .pendingCreate)
        XCTAssertEqual(try recipe.apiParameters(), try otherParameters())
    }

    func testDeletingARecipeQueuesADeleteOrRemovesAnUnsentOne() throws {
        let store = try AccountStore.inMemory()
        let synced = try syncedRecipe(try parameters(), in: store)
        let unsent = try store.saveRecipe(try otherParameters())

        try store.deleteRecipe(synced)
        try store.deleteRecipe(unsent)

        XCTAssertEqual(synced.syncState, .pendingDelete)
        XCTAssertEqual(try queue(store), ["delete recipe"])
        XCTAssertTrue(try store.recipes().isEmpty, "removed recipes are hidden")
        XCTAssertNil(try store.liveRecipe(localID: synced.localID))
        XCTAssertThrowsError(try store.replaceRecipe(synced, with: try otherParameters())) { error in
            XCTAssertEqual(error as? RecipeWriteError, .notFound)
        }
    }

    func testFailedRecipeWritesLeaveNothingBehind() throws {
        let store = try AccountStore.inMemory()
        let recipe = try syncedRecipe(try parameters(), in: store)
        store.willSave = { throw WriteFailed() }

        XCTAssertThrowsError(try store.saveRecipe(try otherParameters()))
        XCTAssertThrowsError(try store.replaceRecipe(recipe, with: try otherParameters()))
        XCTAssertThrowsError(try store.deleteRecipe(recipe))

        store.willSave = nil
        XCTAssertEqual(try recipe.apiParameters(), try parameters())
        XCTAssertEqual(recipe.syncState, .synced)
        XCTAssertEqual(try store.recipes().count, 1)
        XCTAssertTrue(try queue(store).isEmpty)
        // The next unrelated save stores none of it.
        try store.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try otherParameters())))
        let disk = ModelContext(store.container)
        let savedDoses = try withExtendedLifetime(disk) {
            try disk.fetch(FetchDescriptor<StoredRecipe>()).map { stored in (stored.localID, stored.doseDg) }
        }
        XCTAssertEqual(savedDoses.count, 2)
        XCTAssertEqual(savedDoses.first { saved in saved.0 == recipe.localID }?.1, try parameters().doseDg)
    }

    // MARK: - The engine sends them

    func testTheEngineSendsTheCreateTheReplacementAndTheDelete() async throws {
        let server = try FakeSyncServer()
        let store = try AccountStore.inMemory()
        let clock = TestClock()
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })

        let recipe = try store.saveRecipe(try parameters())
        let created = await engine.drain()
        XCTAssertEqual(created, .idle)
        let serverID = try XCTUnwrap(recipe.serverID)
        XCTAssertEqual(server.backend.storedRecipes[serverID], API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try parameters()))

        XCTAssertEqual(try store.replaceRecipe(recipe, with: try otherParameters()), .replaced)
        let replaced = await engine.drain()
        XCTAssertEqual(replaced, .idle)
        XCTAssertEqual(server.backend.storedRecipes[serverID]?.parameters, try otherParameters())
        XCTAssertEqual(recipe.syncState, .synced)

        try store.deleteRecipe(recipe)
        let deleted = await engine.drain()
        XCTAssertEqual(deleted, .idle)

        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["POST /recipes", "PUT /recipes/\(serverID)", "DELETE /recipes/\(serverID)"])
            XCTAssertTrue(server.backend.storedRecipes.isEmpty)
        }
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertTrue(try store.context.fetch(FetchDescriptor<StoredRecipe>()).isEmpty)
    }

    func testARecipeKeptWithABrewOfflineIsSentWithIt() async throws {
        let server = try FakeSyncServer()
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        server.backend.seed(shelfEntry: StoreFixtures.shelfEntryID, try StoreFixtures.shelfEntryInput())
        let flow = try flow(entry, .blank, store)
        flow.form.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        flow.form.keepsAsRecipe = true
        XCTAssertNotNil(flow.save())
        let clock = TestClock()
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })

        let result = await engine.drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["POST /brews", "POST /recipes"])
            XCTAssertEqual(server.backend.storedRecipes.count, 1)
        }
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    // MARK: - Lists and summaries

    func testTheRepeatsOfAnEntryListTheLastBrewAndTheRecipesNewestFirst() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = BrewStartModel(shelfEntry: entry.localID, store: store)
        model.reload()
        XCTAssertNil(model.lastBrew)
        XCTAssertTrue(model.recipes.isEmpty)

        try store.addBrew(try StoredBrew(try StoreFixtures.brewInput(rated: false)), shelfEntry: entry)
        let base = try now()
        var made: [UUID] = []
        for offset in 0..<(BrewStartModel.inlineRecipeLimit + 1) {
            var values = try parameters()
            values.doseDg = 150 + offset
            made.append(try store.saveRecipe(values, createdAt: base.addingTimeInterval(Double(offset))).localID)
        }
        model.reload()

        XCTAssertEqual(model.lastBrew?.draft.parameters, try parameters())
        XCTAssertEqual(model.recipes.map(\.id), Array(made.reversed()), "newest first")
        XCTAssertEqual(model.inlineRecipes.count, BrewStartModel.inlineRecipeLimit)
        XCTAssertTrue(model.hasMoreRecipes)
        XCTAssertEqual(model.route(.recipe(made[0])), BrewRoute(shelfEntryLocalID: entry.localID, start: .recipe(made[0])))

        model.delete(made[0])
        XCTAssertFalse(model.deleteFailed)
        XCTAssertFalse(model.recipes.contains { row in row.id == made[0] })
        XCTAssertFalse(model.hasMoreRecipes)
        XCTAssertEqual(try queue(store), ["create brew", "create recipe", "create recipe", "create recipe"], "a never-sent recipe goes with its create")
    }

    func testASummaryShowsMethodDoseRatioTemperatureAndGrind() throws {
        let english = Locale(identifier: "en_US")
        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        draft.setValue(18, of: .dose)
        draft.setValue(300, of: .water)
        draft.setValue(94, of: .temperature)
        draft.setValue(4.5, of: .grind)
        let summary = BrewSummary(draft)

        let details = summary.details(locale: english) { special in special.rawValue }

        XCTAssertEqual(summary.method, try StoreFixtures.first(Vocabulary.Method.self))
        XCTAssertEqual(details, [
            BrewFormat.value(18, of: .dose, locale: english),
            BrewFormat.ratio(300.0 / 18.0, locale: english),
            BrewFormat.value(94, of: .temperature, locale: english),
            L10n.recipeGrindValue(BrewFormat.value(4.5, of: .grind, locale: english)),
        ])
        XCTAssertEqual(details[1], "1:16.7")
        XCTAssertTrue(details[0].contains("18"))
        XCTAssertTrue(details[3].contains("4.5"))
        // One line, joined with the catalogue's separator: no conjunction between values.
        let line = summary.detailLine(locale: english) { special in special.rawValue }
        XCTAssertEqual(line, details.joined(separator: L10n.recipeSummarySeparator))
        XCTAssertFalse(L10n.recipeSummarySeparator.trimmingCharacters(in: .whitespaces).isEmpty)
        XCTAssertEqual(line.components(separatedBy: L10n.recipeSummarySeparator), details)
        XCTAssertFalse(line.contains(" and "))

        // Only what is set, and a special temperature by its label.
        var sparse = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        if let special = Vocabulary.WaterTempSpecial.allCases.first {
            sparse.chooseTemperature(.special(special), seed: nil)
            XCTAssertEqual(BrewSummary(sparse).details(locale: english) { _ in "label" }, ["label"])
        }
        XCTAssertEqual(BrewSummary(BrewDraft()).details(locale: english) { _ in "label" }, [])
    }

    func testARecipeWithAnUnknownMethodIsListedWithoutOne() throws {
        let store = try AccountStore.inMemory()
        let recipe = try syncedRecipe(try parameters(), in: store)
        recipe.methodID = "method_of_a_newer_vocabulary"
        try store.save()

        let row = RecipeRow(recipe)

        XCTAssertNil(row.summary.method)
        XCTAssertNil(try store.recipe(matching: try parameters()), "an unknown id matches nothing")
    }

    func testABrewInTheBrewListCanBeKeptAsARecipe() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(rated: true), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        let list = BrewListModel(shelfEntry: entry.localID, store: store)
        list.reload()
        XCTAssertEqual(list.rows.map(\.isRecipe), [false])

        list.saveAsRecipe(brew.localID)
        list.saveAsRecipe(brew.localID)

        XCTAssertFalse(list.recipeSaveFailed)
        XCTAssertEqual(list.rows.map(\.isRecipe), [true])
        XCTAssertEqual(try store.recipes().count, 1)
        XCTAssertEqual(try store.recipes().first?.apiParameters(), try brew.apiParameters())
        XCTAssertEqual(try queue(store), ["create recipe"], "the brew itself is not changed")
    }

    func testTheShelfOffersRepeatLastBrewOnceTheDeviceHasABrew() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let shelf = ShelfModel(store: store)
        shelf.reload()
        XCTAssertFalse(shelf.canRepeatLastBrew)

        let brew = try StoredBrew(try StoreFixtures.brewInput(rated: false))
        try store.addBrew(brew, shelfEntry: entry)
        shelf.reload()
        XCTAssertTrue(shelf.canRepeatLastBrew)

        try store.markDeleted(brew)
        shelf.reload()
        XCTAssertFalse(shelf.canRepeatLastBrew, "a removed brew is not repeated")
    }

    // MARK: - Replacing with another recipe's values, a newer vocabulary at save, parked creates

    func testReplacingARecipeWithAnotherRecipesValuesIsRefused() throws {
        let store = try AccountStore.inMemory()
        let first = try syncedRecipe(try parameters(), in: store)
        let second = try syncedRecipe(try otherParameters(), in: store, serverID: RecipeTests.otherRecipeID)

        XCTAssertEqual(try store.replaceRecipe(first, with: try otherParameters()), .alreadyRecipe(second.localID))

        XCTAssertEqual(try first.apiParameters(), try parameters(), "the recipe is left as it is")
        XCTAssertEqual(first.syncState, .synced)
        XCTAssertTrue(try queue(store).isEmpty)
        XCTAssertEqual(try store.recipes().count, 2, "never two equal recipes")
    }

    func testTheBrewFormKeepsTheOtherRecipeWhenTheValuesAreAlreadyOne() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let started = try syncedRecipe(try parameters(), in: store)
        var bumped = try parameters()
        bumped.doseDg = bumped.doseDg.map { dose in dose + 1 }
        let other = try syncedRecipe(bumped, in: store, serverID: RecipeTests.otherRecipeID)
        let flow = try flow(entry, .recipe(started.localID), store)
        XCTAssertFalse(flow.form.valuesAreAnotherRecipe, "the started recipe's own values")
        flow.form.increment(.dose)
        XCTAssertTrue(flow.form.valuesAreAnotherRecipe, "the form says the values are already a recipe")
        flow.form.keepsAsRecipe = true

        XCTAssertNotNil(flow.save())

        XCTAssertEqual(flow.form.savedRecipeID, other.localID)
        XCTAssertEqual(started.doseDg, try parameters().doseDg)
        XCTAssertEqual(try store.recipes().count, 2)
        XCTAssertEqual(try queue(store), ["create brew"])
    }

    func testARecipeThatBecameNewerBeforeTheSaveIsNotReplaced() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let recipe = try syncedRecipe(try parameters(), in: store)
        let flow = try flow(entry, .recipe(recipe.localID), store)
        XCTAssertTrue(flow.form.replacesStartedRecipe)
        // As if a pull had brought the recipe from a newer app meanwhile.
        recipe.vocabularyVersion = Vocabulary.version + 1
        try store.save()
        flow.form.increment(.dose)
        flow.form.keepsAsRecipe = true

        XCTAssertNotNil(flow.save())

        XCTAssertEqual(recipe.doseDg, try parameters().doseDg, "the newer recipe is left as it is")
        XCTAssertEqual(recipe.vocabularyVersion, Vocabulary.version + 1)
        let kept = try XCTUnwrap(try store.liveRecipe(localID: try XCTUnwrap(flow.form.savedRecipeID)))
        XCTAssertNotEqual(kept.localID, recipe.localID, "a new recipe is kept instead (ADR 0028)")
        XCTAssertEqual(try queue(store), ["create brew", "create recipe"])
    }

    func testARecipeWhoseCreateIsParkedMatchesNothing() throws {
        let store = try AccountStore.inMemory()
        let refused = try store.saveRecipe(try parameters())
        let operation = try XCTUnwrap(try store.outboxOperations(for: refused.localID).first)
        operation.parked = true
        operation.parkReason = .rejected
        try store.save()

        XCTAssertNil(try store.recipe(matching: try parameters()))
        let kept = try store.saveRecipe(try parameters())

        XCTAssertNotEqual(kept.localID, refused.localID, "the values are kept as a recipe that can reach the server")
        XCTAssertEqual(try store.recipe(matching: try parameters())?.localID, kept.localID)
    }

    // MARK: - The rating offer (ADR 0026, Addendum M2-T27)

    func testTheOfferFallsBackToTheSameBeanOnAnotherBag() throws {
        let store = try AccountStore.inMemory()
        let oldBag = try StoreFixtures.syncedShelfEntry(in: store)
        let earlier = try ratedBrew(on: oldBag, at: "2026-11-24T08:00:00.000Z", buyAgain: false, in: store)
        let newBag = try otherEntry(like: oldBag, in: store)
        let flow = try flow(newBag, .lastBrew, store)
        let brewID = try XCTUnwrap(flow.save())

        let model = RatingFormModel(brew: brewID, store: store, repeatedFrom: flow.form.copiedBrewID)

        XCTAssertTrue(model.offersLastRating)
        XCTAssertEqual(model.lastRatingSource, .sameBean)
        XCTAssertEqual(model.lastRating, earlier.rating)
        XCTAssertEqual(model.draft, RatingDraft(), "nothing is copied before the tap")
        model.useLastRating()
        XCTAssertTrue(model.canSave)
        XCTAssertTrue(model.save())
    }

    func testTheSameBagComesBeforeANewerRatingOfTheSameBean() throws {
        let store = try AccountStore.inMemory()
        let first = try StoreFixtures.syncedShelfEntry(in: store)
        let second = try otherEntry(like: first, in: store)
        let ownBag = try ratedBrew(on: second, at: "2026-11-20T08:00:00.000Z", buyAgain: false, in: store)
        try ratedBrew(on: first, at: "2026-11-25T08:00:00.000Z", buyAgain: true, in: store)
        let current = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-26T08:00:00.000Z", rated: false))
        try store.addBrew(current, shelfEntry: second)

        let model = RatingFormModel(brew: current.localID, store: store)

        XCTAssertEqual(model.lastRatingSource, .sameBag)
        XCTAssertEqual(model.lastRating, ownBag.rating)
        XCTAssertEqual(model.lastRating?.buyAgain, false)
    }

    func testARepeatOfAnotherBeansBrewOffersTheRepeatedBrewsRating() throws {
        let store = try AccountStore.inMemory()
        let usual = try otherBeanEntry(in: store)
        let repeated = try ratedBrew(on: usual, at: "2026-11-25T08:00:00.000Z", buyAgain: true, in: store)
        let newBean = try StoreFixtures.syncedShelfEntry(in: store)
        let flow = try flow(newBean, .lastBrew, store)
        XCTAssertEqual(flow.form.copiedBrewID, repeated.localID)
        let brewID = try XCTUnwrap(flow.save())

        let model = RatingFormModel(brew: brewID, store: store, repeatedFrom: flow.form.copiedBrewID)

        XCTAssertEqual(model.lastRatingSource, .repeatedBrew)
        XCTAssertEqual(model.lastRating, repeated.rating)
        model.useLastRating()
        XCTAssertTrue(model.save(), "the first repeat onto a new coffee is rated with one tap and Save")

        // Without the repeat, another bean's rating is not offered.
        let plain = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-26T09:00:00.000Z", rated: false))
        let plainBag = try otherEntry(like: newBean, in: store)
        try store.addBrew(plain, shelfEntry: plainBag)
        XCTAssertEqual(RatingFormModel(brew: plain.localID, store: store).lastRatingSource, .sameBean, "the new coffee's own rating now")
    }

    func testARecipeStartOffersNoRepeatedBrew() throws {
        let store = try AccountStore.inMemory()
        let usual = try otherBeanEntry(in: store)
        try ratedBrew(on: usual, at: "2026-11-25T08:00:00.000Z", buyAgain: true, in: store)
        let recipe = try syncedRecipe(try parameters(), in: store)
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let flow = try flow(entry, .recipe(recipe.localID), store)
        XCTAssertNil(flow.form.copiedBrewID)
        let brewID = try XCTUnwrap(flow.save())

        let model = RatingFormModel(brew: brewID, store: store, repeatedFrom: flow.form.copiedBrewID)

        XCTAssertNil(model.lastRating)
        XCTAssertNil(model.lastRatingSource)
        XCTAssertFalse(model.offersLastRating)
    }

    func testTheOfferNeverComesFromALaterBrew() throws {
        let store = try AccountStore.inMemory()
        let first = try StoreFixtures.syncedShelfEntry(in: store)
        let second = try otherEntry(like: first, in: store)
        let current = try StoredBrew(try StoreFixtures.brewInput(brewedAt: "2026-11-20T08:00:00.000Z", rated: false))
        try store.addBrew(current, shelfEntry: second)
        // Later ratings: of the same bag, of the same bean, and of another bean's brew named
        // as the repeated one.
        try ratedBrew(on: second, at: "2026-11-21T08:00:00.000Z", buyAgain: true, in: store)
        try ratedBrew(on: first, at: "2026-11-22T08:00:00.000Z", buyAgain: true, in: store)
        let laterOther = try ratedBrew(on: try otherBeanEntry(in: store), at: "2026-11-23T08:00:00.000Z", buyAgain: true, in: store)

        let model = RatingFormModel(brew: current.localID, store: store, repeatedFrom: laterOther.localID)

        XCTAssertNil(model.lastRating)
        XCTAssertNil(model.lastRatingSource)
        XCTAssertFalse(model.offersLastRating)
    }
}
