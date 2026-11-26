import Foundation
import SwiftData

// Recipes and the brew a repeat copies (M2-T27, docs/04 F2: "A brew can be saved as a recipe
// and repeated with one tap"). A recipe is a saved set of brew parameters (`RecipeInput`) and
// has no name (invariant 1): it is shown by its method, dose, ratio, temperature and grind.
//
// Like every `AccountStore` write, each one changes the recipe and queues its operation in one
// save, inside `write { }`, so a failure leaves nothing behind (ADR 0025, Addendum M2-T35).
// The engine sends `POST /recipes`, `PUT` and `DELETE /recipes/{recipe_id}`.

/// What a replacement did (`AccountStore.replaceRecipe`).
enum RecipeReplacement: Equatable, Sendable {
    /// The recipe already had these parameters; nothing was written.
    case unchanged
    /// The recipe took the parameters and its update was queued.
    case replaced
    /// Another recipe (this local id) already has these parameters. The replacement was
    /// refused and nothing was written, so the device never holds two equal recipes (ADR 0028).
    case alreadyRecipe(UUID)
}

/// Why a recipe could not be replaced.
enum RecipeWriteError: Error, Equatable {
    /// The recipe is gone (removed here, or on another device and pulled).
    case notFound
    /// The recipe was stored with a newer vocabulary than this build bundles: a replacement
    /// could drop values this build does not know.
    case newerVocabulary
}

extension StoredRecipe {
    /// Whether this build may replace the recipe: it was not stored with a newer vocabulary.
    var isReplaceable: Bool {
        vocabularyVersion <= Vocabulary.version
    }
}

extension AccountStore {
    // MARK: - Reads

    /// The newest brew on the device that is not removed, of any shelf entry.
    func latestBrew() throws -> StoredBrew? {
        let removed = SyncState.pendingDelete.rawValue
        var descriptor = FetchDescriptor<StoredBrew>(
            predicate: #Predicate<StoredBrew> { brew in brew.syncStateRaw != removed },
            sortBy: [SortDescriptor(\StoredBrew.brewedAtMilliseconds, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The brew "Repeat Last Brew" copies for a new brew on `entry`: the entry's newest brew,
    /// or else the newest brew on the device, of any bag (a new bag of the usual coffee).
    /// Nil when the device has no brew.
    func lastBrewToRepeat(for entry: StoredShelfEntry) throws -> StoredBrew? {
        if let own = entry.liveBrewsNewestFirst.first {
            return own
        }
        return try latestBrew()
    }

    /// The recipe with this local id, nil when it is gone or removed on the device.
    func liveRecipe(localID: UUID) throws -> StoredRecipe? {
        guard let recipe = try recipe(localID: localID), recipe.syncState != .pendingDelete else {
            return nil
        }
        return recipe
    }

    /// The recipe on the device with exactly these parameters, if any. A recipe with an id the
    /// bundled vocabulary does not know matches nothing, and neither does one whose create is
    /// parked: it never reaches the server (until the user redoes it from the sync issues), so
    /// the same values are kept as a recipe that can.
    func recipe(matching parameters: API.BrewParameters) throws -> StoredRecipe? {
        let parkedCreates = Set(try outboxOperations()
            .filter { operation in operation.parked && operation.action == .create && operation.resource == .recipe }
            .map(\.localID))
        return try recipes().first { recipe in
            !parkedCreates.contains(recipe.localID) && (try? recipe.apiParameters()) == parameters
        }
    }

    // MARK: - Writes

    /// Keeps `parameters` as a recipe and queues `POST /recipes`, in one save. A recipe with
    /// the same parameters already on the device is returned instead, and nothing is written,
    /// so saving the same brew twice keeps one recipe.
    @discardableResult
    func saveRecipe(_ parameters: API.BrewParameters, createdAt: Date = Date.now) throws -> StoredRecipe {
        // A recipe is stored at the bundled version, so it never keeps a field its method does
        // not allow (a brew of vocabulary 1 or 2 may have one, and so may a brew saved at
        // version 3 before the form applied the rules), which the server would refuse.
        let parameters = parameters.conformingToMethodRules()
        if let existing = try recipe(matching: parameters) {
            return existing
        }
        return try write {
            let recipe = try stageNewRecipe(parameters, createdAt: createdAt)
            try save()
            return recipe
        }
    }

    /// Replaces every parameter of `recipe` with `parameters` (`PUT /recipes/{recipe_id}`
    /// replaces the whole item), at the bundled vocabulary version, and queues the update in
    /// one save; a create or update that was not sent yet carries it instead. Writes nothing
    /// and says so when the parameters are already the recipe's (`unchanged`) or another
    /// recipe's (`alreadyRecipe`). Throws `RecipeWriteError` for a removed recipe and one
    /// stored with a newer vocabulary.
    @discardableResult
    func replaceRecipe(_ recipe: StoredRecipe, with parameters: API.BrewParameters) throws -> RecipeReplacement {
        try write {
            let result = try stageRecipeReplacement(recipe, with: parameters)
            if result == .replaced {
                try save()
            }
            return result
        }
    }

    /// Removes the recipe on the device and queues `DELETE /recipes/{recipe_id}` if the server
    /// may have it (`markDeleted`).
    func deleteRecipe(_ recipe: StoredRecipe) throws {
        try markDeleted(recipe)
    }

    // MARK: - Staged writes (no save; the caller saves, inside `write { }`)

    /// Inserts a recipe with `parameters` and queues its create, without saving, so the brew
    /// form saves it in the same save as the brew. Returns the recipe with the same parameters
    /// instead, if the device has one, and stages nothing.
    func stageNewRecipe(_ parameters: API.BrewParameters, createdAt: Date = Date.now) throws -> StoredRecipe {
        let parameters = parameters.conformingToMethodRules()
        if let existing = try recipe(matching: parameters) {
            return existing
        }
        let recipe = StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters))
        recipe.createdAt = createdAt
        recipe.syncState = .pendingCreate
        context.insert(recipe)
        try enqueue(.create, .recipe, localID: recipe.localID)
        return recipe
    }

    /// Changes `recipe` to `parameters` and queues the update, without saving. Changes nothing
    /// when the parameters are already the recipe's or another recipe's.
    func stageRecipeReplacement(_ recipe: StoredRecipe, with parameters: API.BrewParameters) throws -> RecipeReplacement {
        let parameters = parameters.conformingToMethodRules()
        guard recipe.syncState != .pendingDelete else {
            throw RecipeWriteError.notFound
        }
        guard recipe.isReplaceable else {
            throw RecipeWriteError.newerVocabulary
        }
        if (try? recipe.apiParameters()) == parameters {
            return .unchanged
        }
        if let other = try self.recipe(matching: parameters), other.localID != recipe.localID {
            return .alreadyRecipe(other.localID)
        }
        recipe.setParameters(parameters)
        recipe.vocabularyVersion = Vocabulary.version
        recipe.syncState = recipe.syncState.afterLocalEdit
        try enqueueEdit(of: recipe)
        return .replaced
    }
}
