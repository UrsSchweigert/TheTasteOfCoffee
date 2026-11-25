import Foundation
import SwiftData

/// The local store of one account: a `ModelContainer` on that account's file, and the
/// writes and reads the app makes on it.
///
/// Every write saves at once (autosave is off), so a write that returned is on disk.
/// The outbox (M2-T16) adds its operation in the same save. Use one `AccountStore` from one
/// actor at a time; `ModelContext` is not `Sendable`.
final class AccountStore {
    let container: ModelContainer
    let context: ModelContext

    init(container: ModelContainer) {
        self.container = container
        self.context = ModelContext(container)
        self.context.autosaveEnabled = false
    }

    // MARK: - Containers

    /// The schema of the current version.
    static var schema: Schema { Schema(versionedSchema: CupmarkSchemaV1.self) }

    /// The store of `account`: its own file in `directory` (`StoreLocation`). No other
    /// account's file is ever opened. CloudKit is off: data leaves the device only through
    /// our API (invariant 6).
    static func open(for account: some StoreAccount, in directory: URL = StoreLocation.defaultDirectory) throws -> AccountStore {
        let url = try StoreLocation.fileURL(for: account, in: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let configuration = ModelConfiguration(
            try StoreLocation.fileStem(for: account),
            schema: schema,
            url: url,
            allowsSave: true,
            cloudKitDatabase: .none
        )
        let container = try ModelContainer(for: schema, migrationPlan: CupmarkMigrationPlan.self, configurations: configuration)
        return AccountStore(container: container)
    }

    /// A store that lives in memory only, for tests and previews. Each call is a new, empty
    /// store.
    static func inMemory() throws -> AccountStore {
        let configuration = ModelConfiguration(
            UUID().uuidString,
            schema: schema,
            isStoredInMemoryOnly: true,
            allowsSave: true,
            groupContainer: .none,
            cloudKitDatabase: .none
        )
        let container = try ModelContainer(for: schema, migrationPlan: CupmarkMigrationPlan.self, configurations: configuration)
        return AccountStore(container: container)
    }

    // MARK: - Writes

    /// Adds a bean. `syncState` is `pendingCreate` for a bean made on the device and
    /// `synced` for one read from the server.
    func addBean(_ bean: StoredBean, syncState: SyncState = .pendingCreate) throws {
        bean.syncState = syncState
        context.insert(bean)
        try save()
    }

    /// Adds a shelf entry for `bean`, which must be in this store.
    func addShelfEntry(_ entry: StoredShelfEntry, bean: StoredBean, syncState: SyncState = .pendingCreate) throws {
        entry.syncState = syncState
        // Insert first, then link: both ends are then in the same context.
        context.insert(entry)
        entry.bean = bean
        try save()
    }

    /// Adds a brew on `shelfEntry`, which must be in this store.
    func addBrew(_ brew: StoredBrew, shelfEntry: StoredShelfEntry, syncState: SyncState = .pendingCreate) throws {
        brew.syncState = syncState
        context.insert(brew)
        brew.shelfEntry = shelfEntry
        try save()
    }

    func addRecipe(_ recipe: StoredRecipe, syncState: SyncState = .pendingCreate) throws {
        recipe.syncState = syncState
        context.insert(recipe)
        try save()
    }

    /// Sets the profile, the one per store. A new profile is `pendingCreate`; an edit of a
    /// profile the server has is `pendingUpdate`.
    @discardableResult
    func setProfile(_ values: API.Profile) throws -> StoredProfile {
        if let existing = try profile() {
            existing.apply(values)
            existing.syncState = existing.syncState.afterLocalEdit
            try save()
            return existing
        }
        let created = StoredProfile(values)
        created.syncState = .pendingCreate
        context.insert(created)
        try save()
        return created
    }

    /// Records a local edit of `item`, made by the caller before this call.
    func markUpdated<Model: PersistentModel & SyncTracked>(_ item: Model) throws {
        item.syncState = item.syncState.afterLocalEdit
        try save()
    }

    /// Removes `item` on the device. Only `LocalDeletable` models can be removed: the profile
    /// cannot (the API has no delete for it; account deletion is M2-T30's own flow).
    /// - Brew, shelf entry, recipe: an item the server never had is deleted at once; any
    ///   other is kept as `pendingDelete` and hidden until the server has removed it.
    /// - A shelf entry with brews that are not removed throws `shelfEntryHasBrews` (ADR 0012).
    /// - A bean is only a local copy (the API has no bean delete), so it is deleted at once,
    ///   but never while any shelf entry still names it: `beanHasShelfEntries`.
    func markDeleted<Model: PersistentModel & LocalDeletable>(_ item: Model) throws {
        if let entry = item as? StoredShelfEntry, !entry.liveBrewsNewestFirst.isEmpty {
            throw LocalStoreError.shelfEntryHasBrews
        }
        if let bean = item as? StoredBean {
            guard bean.shelfEntries.isEmpty else {
                throw LocalStoreError.beanHasShelfEntries
            }
            context.delete(bean)
            try save()
            return
        }
        switch item.syncState.localDelete {
        case .removeNow:
            context.delete(item)
        case .markPendingDelete:
            item.syncState = .pendingDelete
        }
        try save()
    }

    /// Saves the context; on failure, the unsaved changes are rolled back and the error thrown.
    func save() throws {
        do {
            try context.save()
        } catch {
            context.rollback()
            throw error
        }
    }

    // MARK: - Reads (items removed on the device are left out)

    /// Every brew, newest `brewed_at` first.
    func brewsNewestFirst() throws -> [StoredBrew] {
        let removed = SyncState.pendingDelete.rawValue
        let descriptor = FetchDescriptor<StoredBrew>(
            predicate: #Predicate<StoredBrew> { brew in brew.syncStateRaw != removed },
            sortBy: [SortDescriptor(\StoredBrew.brewedAtMilliseconds, order: .reverse)]
        )
        return try context.fetch(descriptor)
    }

    /// Every shelf entry, latest purchase first, then latest made on the device.
    func shelfEntries() throws -> [StoredShelfEntry] {
        let removed = SyncState.pendingDelete.rawValue
        let descriptor = FetchDescriptor<StoredShelfEntry>(
            predicate: #Predicate<StoredShelfEntry> { entry in entry.syncStateRaw != removed },
            sortBy: [
                SortDescriptor(\StoredShelfEntry.purchaseDateRaw, order: .reverse),
                SortDescriptor(\StoredShelfEntry.createdAt, order: .reverse),
            ]
        )
        return try context.fetch(descriptor)
    }

    /// Every recipe, newest first.
    func recipes() throws -> [StoredRecipe] {
        let removed = SyncState.pendingDelete.rawValue
        let descriptor = FetchDescriptor<StoredRecipe>(
            predicate: #Predicate<StoredRecipe> { recipe in recipe.syncStateRaw != removed },
            sortBy: [SortDescriptor(\StoredRecipe.createdAt, order: .reverse)]
        )
        return try context.fetch(descriptor)
    }

    /// The cached bean with this 13-digit barcode, if any.
    func bean(barcode: String) throws -> StoredBean? {
        let code: String? = barcode
        var descriptor = FetchDescriptor<StoredBean>(
            predicate: #Predicate<StoredBean> { bean in bean.barcode == code }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The cached bean with this server id, if any.
    func bean(serverID: String) throws -> StoredBean? {
        let id: String? = serverID
        var descriptor = FetchDescriptor<StoredBean>(
            predicate: #Predicate<StoredBean> { bean in bean.serverID == id }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The profile, nil before it was set.
    func profile() throws -> StoredProfile? {
        var descriptor = FetchDescriptor<StoredProfile>()
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }
}
