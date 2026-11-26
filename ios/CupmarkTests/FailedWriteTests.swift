import SQLite3
import SwiftData
import XCTest
@testable import Cupmark

/// Failed writes put every edited field back (M2-T35, ADR 0025 Addendum M2-T35).
///
/// `ModelContext.rollback()` does not restore an attribute changed on a model that was already
/// saved. Every test here makes a write throw after it changed a saved model, through the
/// store's `willSave` hook (as a failed `ModelContext.save()` would) or an injected write
/// closure, and checks that the model is as it was, that nothing was queued, and that the next
/// unrelated save stores none of the failed change (read back through a fresh context, which
/// sees only the disk). Every `FakeSyncServer` is held for the whole test.
@MainActor
final class FailedWriteTests: XCTestCase {
    private struct WriteFailed: Error {}

    private static let barcode = "5901234123457"
    private static let otherBeanID = "01JD00000000000000000BEAN2"

    private var scanned: CanonicalBarcode {
        get throws { try XCTUnwrap(CanonicalBarcode(FailedWriteTests.barcode)) }
    }

    private var product: API.OpenFoodFactsProduct {
        API.OpenFoodFactsProduct(name: "Test Roast Espresso", brand: "Test Roastery", imageId: FakeSyncBackend.id(990))
    }

    private var lookUpRequests: [String] {
        ["GET /barcodes/\(FailedWriteTests.barcode)", "GET /barcodes/\(FailedWriteTests.barcode)/open_food_facts"]
    }

    // MARK: - Helpers

    private func describe(_ operation: OutboxOperation) -> String {
        "\(operation.actionRaw) \(operation.resourceRaw)\(operation.parked ? " parked" : "")"
    }

    /// The queue as the shared context sees it.
    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map(describe)
    }

    /// The queue as it is on disk.
    private func savedQueue(_ store: AccountStore) throws -> [String] {
        let context = ModelContext(store.container)
        let operations = try context.fetch(FetchDescriptor<OutboxOperation>(sortBy: [SortDescriptor(\OutboxOperation.sequence)]))
        return operations.map(describe)
    }

    /// Reads the models of one type as they are on disk, through a fresh context.
    private func saved<Model: PersistentModel, Value>(_ type: Model.Type, in store: AccountStore, _ read: ([Model]) throws -> Value) throws -> Value {
        let context = ModelContext(store.container)
        return try read(context.fetch(FetchDescriptor<Model>()))
    }

    /// A save that has nothing to do with the failed write: a new recipe and its create.
    private func unrelatedSave(_ store: AccountStore) throws {
        try store.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
    }

    private func failSaves(_ store: AccountStore) {
        store.willSave = { throw WriteFailed() }
    }

    private func otherBean(in store: AccountStore) throws -> StoredBean {
        let bean = StoredBean(API.Bean(
            beanId: FailedWriteTests.otherBeanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self)),
            operatorAttributes: API.BeanAttributes()
        ))
        try store.addBean(bean, syncState: .synced)
        return bean
    }

    private func syncedBrew(in store: AccountStore) throws -> StoredBrew {
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let brew = try StoredBrew(try StoreFixtures.brewInput(rated: false), serverID: StoreFixtures.brewID)
        try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
        return brew
    }

    /// A bag scanned offline on the shelf: its pending bean and entry, with the bean's look-up
    /// turned into `action` (and, for a confirmation, the hit held), all saved.
    private func pendingScan(_ store: AccountStore, action: OutboxAction = .lookUp) throws -> StoredBean {
        let entryID = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store).save())
        let bean = try XCTUnwrap(store.shelfEntry(localID: entryID)?.bean)
        let operation = try XCTUnwrap(store.pendingScanOperation(of: bean.localID))
        operation.actionRaw = action.rawValue
        if action == .awaitConfirmation {
            bean.holdOpenFoodFactsProduct(product)
        }
        try store.save()
        XCTAssertEqual(try queue(store), ["\(action.rawValue) bean", "create shelf_entry"])
        return bean
    }

    // MARK: - Fixtures and the mechanism

    func testEveryFixtureIDIsAValidContractID() {
        let ids = [
            StoreFixtures.beanID,
            StoreFixtures.shelfEntryID,
            StoreFixtures.brewID,
            StoreFixtures.recipeID,
            FailedWriteTests.otherBeanID,
        ]
        for id in ids {
            XCTAssertNotNil(ResourceID(id), "\(id) is not a ULID")
        }
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    /// A failed write puts back every stored property but the key the model is found by. A
    /// property added to a model fails here until it is restored too.
    func testEveryStoredPropertyOfEveryModelIsPutBack() {
        func restored<Model: SavedValuesRestorable>(_ type: Model.Type) -> Set<String> {
            Set(Model.restoredProperties.map(\.name))
        }
        let expected: [String: (restored: Set<String>, notRestored: Set<String>)] = [
            "StoredBean": (restored(StoredBean.self), ["localID"]),
            "StoredShelfEntry": (restored(StoredShelfEntry.self), ["localID"]),
            "StoredBrew": (restored(StoredBrew.self), ["localID"]),
            "StoredRecipe": (restored(StoredRecipe.self), ["localID"]),
            "StoredProfile": (restored(StoredProfile.self), ["localID"]),
            "OutboxOperation": (restored(OutboxOperation.self), ["sequence", "localID"]),
            "QueuedLabelPhoto": (restored(QueuedLabelPhoto.self), ["localID"]),
        ]
        let entities = AccountStore.schema.entities
        XCTAssertEqual(Set(entities.map(\.name)), Set(expected.keys))
        XCTAssertTrue(CupmarkSchemaV2.models.allSatisfy { model in model is any SavedValuesRestorable.Type })
        for entity in entities {
            guard let names = expected[entity.name] else {
                XCTFail("no restore for \(entity.name)")
                continue
            }
            let stored = Set(entity.attributes.map(\.name)).union(entity.relationships.map(\.name))
            XCTAssertEqual(stored, names.restored.union(names.notRestored), entity.name)
            XCTAssertTrue(names.restored.isDisjoint(with: names.notRestored), entity.name)
        }
    }

    /// No name and no key path is listed twice (M2-T36), so two entries cannot both restore one
    /// field while another is left out. SwiftData does not make `Schema.PropertyMetadata`'s name
    /// or key path public (the first macOS run of this test did not compile), so the key path
    /// itself cannot be matched to the schema here; the per-site tests below restore every field
    /// and compare the result.
    func testEveryRestoredPropertyHasItsOwnNameAndKeyPath() {
        func check<Model: SavedValuesRestorable>(_ type: Model.Type, file: StaticString = #filePath, line: UInt = #line) {
            let restored = Model.restoredProperties
            XCTAssertEqual(Set(restored.map(\.name)).count, restored.count, "\(Model.self): a name is listed twice", file: file, line: line)
            XCTAssertEqual(Set(restored.map { property in property.keyPath as AnyKeyPath }).count, restored.count, "\(Model.self): a key path is listed twice", file: file, line: line)
        }
        check(StoredBean.self)
        check(StoredShelfEntry.self)
        check(StoredBrew.self)
        check(StoredRecipe.self)
        check(StoredProfile.self)
        check(OutboxOperation.self)
        check(QueuedLabelPhoto.self)
    }

    func testAWriteThatThrowsPutsBackEveryChangedFieldOfASavedBrew() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let entry = try XCTUnwrap(brew.shelfEntry)
        let other = StoredShelfEntry(try StoreFixtures.shelfEntryInput(), serverID: FakeSyncBackend.id(950))
        try store.addShelfEntry(other, bean: try XCTUnwrap(entry.bean), syncState: .synced)
        let before = try brew.apiInput()

        XCTAssertThrowsError(try store.write {
            brew.doseDg = 222
            brew.methodID = try StoreFixtures.last(Vocabulary.Method.self).rawValue
            try brew.setRating(RatingValues(try StoreFixtures.rating()))
            brew.syncState = .pendingUpdate
            brew.syncIssue = .rejected
            brew.shelfEntry = other
            try store.enqueue(.update, .brew, localID: brew.localID)
            throw WriteFailed()
        })

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try brew.apiInput(), before)
        XCTAssertNil(brew.rating)
        XCTAssertEqual(brew.syncState, .synced)
        XCTAssertNil(brew.syncIssue)
        XCTAssertEqual(brew.shelfEntry?.localID, entry.localID)
        XCTAssertEqual(entry.brews.map(\.localID), [brew.localID])
        XCTAssertTrue(other.brews.isEmpty)
        XCTAssertEqual(try queue(store), [])

        try unrelatedSave(store)
        XCTAssertEqual(try brew.apiInput(), before)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        let savedDose = try saved(StoredBrew.self, in: store) { brews in brews.first?.doseDg }
        XCTAssertEqual(savedDose, before.parameters.doseDg)
    }

    // MARK: - Nested writes (M2-T36)

    func testAnInnerWriteThatThrowsPutsBackWhatTheOuterWriteChanged() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let before = try brew.apiInput()

        XCTAssertThrowsError(try store.write {
            brew.doseDg = 222
            try store.write { () throws -> Void in
                brew.methodID = try StoreFixtures.last(Vocabulary.Method.self).rawValue
                brew.syncState = .pendingUpdate
                try store.enqueue(.update, .brew, localID: brew.localID)
                throw WriteFailed()
            }
        }) { error in
            XCTAssertTrue(error is WriteFailed, "the inner write's own error reaches the caller")
        }

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try brew.apiInput(), before)
        XCTAssertEqual(brew.syncState, .synced)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBrew.self, in: store) { brews in brews.first?.doseDg }, before.parameters.doseDg)
    }

    func testAShelfEntryAddedInsideAFailedWriteLeavesTheBeanAndTheOuterChangesAsTheyWere() throws {
        let store = try AccountStore.inMemory()
        let bean = try otherBean(in: store)
        let process = bean.pickedProcessID
        let added = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        failSaves(store)

        XCTAssertThrowsError(try store.write {
            bean.pickedProcessID = try StoreFixtures.last(Vocabulary.Process.self).rawValue
            try store.addShelfEntry(added, bean: bean)
        })

        store.willSave = nil
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(bean.pickedProcessID, process)
        XCTAssertTrue(bean.shelfEntries.isEmpty)
        XCTAssertTrue(try store.shelfEntries().isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.count }, 0)
        XCTAssertEqual(try saved(StoredBean.self, in: store) { beans in beans.first?.pickedProcessID }, process)
    }

    func testAFailedShelfEntryAddOnItsOwnLeavesTheBeanAsItWas() throws {
        let store = try AccountStore.inMemory()
        let bean = try otherBean(in: store)
        let added = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        failSaves(store)

        XCTAssertThrowsError(try store.addShelfEntry(added, bean: bean))

        store.willSave = nil
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertTrue(bean.shelfEntries.isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.count }, 0)
    }

    /// `addBrew` on its own: a throw of its staged step (before any save) drops the brew and
    /// puts back what the step changed on a saved model.
    func testABrewAddWhoseStagedStepThrowsLeavesNothingBehind() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let before = try entry.apiInput()
        let brew = try StoredBrew(try StoreFixtures.brewInput())

        XCTAssertThrowsError(try store.addBrew(brew, shelfEntry: entry) {
            entry.bagSizeID = try StoreFixtures.last(Vocabulary.BagSize.self).rawValue
            throw WriteFailed()
        })

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertTrue(entry.brews.isEmpty)
        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBrew.self, in: store) { brews in brews.count }, 0)
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.bagSizeID }, before.bagSize?.rawValue)
    }

    func testABrewAddedInsideAFailedWriteLeavesTheOuterChangesAsTheyWere() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let before = try entry.apiInput()
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        failSaves(store)

        XCTAssertThrowsError(try store.write {
            entry.roastDateRaw = nil
            try store.addBrew(brew, shelfEntry: entry)
        })

        store.willSave = nil
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertTrue(entry.brews.isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.roastDateRaw }, before.roastDate?.description)
    }

    /// An outer write that catches its inner write's error cannot store a part of it: its next
    /// save is refused, and its end discards and throws.
    func testAnOuterWriteThatCatchesAnInnerFailureStoresNothing() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        let before = try brew.apiInput()

        XCTAssertThrowsError(try store.write {
            brew.doseDg = 222
            _ = try? store.write { () throws -> Void in
                brew.waterG = 999
                throw WriteFailed()
            }
            brew.syncState = .pendingUpdate
            try store.enqueue(.update, .brew, localID: brew.localID)
            try store.save()
        }) { error in
            XCTAssertEqual(error as? WriteNestingError, .innerWriteFailed)
        }

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try brew.apiInput(), before)
        XCTAssertEqual(try queue(store), [])

        // Without a save in the outer write: its end throws, and nothing is left unsaved.
        XCTAssertThrowsError(try store.write {
            brew.doseDg = 222
            _ = try? store.write { () throws -> Void in
                throw WriteFailed()
            }
        }) { error in
            XCTAssertEqual(error as? WriteNestingError, .innerWriteFailed)
        }

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try brew.apiInput(), before)
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBrew.self, in: store) { brews in brews.first?.doseDg }, before.parameters.doseDg)

        // The next write starts clean.
        try store.write {
            brew.doseDg = 222
            try store.markUpdated(brew)
        }
        XCTAssertEqual(brew.doseDg, 222)
        XCTAssertEqual(try savedQueue(store), ["create recipe", "update brew"])
    }

    // MARK: - A failure of ModelContext.save() itself (M2-T36)

    /// `ModelContext.save()` fails here without the `willSave` hook: the store is opened again
    /// read-only (`allowsSave: false`), so SwiftData refuses the save. A uniqueness violation
    /// on `localID` cannot be used for this: SwiftData answers a second model with the same
    /// unique value with an upsert, not with a failed save (ADR 0025, Addendum M2-T36). Both
    /// removals delete models with relationships: a brew on its entry, and a scanned bag's
    /// entry with the pending bean it leaves.
    func testASaveThatFailsInTheStoreUndoesADeletionWithRelationships() throws {
        // Two folders: the writable store fills the first and is closed; the read-only store
        // opens a copy in the second, so no other connection ever shares its SQLite files (a
        // writable container closed late checkpoints and unlinks the -wal and -shm files under
        // the read-only one, and its reads then miss rows; ADR 0025, Addendum M2-T36).
        let root = FileManager.default.temporaryDirectory.appending(
            path: "FailedWriteTests-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let written = root.appending(path: "written", directoryHint: .isDirectory)
        let readOnly = root.appending(path: "read-only", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: written, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: readOnly, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let fileName = "account.store"
        func openStore(in directory: URL, allowsSave: Bool) throws -> AccountStore {
            let schema = AccountStore.schema
            let url = directory.appending(path: fileName, directoryHint: .notDirectory)
            let configuration = ModelConfiguration("FailedWriteTests", schema: schema, url: url, allowsSave: allowsSave, cloudKitDatabase: .none)
            return AccountStore(container: try ModelContainer(for: schema, migrationPlan: CupmarkMigrationPlan.self, configurations: configuration))
        }

        var entryID = UUID()
        var brewID = UUID()
        var scannedEntryID = UUID()
        var pendingBeanID = UUID()
        weak var writableContainer: ModelContainer?
        try autoreleasepool {
            let writable = try openStore(in: written, allowsSave: true)
            writableContainer = writable.container
            let entry = try StoreFixtures.syncedShelfEntry(in: writable)
            let brew = try StoredBrew(try StoreFixtures.brewInput())
            try writable.addBrew(brew, shelfEntry: entry)
            let scannedEntry = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: writable).save())
            entryID = entry.localID
            brewID = brew.localID
            scannedEntryID = scannedEntry
            pendingBeanID = try XCTUnwrap(writable.shelfEntry(localID: scannedEntry)?.bean?.localID)
        }
        // The writable container must be gone before the copy: a close during the copy could
        // checkpoint its WAL between the two files and lose the newest rows. A timeout fails here,
        // as a setup problem, rather than later as a missing bean.
        XCTAssertTrue(waitUntilReleased { writableContainer != nil }, "the writable container is still open")
        for name in [fileName, "\(fileName)-wal"] {
            let source = written.appending(path: name, directoryHint: .notDirectory)
            if FileManager.default.fileExists(atPath: source.path(percentEncoded: false)) {
                try FileManager.default.copyItem(at: source, to: readOnly.appending(path: name, directoryHint: .notDirectory))
            }
        }
        // A read-only connection does not reliably read rows that are still only in the copied
        // write-ahead log (it cannot rebuild the -shm index it needs), which lost the newest rows
        // on the macOS job. Fold the log into the main file of the copy first, so the read-only
        // store reads one self-contained file.
        try checkpointAndCloseWriteAheadLog(of: readOnly.appending(path: fileName, directoryHint: .notDirectory))
        weak var readOnlyContainer: ModelContainer?
        // The read-only store is closed, as far as SwiftData lets go of it, before the teardown
        // removes its folder.
        defer {
            _ = waitUntilReleased { readOnlyContainer != nil }
        }
        try autoreleasepool {
            let store = try openStore(in: readOnly, allowsSave: false)
            readOnlyContainer = store.container
            try checkFailedSaves(in: store, entryID: entryID, brewID: brewID, scannedEntryID: scannedEntryID, pendingBeanID: pendingBeanID)
        }
    }

    /// Writes every frame of the SQLite write-ahead log at `url` into the main file, truncates the
    /// log and closes the connection, through the SQLite C API (SwiftData has no checkpoint call).
    private func checkpointAndCloseWriteAheadLog(of url: URL) throws {
        var database: OpaquePointer?
        let path = url.path(percentEncoded: false)
        guard sqlite3_open_v2(path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let database else {
            sqlite3_close(database)
            throw StoreCopyError.open
        }
        defer { sqlite3_close(database) }
        var logFrames: Int32 = 0
        var checkpointed: Int32 = 0
        guard sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_TRUNCATE, &logFrames, &checkpointed) == SQLITE_OK else {
            throw StoreCopyError.checkpoint
        }
        XCTAssertEqual(logFrames, checkpointed, "every log frame is in the main file")
    }

    private enum StoreCopyError: Error {
        case open
        case checkpoint
    }

    /// Spins the run loop for up to 5 s while `isAlive` holds; true once it no longer does.
    private func waitUntilReleased(_ isAlive: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while isAlive(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return !isAlive()
    }

    /// The removals of `testASaveThatFailsInTheStoreUndoesADeletionWithRelationships` on the
    /// read-only store.
    private func checkFailedSaves(in store: AccountStore, entryID: UUID, brewID: UUID, scannedEntryID: UUID, pendingBeanID: UUID) throws {
        let expectedQueue = ["create brew", "look_up bean", "create shelf_entry"]

        XCTAssertNil(store.willSave, "the store itself fails, not the hook")
        let entry = try XCTUnwrap(store.shelfEntry(localID: entryID))
        let brew = try XCTUnwrap(store.brew(localID: brewID))
        XCTAssertEqual(try queue(store), expectedQueue)

        // A brew the server never had is deleted at once, with its create.
        XCTAssertThrowsError(try store.markDeleted(brew))

        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try store.brew(localID: brewID)?.localID, brewID)
        XCTAssertEqual(brew.shelfEntry?.localID, entryID)
        XCTAssertEqual(entry.brews.map(\.localID), [brewID])
        XCTAssertEqual(try store.brewsNewestFirst().map(\.localID), [brewID])
        XCTAssertEqual(try queue(store), expectedQueue)

        // A scanned bag's entry the server never had goes at once, and its pending bean with it.
        let scannedEntry = try XCTUnwrap(store.shelfEntry(localID: scannedEntryID))
        let pendingBean = try XCTUnwrap(store.bean(localID: pendingBeanID))
        XCTAssertThrowsError(try store.markDeleted(scannedEntry))

        // Both ends of the relationship were deleted, and the failed save had already nullified
        // it: the rollback alone brought the entry back without its bean and twice in the bean's
        // list (the first macOS run, while the files were still shared with the writable store).
        // The pass after the rollback sets them to the store's values, which may leave them as
        // changes of the context, equal to the disk; nothing inserted or deleted is left.
        XCTAssertTrue(store.context.insertedModelsArray.isEmpty)
        XCTAssertTrue(store.context.deletedModelsArray.isEmpty)
        XCTAssertEqual(try store.bean(localID: pendingBeanID)?.localID, pendingBeanID)
        // Read through fresh fetches first (what the app's screens do: they keep local ids and
        // fetch again), then through the instances held from before the failed write.
        XCTAssertEqual(try store.shelfEntry(localID: scannedEntryID)?.bean?.localID, pendingBeanID, "fetched entry")
        XCTAssertEqual(try store.bean(localID: pendingBeanID)?.shelfEntries.map(\.localID), [scannedEntryID], "fetched bean")
        XCTAssertEqual(scannedEntry.bean?.localID, pendingBeanID, "held entry")
        XCTAssertEqual(pendingBean.shelfEntries.map(\.localID), [scannedEntryID], "held bean")
        XCTAssertEqual(Set(try store.shelfEntries().map(\.localID)), [entryID, scannedEntryID])
        XCTAssertEqual(try queue(store), expectedQueue)
        XCTAssertEqual(try store.pendingBeanStates()[pendingBeanID], .lookingUp)
        XCTAssertEqual(try savedQueue(store), expectedQueue)
    }

    /// The same removal as above through the `willSave` hook: a scanned bag's entry and the
    /// pending bean it leaves, both deleted in one write, come back pointing to each other.
    func testAFailedRemovalOfAScannedBagsEntryBringsBackTheEntryAndItsPendingBean() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store)
        let entry = try XCTUnwrap(bean.shelfEntries.first)
        failSaves(store)

        XCTAssertThrowsError(try store.markDeleted(entry))

        store.willSave = nil
        XCTAssertTrue(store.context.insertedModelsArray.isEmpty)
        XCTAssertTrue(store.context.deletedModelsArray.isEmpty)
        XCTAssertEqual(try store.bean(localID: bean.localID)?.localID, bean.localID)
        XCTAssertEqual(entry.bean?.localID, bean.localID)
        XCTAssertEqual(bean.shelfEntries.map(\.localID), [entry.localID])
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(try queue(store), ["look_up bean", "create shelf_entry"])

        try unrelatedSave(store)
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(entry.bean?.localID, bean.localID)
        XCTAssertEqual(bean.shelfEntries.map(\.localID), [entry.localID])
        XCTAssertEqual(try savedQueue(store), ["look_up bean", "create shelf_entry", "create recipe"])
        let savedBean = try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.bean?.localID }
        XCTAssertEqual(savedBean, bean.localID)
    }

    // MARK: - AccountStore writes

    func testAFailedProfileEditLeavesTheProfileAsItWas() throws {
        let store = try AccountStore.inMemory()
        let profile = try store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: false)))
        profile.syncState = .synced
        try store.removeOutboxOperations(for: profile.localID)
        try store.save()
        failSaves(store)

        XCTAssertThrowsError(try store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: true))))

        store.willSave = nil
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredProfile.self, in: store) { profiles in profiles.first?.contributeToAggregates }, false)
    }

    func testAFailedRemovalLeavesTheItemAsItWas() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        failSaves(store)

        XCTAssertThrowsError(try store.markDeleted(entry))

        store.willSave = nil
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.syncState }, .synced)
    }

    func testAFailedRatingSaveLeavesTheBrewAsItWas() throws {
        let store = try AccountStore.inMemory()
        let brew = try syncedBrew(in: store)
        failSaves(store)

        XCTAssertThrowsError(try store.rateBrew(brew, rating: RatingValues(try StoreFixtures.rating())))

        store.willSave = nil
        XCTAssertNil(brew.rating)
        XCTAssertEqual(brew.syncState, .synced)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertNil(brew.rating)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBrew.self, in: store) { brews in brews.first?.ratingData == nil }, true)
    }

    // MARK: - ShelfEntryEditorModel

    func testAFailedShelfEntryEditLeavesTheEntryAndBothBeansAsTheyWere() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let first = try XCTUnwrap(entry.bean)
        let other = try otherBean(in: store)
        let before = try entry.apiInput()
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store)
        editor.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))
        editor.setHasRoastDate(false)
        failSaves(store)

        XCTAssertNil(editor.save())

        store.willSave = nil
        XCTAssertEqual(editor.failure, .saveFailed)
        XCTAssertTrue(editor.canSave, "the user can try again")
        XCTAssertEqual(entry.bean?.localID, first.localID)
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(first.shelfEntries.map(\.localID), [entry.localID])
        XCTAssertTrue(other.shelfEntries.isEmpty)
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertEqual(try queue(store), [])

        try unrelatedSave(store)
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        let savedBean = try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.bean?.localID }
        XCTAssertEqual(savedBean, first.localID)

        // Tried again, it is written.
        XCTAssertNotNil(editor.save())
        XCTAssertEqual(entry.bean?.localID, other.localID)
        XCTAssertEqual(try queue(store), ["create recipe", "update shelf_entry"])
    }

    func testAFailedShelfEntryRemovalLeavesTheEntryAsItWas() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store)
        failSaves(store)

        XCTAssertFalse(editor.delete())

        store.willSave = nil
        XCTAssertEqual(editor.failure, .saveFailed)
        XCTAssertFalse(editor.didDelete)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try store.shelfEntries().map(\.localID), [entry.localID])
    }

    func testAFailedSaveOfAScannedBagLeavesNothingBehind() throws {
        let store = try AccountStore.inMemory()
        let editor = ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store)
        failSaves(store)

        XCTAssertNil(editor.save())

        store.willSave = nil
        XCTAssertEqual(editor.failure, .saveFailed)
        XCTAssertFalse(store.context.hasChanges)
        XCTAssertTrue(try store.beans().isEmpty, "the pending bean inserted for the entry is gone")
        XCTAssertTrue(try store.shelfEntries().isEmpty)
        XCTAssertEqual(try queue(store), [])

        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBean.self, in: store) { beans in beans.count }, 0)

        // Tried again, the bean and its look-up are saved with the entry.
        XCTAssertNotNil(editor.save())
        XCTAssertEqual(try queue(store), ["create recipe", "look_up bean", "create shelf_entry"])
    }

    func testAFailedSaveOfABagScannedAgainLeavesItsPendingBeanAsItWas() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store, action: .awaitConfirmation)
        let editor = ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store)
        failSaves(store)

        XCTAssertNil(editor.save())

        store.willSave = nil
        XCTAssertEqual(bean.shelfEntries.count, 1)
        XCTAssertEqual(bean.heldOpenFoodFactsProduct, product)
        XCTAssertEqual(try queue(store), ["await_confirmation bean", "create shelf_entry"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["await_confirmation bean", "create shelf_entry", "create recipe"])
    }

    func testMovingTheLastShelfEntryOffAPendingBeanDropsTheBean() throws {
        let store = try AccountStore.inMemory()
        let pending = try pendingScan(store, action: .awaitDescription)
        let pendingID = pending.localID
        store.queueLabelPhoto(fileName: "label.jpg", beanLocalID: pendingID)
        try store.save()
        let entry = try XCTUnwrap(pending.shelfEntries.first)
        let other = try otherBean(in: store)
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store)
        editor.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))

        XCTAssertNotNil(editor.save())

        XCTAssertEqual(entry.bean?.localID, other.localID)
        XCTAssertNil(try store.bean(localID: pendingID), "nothing on the shelf needs it any more")
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertEqual(try queue(store), ["create shelf_entry"], "the entry's unsent create carries the new bean")
        XCTAssertTrue(try store.pendingBeanQuestions().isEmpty)
    }

    func testMovingOneOfTwoShelfEntriesOffAPendingBeanKeepsTheBean() throws {
        let store = try AccountStore.inMemory()
        let pending = try pendingScan(store)
        let second = try XCTUnwrap(ShelfEntryEditorModel(mode: .addScanned(try scanned), store: store).save())
        let other = try otherBean(in: store)
        let editor = ShelfEntryEditorModel(mode: .edit(second), store: store)
        editor.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))

        XCTAssertNotNil(editor.save())

        XCTAssertNotNil(try store.bean(localID: pending.localID), "still on the first entry")
        XCTAssertEqual(try queue(store), ["look_up bean", "create shelf_entry", "create shelf_entry"])
    }

    func testAFailedMoveOffAPendingBeanKeepsTheBeanAndItsLookUp() throws {
        let store = try AccountStore.inMemory()
        let pending = try pendingScan(store)
        let entry = try XCTUnwrap(pending.shelfEntries.first)
        let other = try otherBean(in: store)
        let editor = ShelfEntryEditorModel(mode: .edit(entry.localID), store: store)
        editor.chooseBean(ShelfBeanChoice(id: other.localID, summary: ShelfBeanSummary(other)))
        failSaves(store)

        XCTAssertNil(editor.save())

        store.willSave = nil
        XCTAssertEqual(editor.failure, .saveFailed)
        XCTAssertEqual(try store.bean(localID: pending.localID)?.localID, pending.localID)
        XCTAssertEqual(entry.bean?.localID, pending.localID)
        XCTAssertEqual(pending.shelfEntries.map(\.localID), [entry.localID])
        XCTAssertTrue(other.shelfEntries.isEmpty)
        XCTAssertEqual(try queue(store), ["look_up bean", "create shelf_entry"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["look_up bean", "create shelf_entry", "create recipe"])
        XCTAssertEqual(try store.pendingBeanStates()[pending.localID], .lookingUp)
    }

    // MARK: - BrewFormModel

    func testABrewWriteThatThrowsAfterChangingTheEntryLeavesTheEntryAsItWas() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let before = try entry.apiInput()
        let model = BrewFormModel(shelfEntry: entry.localID, store: store, addBrew: { _, _, stored, _ in
            stored.roastDateRaw = nil
            stored.syncState = .pendingUpdate
            throw WriteFailed()
        })
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)

        XCTAssertNil(model.save())

        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertTrue(model.canSave, "the user can try again")
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertTrue(entry.brews.isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try entry.apiInput(), before)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.roastDateRaw }, before.roastDate?.description)
    }

    func testAFailedBrewSaveLeavesNoBrewOnTheEntry() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let model = BrewFormModel(shelfEntry: entry.localID, store: store)
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)
        failSaves(store)

        XCTAssertNil(model.save())

        store.willSave = nil
        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertEqual(entry.liveBrewCount, 0)
        XCTAssertTrue(try store.brewsNewestFirst().isEmpty)
        XCTAssertEqual(try queue(store), [])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["create recipe"])
        XCTAssertEqual(try saved(StoredBrew.self, in: store) { brews in brews.count }, 0)
    }

    // MARK: - SyncIssuesModel

    /// A synced shelf entry with a refused (parked) update and its flag, saved.
    private func refusedUpdate(_ store: AccountStore) throws -> StoredShelfEntry {
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        entry.bagSizeID = try StoreFixtures.last(Vocabulary.BagSize.self).rawValue
        try store.markUpdated(entry)
        let operation = try XCTUnwrap(store.outboxOperations().first)
        operation.parked = true
        operation.parkReason = .rejected
        operation.attemptCount = 3
        entry.syncIssue = .rejected
        try store.save()
        return entry
    }

    func testAFailedRedoLeavesTheOperationParked() throws {
        let store = try AccountStore.inMemory()
        let entry = try refusedUpdate(store)
        let model = SyncIssuesModel(store: store)
        model.reload()
        let item = try XCTUnwrap(model.rows.first?.item)
        failSaves(store)

        XCTAssertFalse(model.redo(item))

        store.willSave = nil
        XCTAssertEqual(model.failure, .saveFailed)
        let operation = try XCTUnwrap(store.outboxOperations().first)
        XCTAssertTrue(operation.parked)
        XCTAssertEqual(operation.parkReason, .rejected)
        XCTAssertEqual(operation.attemptCount, 3)
        XCTAssertEqual(entry.syncIssue, .rejected)
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["update shelf_entry parked", "create recipe"])
        XCTAssertEqual(try store.syncIssues().map(\.localID), [entry.localID])
    }

    func testAFailedDiscardLeavesTheOperationAndTheItemAsTheyWere() throws {
        let store = try AccountStore.inMemory()
        let entry = try refusedUpdate(store)
        let changed = entry.bagSizeID
        let model = SyncIssuesModel(store: store)
        model.reload()
        let item = try XCTUnwrap(model.rows.first?.item)
        failSaves(store)

        XCTAssertFalse(model.discard(item))

        store.willSave = nil
        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertEqual(entry.syncState, .pendingUpdate)
        XCTAssertEqual(entry.syncIssue, .rejected)
        XCTAssertEqual(entry.bagSizeID, changed)
        XCTAssertEqual(try queue(store), ["update shelf_entry parked"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["update shelf_entry parked", "create recipe"])
        XCTAssertEqual(try saved(StoredShelfEntry.self, in: store) { entries in entries.first?.syncState }, .pendingUpdate)
    }

    // MARK: - Puller

    func testAFailedMergeLeavesSyncedItemsAsTheyWere() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        var values = API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())
        let localDose = values.parameters.doseDg
        let recipe = StoredRecipe(values, serverID: FakeSyncBackend.id(20))
        try store.addRecipe(recipe, syncState: .synced)
        values.parameters.doseDg = 200
        server.backend.seed(recipe: FakeSyncBackend.id(20), values)
        failSaves(store)

        let failed = await Puller(store: store, client: server.client()).pull()

        store.willSave = nil
        XCTAssertEqual(failed, .storeFailed)
        XCTAssertEqual(recipe.doseDg, localDose, "the server's value was put back")
        XCTAssertEqual(recipe.syncState, .synced)
        XCTAssertFalse(store.context.hasChanges)
        try unrelatedSave(store)
        XCTAssertEqual(recipe.doseDg, localDose)
        let savedDose = try saved(StoredRecipe.self, in: store) { recipes in
            recipes.first { stored in stored.serverID == FakeSyncBackend.id(20) }?.doseDg
        }
        XCTAssertEqual(savedDose, localDose)

        // The next pull takes the server's values.
        let pulled = await Puller(store: store, client: server.client()).pull()
        guard case .completed = pulled else {
            return XCTFail("pull: \(pulled)")
        }
        XCTAssertEqual(recipe.doseDg, 200)
        withExtendedLifetime(server) {}
    }

    // MARK: - Pending beans (AccountStore+PendingBeans)

    func testAFailedDescriptionLeavesTheQuestionAndARetryWritesIt() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store, action: .awaitDescription)
        let process = try StoreFixtures.first(Vocabulary.Process.self)
        failSaves(store)

        XCTAssertThrowsError(try store.describePendingBean(beanLocalID: bean.localID, picks: API.BeanAttributes(process: process), labelPhotoFiles: ["label.jpg"]))

        store.willSave = nil
        XCTAssertNil(bean.pickedProcessID)
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertEqual(try queue(store), ["await_description bean", "create shelf_entry"])
        XCTAssertEqual(try store.pendingBeanQuestions().map(\.kind), [.describe])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["await_description bean", "create shelf_entry", "create recipe"])

        // The retry finds the question and writes the description with its photo.
        XCTAssertTrue(try store.describePendingBean(beanLocalID: bean.localID, picks: API.BeanAttributes(process: process), labelPhotoFiles: ["label.jpg"]))
        XCTAssertEqual(bean.pickedProcessID, process.rawValue)
        XCTAssertEqual(try store.queuedLabelPhotos().map(\.fileName), ["label.jpg"])
        XCTAssertEqual(try savedQueue(store), ["create bean", "create shelf_entry", "create recipe"])
    }

    func testAFailedSkipLeavesTheQuestion() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store, action: .awaitDescription)
        failSaves(store)

        XCTAssertThrowsError(try store.skipDescription(beanLocalID: bean.localID))

        store.willSave = nil
        XCTAssertEqual(try queue(store), ["await_description bean", "create shelf_entry"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["await_description bean", "create shelf_entry", "create recipe"])
        XCTAssertTrue(try store.skipDescription(beanLocalID: bean.localID))
        XCTAssertEqual(try queue(store), ["create bean", "create shelf_entry", "create recipe"])
    }

    func testAFailedConfirmationOrRejectionLeavesTheHit() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store, action: .awaitConfirmation)
        failSaves(store)

        XCTAssertThrowsError(try store.confirmOpenFoodFacts(beanLocalID: bean.localID, picks: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self))))
        XCTAssertThrowsError(try store.rejectOpenFoodFacts(beanLocalID: bean.localID))

        store.willSave = nil
        XCTAssertFalse(bean.openFoodFactsConfirmed)
        XCTAssertNil(bean.pickedProcessID)
        XCTAssertEqual(bean.heldOpenFoodFactsProduct, product)
        XCTAssertEqual(try queue(store), ["await_confirmation bean", "create shelf_entry"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["await_confirmation bean", "create shelf_entry", "create recipe"])
        XCTAssertEqual(try saved(StoredBean.self, in: store) { beans in beans.first?.openFoodFactsConfirmed }, false)
    }

    func testAFailedOfflineDescriptionOfAPendingScanLeavesItsQuestion() throws {
        let store = try AccountStore.inMemory()
        let bean = try pendingScan(store, action: .awaitConfirmation)
        let create = API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: FailedWriteTests.barcode,
            openFoodFactsConfirmed: nil,
            attributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self))
        )
        failSaves(store)

        XCTAssertThrowsError(try store.addOfflineBean(create, labelPhotoFiles: ["label.jpg"]))

        store.willSave = nil
        XCTAssertNil(bean.pickedProcessID)
        XCTAssertEqual(bean.heldOpenFoodFactsProduct, product)
        XCTAssertTrue(try store.queuedLabelPhotos().isEmpty)
        XCTAssertEqual(try queue(store), ["await_confirmation bean", "create shelf_entry"])
        try unrelatedSave(store)
        XCTAssertEqual(try savedQueue(store), ["await_confirmation bean", "create shelf_entry", "create recipe"])
        let savedProduct = try saved(StoredBean.self, in: store) { beans in beans.first?.openFoodFactsName }
        XCTAssertEqual(savedProduct, product.name)
    }

    func testADescriptionIsNeverSentWithoutAStore() async throws {
        let server = try FakeSyncServer()
        let entry = BeanEntryModel(barcode: try scanned, client: server.client(), describing: UUID())
        entry.picks.process = try StoreFixtures.first(Vocabulary.Process.self)

        await entry.save()

        XCTAssertTrue(server.requests.isEmpty, "no POST /beans for a pending bean")
        XCTAssertEqual(entry.state, .failed(.noStore))
        XCTAssertFalse(entry.canSave, "no retry: another try would have no store either")
        XCTAssertNotEqual(BeanEntryScreen.title(for: .noStore), BeanEntryScreen.title(for: .retryable))

        // Changing a pick does not offer it again either, and still sends nothing.
        entry.picks.process = try StoreFixtures.last(Vocabulary.Process.self)
        XCTAssertFalse(entry.canSave)
        await entry.save()
        XCTAssertTrue(server.requests.isEmpty)
        XCTAssertEqual(entry.state, .failed(.noStore))
        withExtendedLifetime(server) {}
    }

    // MARK: - SyncEngine

    func testAFailedQuestionOfTheEngineLeavesTheLookUpAndItIsTriedAgain() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let clock = TestClock()
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })
        let bean = try pendingScan(store)
        // Only the save that turns the look-up into a question fails.
        store.willSave = { [unowned store] in
            if try store.outboxOperations().contains(where: { operation in operation.action == .awaitDescription }) {
                throw WriteFailed()
            }
        }

        let first = await engine.drain()

        guard case .waiting = first else {
            return XCTFail("expected a retry, got \(first)")
        }
        XCTAssertEqual(server.log, lookUpRequests)
        XCTAssertEqual(try queue(store), ["look_up bean", "create shelf_entry"])
        XCTAssertEqual(try savedQueue(store), ["look_up bean", "create shelf_entry"])
        XCTAssertTrue(try store.pendingBeanQuestions().isEmpty, "no question the store does not hold")
        XCTAssertEqual(try store.pendingBeanStates()[bean.localID], .lookingUp)

        store.willSave = nil
        clock.advance(SyncBackoff().maximum + 1)
        let second = await engine.drain()

        XCTAssertEqual(second, .idle)
        XCTAssertEqual(server.log, lookUpRequests + lookUpRequests, "the look-up was tried again")
        XCTAssertEqual(try savedQueue(store), ["await_description bean", "create shelf_entry"])
        XCTAssertEqual(try store.pendingBeanQuestions().map(\.beanID), [bean.localID])
        withExtendedLifetime(server) {}
    }

    func testAParkedLookUpParksWhatNeedsItWithoutLooping() async throws {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let clock = TestClock()
        let engine = SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })
        let bean = try pendingScan(store)
        let entry = try XCTUnwrap(bean.shelfEntries.first)
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try store.addBrew(brew, shelfEntry: entry)
        server.backend.setOverride { request in
            request.path.hasPrefix("/barcodes/") ? StubResponse(status: 400) : nil
        }

        let result = await engine.drain()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(server.log, ["GET /barcodes/\(FailedWriteTests.barcode)"], "nothing that needs the bean was sent")
        XCTAssertEqual(try queue(store), ["look_up bean parked", "create shelf_entry parked", "create brew parked"])
        XCTAssertEqual(try store.outboxOperations().map(\.parkReason), [.rejected, .missingReference, .missingReference])

        // Nothing is left to send: the next drain ends at once without a request.
        let again = await engine.drain()
        XCTAssertEqual(again, .idle)
        XCTAssertEqual(server.log.count, 1)
        withExtendedLifetime(server) {}
    }
}
