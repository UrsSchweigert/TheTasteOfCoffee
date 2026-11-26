import XCTest
@testable import Cupmark

/// Copying a reference recipe into the user's own recipes (M2-T47, ADR 0034, ADR 0028): it goes
/// through the existing save path, so it is an ordinary recipe with no name that is queued in the
/// outbox like any other, one tap from a brew; a second copy, and a copy of numbers the user
/// already has, add nothing. Dates are fixed.
@MainActor
final class StartingPointModelTests: XCTestCase {
    private func now() throws -> Date {
        try StoreFixtures.timestamp("2026-11-26T07:15:00.250Z").date
    }

    private func set() throws -> ReferenceRecipeSet {
        let url = try XCTUnwrap(Bundle(for: AppBundleToken.self).url(forResource: ReferenceRecipeSet.resourceName, withExtension: "json"))
        return try ReferenceRecipeSet.decode(try Data(contentsOf: url))
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    func testCopyingAddsOneOrdinaryRecipeThatIsQueuedForSync() throws {
        let store = try AccountStore.inMemory()
        let reference = try XCTUnwrap(try set().recipes.first)
        let fixed = try now()
        let model = StartingPointModel(recipe: reference, store: store, now: { fixed })
        model.reload()
        XCTAssertFalse(model.isKept)

        XCTAssertTrue(model.copy())

        XCTAssertTrue(model.isKept)
        XCTAssertTrue(model.justCopied)
        XCTAssertFalse(model.copyFailed)
        let recipes = try store.recipes()
        XCTAssertEqual(recipes.count, 1)
        let stored = try XCTUnwrap(recipes.first)
        XCTAssertEqual(try stored.apiParameters(), reference.parameters, "the numbers, as they are")
        XCTAssertEqual(stored.createdAt, fixed)
        XCTAssertEqual(stored.syncState, .pendingCreate)
        XCTAssertEqual(stored.vocabularyVersion, Vocabulary.version)
        XCTAssertEqual(try queue(store), ["create recipe"], "it syncs like any recipe")

        // A recipe has no name; it is listed like every other, and a tap starts a brew from it.
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let repeats = BrewStartModel(shelfEntry: entry.localID, store: store, startingPoints: .empty)
        repeats.reload()
        XCTAssertEqual(repeats.recipes.map(\.id), [stored.localID])
        XCTAssertEqual(repeats.recipes.first?.summary, reference.summary)
        XCTAssertEqual(repeats.route(.recipe(stored.localID)), BrewRoute(shelfEntryLocalID: entry.localID, start: .recipe(stored.localID)))
    }

    func testCopyingTwiceKeepsOneRecipeAndOneQueuedCreate() throws {
        let store = try AccountStore.inMemory()
        let reference = try XCTUnwrap(try set().recipes.first)
        let model = StartingPointModel(recipe: reference, store: store)

        XCTAssertTrue(model.copy())
        XCTAssertFalse(model.copy(), "the second copy adds nothing")

        XCTAssertTrue(model.isKept)
        XCTAssertFalse(model.justCopied, "it was already there")
        XCTAssertEqual(try store.recipes().count, 1)
        XCTAssertEqual(try queue(store), ["create recipe"])
    }

    func testAScreenOpenedAgainKnowsTheRecipeIsAlreadyTheUsers() throws {
        let store = try AccountStore.inMemory()
        let reference = try XCTUnwrap(try set().recipes.first)
        XCTAssertTrue(StartingPointModel(recipe: reference, store: store).copy())

        let reopened = StartingPointModel(recipe: reference, store: store)
        XCTAssertFalse(reopened.isKept, "before it reads the store")
        reopened.reload()

        XCTAssertTrue(reopened.isKept)
        XCTAssertFalse(reopened.justCopied)
        XCTAssertFalse(reopened.copy())
        XCTAssertEqual(try store.recipes().count, 1)
    }

    func testARecipeTheUserAlreadyHasIsNotCopiedAgain() throws {
        let store = try AccountStore.inMemory()
        let reference = try XCTUnwrap(try set().recipes.first)
        // The same numbers, kept from a brew of the user's own (the same save path).
        let own = try store.saveRecipe(reference.parameters)
        let model = StartingPointModel(recipe: reference, store: store)
        model.reload()
        XCTAssertTrue(model.isKept)

        XCTAssertFalse(model.copy())

        XCTAssertEqual(try store.recipes().map(\.localID), [own.localID])
        XCTAssertEqual(try queue(store), ["create recipe"])
    }

    func testDifferentNumbersAreAnotherRecipe() throws {
        let store = try AccountStore.inMemory()
        let recipes = try set().recipes
        let first = try XCTUnwrap(recipes.first)
        let other = try XCTUnwrap(recipes.first { $0.parameters != first.parameters })

        XCTAssertTrue(StartingPointModel(recipe: first, store: store).copy())
        let model = StartingPointModel(recipe: other, store: store)
        model.reload()
        XCTAssertFalse(model.isKept, "only the same numbers count")
        XCTAssertTrue(model.copy())

        XCTAssertEqual(try store.recipes().count, 2)
    }

    func testRemovingTheCopyOffersTheCopyAgain() throws {
        let store = try AccountStore.inMemory()
        let reference = try XCTUnwrap(try set().recipes.first)
        let model = StartingPointModel(recipe: reference, store: store)
        XCTAssertTrue(model.copy())

        try store.deleteRecipe(try XCTUnwrap(try store.recipes().first))
        model.reload()

        XCTAssertFalse(model.isKept)
        XCTAssertFalse(model.justCopied)
        XCTAssertTrue(model.copy())
        XCTAssertEqual(try store.recipes().count, 1)
    }

    func testTheStartingPointsAreOfferedFromTheRecipeListOnlyWhenThereAreAny() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let none = BrewStartModel(shelfEntry: entry.localID, store: store, startingPoints: .empty)
        none.reload()
        XCTAssertFalse(none.offersRecipeList, "no recipe, no starting point: no list")

        let some = BrewStartModel(shelfEntry: entry.localID, store: store, startingPoints: try set())
        some.reload()
        XCTAssertTrue(some.offersRecipeList, "a new user reaches the starting points")
        XCTAssertTrue(some.recipes.isEmpty, "a starting point is never counted as the user's recipe")
        XCTAssertNil(some.lastBrew)
    }

    func testAStartingPointNeverReachesTheStoreUntilCopied() throws {
        let store = try AccountStore.inMemory()
        _ = StartingPointModel(recipe: try XCTUnwrap(try set().recipes.first), store: store)
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = BrewStartModel(shelfEntry: entry.localID, store: store, startingPoints: try set())
        model.reload()

        XCTAssertTrue(try store.recipes().isEmpty)
        XCTAssertTrue(try queue(store).isEmpty, "browsing writes nothing")
    }
}
