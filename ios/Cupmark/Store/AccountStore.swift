import Foundation
import SwiftData

/// The local store of one account: a `ModelContainer` on that account's file, and the
/// writes and reads the app makes on it.
///
/// Every write saves at once (autosave is off), so a write that returned is on disk.
/// The outbox (M2-T16, `Store/Outbox.swift`) adds its operation in the same save. Use one
/// `AccountStore` from one actor at a time, the main actor in the app; `ModelContext` is not
/// `Sendable`. `SyncEngine` uses the same store, so screens and sync see one context.
/// Screens must therefore edit drafts (plain values) and write them through these methods,
/// never change a model in place and leave it unsaved: the engine's `save()` saves the
/// shared context, and would send a half-made change with it.
final class AccountStore {
    let container: ModelContainer
    let context: ModelContext
    /// Called after every successful save. `SyncHost` uses it to wake the sync engine.
    var onSave: (@Sendable () -> Void)?
    /// Called before every save, with the changes still unsaved; a throw fails the save as a
    /// failed `ModelContext.save()` would. Nil in the app: tests use it to make a write fail.
    var willSave: (() throws -> Void)?
    /// The writes under way (`write { }`, `Store/AccountStore+Write.swift`). Only `write`
    /// changes it.
    var writeNesting = WriteNesting()

    init(container: ModelContainer) {
        self.container = container
        self.context = ModelContext(container)
        self.context.autosaveEnabled = false
    }

    // MARK: - Containers

    /// The schema of the current version.
    static var schema: Schema { Schema(versionedSchema: CupmarkSchemaV2.self) }

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

    // Each write that the server has to learn about adds its outbox operation (M2-T16,
    // ADR 0025) before the one save, so the item change and the operation are on disk
    // together or not at all. Items read from the server (`syncState: .synced`) add none.

    /// Adds a bean. `syncState` is `pendingCreate` for a bean made on the device and
    /// `synced` for one read from the server.
    func addBean(_ bean: StoredBean, syncState: SyncState = .pendingCreate) throws {
        bean.syncState = syncState
        context.insert(bean)
        try enqueueCreate(of: bean)
        try save()
    }

    /// Adds a shelf entry for `bean`, which must be in this store. A write (`write { }`): on
    /// failure the bean's `shelfEntries` are put back too, also inside a caller's write.
    func addShelfEntry(_ entry: StoredShelfEntry, bean: StoredBean, syncState: SyncState = .pendingCreate) throws {
        try write {
            entry.syncState = syncState
            // Insert first, then link: both ends are then in the same context.
            context.insert(entry)
            entry.bean = bean
            try enqueueCreate(of: entry)
            try save()
        }
    }

    /// Adds a brew on `shelfEntry`, which must be in this store. `stageMore` runs after the
    /// brew's create is queued and before the one save, so a write staged there (the recipe
    /// kept with a brew, M2-T27) is saved with it and queued after it. A write (`write { }`):
    /// when `stageMore` or the save throws, the brew is dropped and what `stageMore` changed is
    /// put back, also inside a caller's write.
    func addBrew(
        _ brew: StoredBrew,
        shelfEntry: StoredShelfEntry,
        syncState: SyncState = .pendingCreate,
        then stageMore: () throws -> Void = {}
    ) throws {
        try write {
            brew.syncState = syncState
            context.insert(brew)
            brew.shelfEntry = shelfEntry
            try enqueueCreate(of: brew)
            try stageMore()
            try save()
        }
    }

    func addRecipe(_ recipe: StoredRecipe, syncState: SyncState = .pendingCreate) throws {
        recipe.syncState = syncState
        context.insert(recipe)
        try enqueueCreate(of: recipe)
        try save()
    }

    /// Sets the profile, the one per store. A new profile is `pendingCreate`; an edit of a
    /// profile the server has is `pendingUpdate`. Either is sent as `PUT /profile`.
    @discardableResult
    func setProfile(_ values: API.Profile) throws -> StoredProfile {
        try write { () throws -> StoredProfile in
            if let existing = try profile() {
                existing.apply(values)
                existing.syncState = existing.syncState.afterLocalEdit
                try enqueueEdit(of: existing)
                try save()
                return existing
            }
            let created = StoredProfile(values)
            created.syncState = .pendingCreate
            context.insert(created)
            try enqueueEdit(of: created)
            try save()
            return created
        }
    }

    /// Records a local edit of `item`, made by the caller before this call, and queues it
    /// (`enqueueEdit(of:)`). A bean edit is not sent: the API has no bean update. On failure
    /// the edit is undone too (`write`); a caller that throws between its edit and this call
    /// wraps both in `write` itself.
    func markUpdated<Model: PersistentModel & SyncTracked>(_ item: Model) throws {
        try write {
            item.syncState = item.syncState.afterLocalEdit
            try enqueueEdit(of: item)
            try save()
        }
    }

    /// Removes `item` on the device. Only `LocalDeletable` models can be removed: the profile
    /// cannot (the API has no delete for it; account deletion is M2-T30's own flow).
    /// - Brew, shelf entry, recipe: an item the server never had is deleted at once, with its
    ///   operations; any other is kept as `pendingDelete`, hidden, and a delete is queued.
    ///   An item whose create may already have reached the server (sent without an answer,
    ///   or on its way) counts as one the server has.
    /// - A shelf entry with brews that are not removed throws `shelfEntryHasBrews` (ADR 0012).
    /// - A bean is only a local copy (the API has no bean delete), so it is deleted at once,
    ///   with any queued create, but never while any shelf entry still names it:
    ///   `beanHasShelfEntries`.
    func markDeleted<Model: PersistentModel & LocalDeletable>(_ item: Model) throws {
        try write {
            try removeLocally(item)
        }
    }

    private func removeLocally<Model: PersistentModel & LocalDeletable>(_ item: Model) throws {
        if let entry = item as? StoredShelfEntry, !entry.liveBrewsNewestFirst.isEmpty {
            throw LocalStoreError.shelfEntryHasBrews
        }
        if let bean = item as? StoredBean {
            guard bean.shelfEntries.isEmpty else {
                throw LocalStoreError.beanHasShelfEntries
            }
            try removeOutboxOperations(for: bean.localID)
            context.delete(bean)
            try save()
            return
        }
        if item.syncState == .pendingDelete {
            return
        }
        // A pending scan (M2-T25) lives for its shelf entries: removing the last one removes it.
        var orphanedScan: StoredBean?
        if let entry = item as? StoredShelfEntry, let bean = entry.bean, try isOrphanedScan(bean, without: entry) {
            orphanedScan = bean
        }
        var decision = item.syncState.localDelete
        if decision == .removeNow, try createMayHaveReachedServer(item.localID) {
            decision = .markPendingDelete
        }
        switch decision {
        case .removeNow:
            try removeOutboxOperations(for: item.localID)
            context.delete(item)
            if let orphanedScan {
                try dropPendingBean(orphanedScan)
            }
        case .markPendingDelete:
            // Updates that have not been sent are dropped; one that may be on its way stays
            // and goes out before the delete.
            for operation in try outboxOperations(for: item.localID)
            where operation.parked || (operation.action == .update && !operation.sentWithoutAnswer) {
                context.delete(operation)
            }
            item.syncState = .pendingDelete
            if Model.outboxResource.sendsDeletes {
                try enqueue(.delete, Model.outboxResource, localID: item.localID)
            }
        }
        try save()
    }

    /// Queues the create of an item made on the device.
    private func enqueueCreate<Model: SyncTracked>(of item: Model) throws {
        if item.syncState == .pendingCreate {
            try enqueue(.create, Model.outboxResource, localID: item.localID)
        }
    }

    /// Saves the context; on failure, every unsaved change is undone (`discardUnsavedChanges()`:
    /// changed models take their saved values again, inserts and deletes are rolled back) and
    /// the error thrown. After a save `onSave` is called, so the sync engine can look at the
    /// outbox, and `didSaveNotification` is posted with this store as its object, so screens
    /// read again.
    func save() throws {
        do {
            try refuseSaveAfterFailedInnerWrite()
            try willSave?()
            try context.save()
        } catch {
            discardUnsavedChanges()
            throw error
        }
        onSave?()
        NotificationCenter.default.post(name: AccountStore.didSaveNotification, object: self)
    }

    /// Posted on the saving thread (the main actor in the app) after every successful
    /// `save()`, by screen writes, the sync engine and the pull alike (M2-T18). The object is
    /// the `AccountStore`.
    static let didSaveNotification = Notification.Name("app.cupmark.AccountStore.didSave")

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
