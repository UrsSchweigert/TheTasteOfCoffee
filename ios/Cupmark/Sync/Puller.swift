import Foundation
import SwiftData

/// What one pull did (M2-T17). Holds counts only, never a value or an id.
struct PullReport: Equatable, Sendable {
    /// Server items with no local item, now stored (shelf entries, brews, recipes, the profile).
    var inserted = 0
    /// Synced local items that took the server's values.
    var updated = 0
    /// Synced local items the server no longer has (deleted on another device).
    var removed = 0
    /// Items with a pending or parked operation that kept their local values.
    var keptPending = 0
    /// `GET /beans/{bean_id}` answers that were stored.
    var beansFetched = 0
    /// List items that did not decode, for example with an id from a newer vocabulary.
    var undecodableItems = 0
    /// Items that decoded but name a bean or shelf entry the device could not get, so they
    /// were not stored.
    var unresolvedItems = 0
    /// False when `GET /profile` answered 404: there is no profile yet.
    var profileFound = false

    /// Everything the pull left out. A later screen shows a note when this is above 0.
    var skippedItems: Int { undecodableItems + unresolvedItems }
}

/// Fetches the account's data from the server and merges it into the local store (M2-T17),
/// so a new device ends with a full copy and an edit or delete made on another device shows
/// here.
///
/// - It fetches, to the last page, `GET /shelf`, `/brews` and `/recipes`, then `GET /profile`,
///   then `GET /beans/{bean_id}` for every shelf bean that is not cached and for every cached
///   one that is not verified yet.
/// - Nothing is written until every request has answered; then the merge runs in one go on
///   the main actor and saves once. A failed request writes nothing.
/// - The merge, per item:
///   - a server item with no local item is inserted as synced;
///   - a synced local item the server no longer has is removed. Not when the list had an item
///     that did not decode (it may be that one), and not a shelf entry that still has brews on
///     the device;
///   - an item with any operation in the outbox (pending or parked), or not synced, keeps its
///     local values until the operation is answered;
///   - any other local item takes the server's values.
/// - A list item that does not decode is skipped and counted, never fatal. So is an item
///   whose bean or shelf entry the device cannot get.
/// - `GET /profile` 404 means no profile yet: none is created.
///
/// It runs on the main actor with the app's `AccountStore`, like `SyncEngine`, and only
/// inside the engine's slot (`SyncHost`), so a pull never runs while the outbox drains.
@MainActor
final class Puller {
    enum Result: Equatable, Sendable {
        case completed(PullReport)
        /// The server refused the token, also after a refresh.
        case signInRequired
        /// A request failed; nothing was written. The next pull tries again.
        case failed(APIError)
        /// The store could not be read or saved; nothing was written.
        case storeFailed
        /// The task was cancelled or another account is signed in now; nothing was written.
        case cancelled
    }

    let store: AccountStore
    private let client: APIClient
    /// Asked before every request and before the merge; false ends the pull unwritten.
    private let isCurrentAccount: @Sendable () async -> Bool

    init(store: AccountStore, client: APIClient, isCurrentAccount: @escaping @Sendable () async -> Bool = { true }) {
        self.store = store
        self.client = client
        self.isCurrentAccount = isCurrentAccount
    }

    /// One full pull and merge.
    func pull() async -> Result {
        let fetched: Fetched
        do {
            fetched = try await fetch()
        } catch let stop as Stop {
            switch stop {
            case .cancelled:
                return .cancelled
            case .store:
                return .storeFailed
            case .failed(.unauthorized):
                return .signInRequired
            case .failed(let error):
                return .failed(error)
            }
        } catch {
            return .cancelled
        }
        guard !Task.isCancelled, await isCurrentAccount() else {
            return .cancelled
        }
        do {
            // A failed merge is undone, the server values it set on synced items too
            // (`AccountStore.write`). That discards only the merge's own unsaved changes:
            // screens never leave a model changed and unsaved, they write drafts through
            // `AccountStore`, which saves at once (ADR 0025). So nothing of the user's is lost.
            return .completed(try store.write { try merge(fetched) })
        } catch {
            return .storeFailed
        }
    }

    // MARK: - Fetch

    private enum Stop: Error {
        case cancelled
        case store
        case failed(APIError)
    }

    private struct Fetched {
        var shelf: AllPages<API.ShelfEntry>
        var brews: AllPages<API.Brew>
        var recipes: AllPages<API.Recipe>
        var profile: API.Profile?
        /// False when `GET /profile` answered 404.
        var profileFound: Bool
        /// The beans `GET /beans/{bean_id}` returned, by bean id.
        var beans: [String: API.Bean]
        /// Single answers (a bean, the profile) that did not decode and were skipped.
        var undecodableItems: Int
    }

    private func fetch() async throws -> Fetched {
        let shelf = try await call { try await self.client.allShelfEntries() }
        let brews = try await call { try await self.client.allBrews() }
        let recipes = try await call { try await self.client.allRecipes() }

        var undecodable = 0
        var profile: API.Profile?
        var profileFound = true
        do {
            profile = try await call { try await self.client.getProfile() }
        } catch Stop.failed(.notFound) {
            // No profile yet (onboarding, M2-T29). Nothing is created.
            profile = nil
            profileFound = false
        } catch Stop.failed(.undecodable) {
            // There is one, but this build cannot read it (for example a newer vocabulary):
            // skipped and counted, the local profile stays as it is.
            profile = nil
            undecodable += 1
        }

        var beans: [String: API.Bean] = [:]
        for beanID in try beansToFetch(shelf: shelf.items) {
            guard let resource = ResourceID(beanID) else {
                // Not a contract id: nothing to ask for. Its entries stay unresolved.
                continue
            }
            do {
                let bean = try await call { try await self.client.getBean(resource) }
                beans[bean.beanId] = bean
            } catch Stop.failed(.notFound) {
                // Gone or not visible to this account: a cached copy stays as it is, an entry
                // without one is not stored.
                continue
            } catch Stop.failed(.undecodable) {
                // This build cannot read it (for example an id from a newer vocabulary): the
                // same as a 404, and counted. Never fails the pull.
                undecodable += 1
                continue
            }
        }
        return Fetched(
            shelf: shelf,
            brews: brews,
            recipes: recipes,
            profile: profile,
            profileFound: profileFound,
            beans: beans,
            undecodableItems: undecodable
        )
    }

    /// The beans of the server's and the device's shelf entries that are not cached, or are
    /// cached and not verified yet, in a fixed order.
    private func beansToFetch(shelf: [API.ShelfEntry]) throws -> [String] {
        let localBeans: [StoredBean]
        let localEntries: [StoredShelfEntry]
        do {
            localBeans = try store.context.fetch(FetchDescriptor<StoredBean>())
            localEntries = try store.context.fetch(FetchDescriptor<StoredShelfEntry>())
        } catch {
            throw Stop.store
        }
        var verified: [String: Bool] = [:]
        for bean in localBeans {
            if let id = bean.serverID {
                verified[id] = (verified[id] ?? false) || bean.verified
            }
        }
        var shelfBeans = Set(shelf.map { entry in entry.values.beanId })
        for entry in localEntries {
            if let id = entry.bean?.serverID {
                shelfBeans.insert(id)
            }
        }
        return shelfBeans
            .filter { id in verified[id] != true }
            .sorted()
    }

    /// Runs one request after checking that the pull's account is still signed in.
    /// `APIClient` throws only `APIError` and `CancellationError`.
    private func call<Value>(_ request: () async throws -> Value) async throws -> Value {
        guard !Task.isCancelled, await isCurrentAccount() else {
            throw Stop.cancelled
        }
        do {
            return try await request()
        } catch let error as APIError {
            throw Stop.failed(error)
        } catch {
            if error is CancellationError || Task.isCancelled {
                throw Stop.cancelled
            }
            throw Stop.failed(.invalidResponse)
        }
    }

    // MARK: - Merge

    /// Writes the fetched state into the store and saves once. Runs without a suspension, so
    /// no local write can land between reading the store and saving it.
    private func merge(_ fetched: Fetched) throws -> PullReport {
        let context = store.context
        var report = PullReport()
        report.undecodableItems = fetched.shelf.undecodableItems.count
            + fetched.brews.undecodableItems.count
            + fetched.recipes.undecodableItems.count
            + fetched.undecodableItems

        // Every item with an operation in the outbox, parked ones included: those keep their
        // local values until the operation is answered (or the user discards it, M2-T18).
        let queued = Set(try store.outboxOperations().map { operation in operation.localID })
        func isPending<Item: SyncTracked>(_ item: Item) -> Bool {
            item.syncState != .synced || queued.contains(item.localID)
        }

        // Beans: a cache of the catalogue, never removed here.
        var beans: [String: StoredBean] = [:]
        for bean in try context.fetch(FetchDescriptor<StoredBean>()) {
            if let id = bean.serverID, beans[id] == nil {
                beans[id] = bean
            }
        }
        for (beanID, server) in fetched.beans.sorted(by: { lhs, rhs in lhs.key < rhs.key }) {
            if let local = beans[beanID] {
                if !isPending(local), (try? local.apiBean()) != server {
                    local.apply(server)
                }
            } else {
                let copy = StoredBean(server)
                copy.syncState = .synced
                context.insert(copy)
                beans[beanID] = copy
            }
            report.beansFetched += 1
        }

        // Shelf entries.
        let localEntries = try context.fetch(FetchDescriptor<StoredShelfEntry>())
        var entries: [String: StoredShelfEntry] = [:]
        for entry in localEntries {
            if let id = entry.serverID, entries[id] == nil {
                entries[id] = entry
            }
        }
        var serverEntryIDs = Set<String>()
        for server in fetched.shelf.items {
            serverEntryIDs.insert(server.shelfEntryId)
            let bean = beans[server.values.beanId]
            if let local = entries[server.shelfEntryId] {
                if isPending(local) {
                    report.keptPending += 1
                    continue
                }
                guard let bean else {
                    report.unresolvedItems += 1
                    continue
                }
                if (try? local.apiInput()) != server.values {
                    local.apply(server.values)
                    local.bean = bean
                    report.updated += 1
                }
            } else {
                guard let bean else {
                    report.unresolvedItems += 1
                    continue
                }
                let entry = StoredShelfEntry(server.values, serverID: server.shelfEntryId)
                entry.syncState = .synced
                context.insert(entry)
                entry.bean = bean
                entries[server.shelfEntryId] = entry
                report.inserted += 1
            }
        }

        // Brews.
        let localBrews = try context.fetch(FetchDescriptor<StoredBrew>())
        var brews: [String: StoredBrew] = [:]
        for brew in localBrews {
            if let id = brew.serverID, brews[id] == nil {
                brews[id] = brew
            }
        }
        var serverBrewIDs = Set<String>()
        for server in fetched.brews.items {
            serverBrewIDs.insert(server.brewId)
            let entry = entries[server.values.shelfEntryId]
            if let local = brews[server.brewId] {
                if isPending(local) {
                    report.keptPending += 1
                    continue
                }
                guard let entry else {
                    report.unresolvedItems += 1
                    continue
                }
                if !Puller.sameValues(try? local.apiInput(), server.values) {
                    do {
                        // Throws before it changes anything.
                        try local.apply(server.values)
                    } catch {
                        report.unresolvedItems += 1
                        continue
                    }
                    local.shelfEntry = entry
                    report.updated += 1
                }
            } else {
                guard let entry, let brew = try? StoredBrew(server.values, serverID: server.brewId) else {
                    report.unresolvedItems += 1
                    continue
                }
                brew.syncState = .synced
                context.insert(brew)
                brew.shelfEntry = entry
                brews[server.brewId] = brew
                report.inserted += 1
            }
        }
        var removedBrews = Set<UUID>()
        if fetched.brews.undecodableItems.isEmpty {
            for local in localBrews where isGone(local, from: serverBrewIDs) && !isPending(local) {
                removedBrews.insert(local.localID)
                // With its photos (M2-T42); their files go after the save.
                try store.deleteFromDevice(local)
                report.removed += 1
            }
        }

        // A shelf entry goes only once no brew on the device names it any more, so a brew
        // that is still waiting to be sent is never left without its entry.
        if fetched.shelf.undecodableItems.isEmpty {
            var entriesWithBrews = Set<UUID>()
            for brew in brews.values where !removedBrews.contains(brew.localID) {
                if let entryID = brew.shelfEntry?.localID {
                    entriesWithBrews.insert(entryID)
                }
            }
            for brew in localBrews where brew.serverID == nil && !removedBrews.contains(brew.localID) {
                if let entryID = brew.shelfEntry?.localID {
                    entriesWithBrews.insert(entryID)
                }
            }
            for local in localEntries where isGone(local, from: serverEntryIDs) && !isPending(local) {
                if entriesWithBrews.contains(local.localID) {
                    continue
                }
                context.delete(local)
                report.removed += 1
            }
        }

        // Recipes.
        let localRecipes = try context.fetch(FetchDescriptor<StoredRecipe>())
        var recipes: [String: StoredRecipe] = [:]
        for recipe in localRecipes {
            if let id = recipe.serverID, recipes[id] == nil {
                recipes[id] = recipe
            }
        }
        var serverRecipeIDs = Set<String>()
        for server in fetched.recipes.items {
            serverRecipeIDs.insert(server.recipeId)
            if let local = recipes[server.recipeId] {
                if isPending(local) {
                    report.keptPending += 1
                    continue
                }
                if (try? local.apiInput()) != server.values {
                    local.apply(server.values)
                    report.updated += 1
                }
            } else {
                let recipe = StoredRecipe(server.values, serverID: server.recipeId)
                recipe.syncState = .synced
                context.insert(recipe)
                recipes[server.recipeId] = recipe
                report.inserted += 1
            }
        }
        if fetched.recipes.undecodableItems.isEmpty {
            for local in localRecipes where isGone(local, from: serverRecipeIDs) && !isPending(local) {
                context.delete(local)
                report.removed += 1
            }
        }

        // Profile: 404 created nothing; an undecodable one was counted. In both cases a local
        // profile stays as it is.
        report.profileFound = fetched.profileFound
        if let server = fetched.profile {
            if let local = try store.profile() {
                if isPending(local) {
                    report.keptPending += 1
                } else if (try? local.apiProfile()) != server {
                    local.apply(server)
                    report.updated += 1
                }
            } else {
                let profile = StoredProfile(server)
                profile.syncState = .synced
                context.insert(profile)
                report.inserted += 1
            }
        }

        if context.hasChanges {
            try store.save()
        }
        return report
    }

    /// Whether a local brew already has the server's values. The order of `flavour_notes`
    /// (the only id list in a brew) does not count, so a server that lists them in another
    /// order causes no rewrite.
    static func sameValues(_ local: API.BrewInput?, _ server: API.BrewInput) -> Bool {
        guard let local else {
            return false
        }
        return unordered(local) == unordered(server)
    }

    /// `input` with its flavour notes in a fixed order.
    private static func unordered(_ input: API.BrewInput) -> API.BrewInput {
        var copy = input
        if let notes = copy.rating?.flavourNotes {
            copy.rating?.flavourNotes = notes.sorted { lhs, rhs in lhs.rawValue < rhs.rawValue }
        }
        return copy
    }

    /// True for a local item the server had (it has a server id) and no longer lists.
    private func isGone<Item: ServerIdentified>(_ item: Item, from serverIDs: Set<String>) -> Bool {
        guard let id = item.serverID else {
            return false
        }
        return !serverIDs.contains(id)
    }
}
