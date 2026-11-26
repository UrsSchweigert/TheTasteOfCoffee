import SwiftData
import XCTest
@testable import Cupmark

/// Schema versions 2 (M2-T25) and 3 (M2-T26): a store written with version 1 or 2 opens with the
/// current schema, keeps its items and its outbox, and takes the new label photo queue and the
/// grinder columns.
final class StoreMigrationTests: XCTestCase {
    private let directory = FileManager.default.temporaryDirectory.appending(
        path: "StoreMigrationTests-\(UUID().uuidString)",
        directoryHint: .isDirectory
    )

    override func setUpWithError() throws {
        try super.setUpWithError()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    /// A store file as an older build wrote it: the given schema only, no migration plan, models
    /// of that schema (the current aliases are version 3's and do not belong to it).
    private func writeOldStore(
        _ schema: Schema,
        account: AccountID,
        write: (ModelContext) throws -> Void
    ) throws {
        let configuration = ModelConfiguration(
            try StoreLocation.fileStem(for: account),
            schema: schema,
            url: try StoreLocation.fileURL(for: account, in: directory),
            allowsSave: true,
            cloudKitDatabase: .none
        )
        let container = try ModelContainer(for: schema, configurations: configuration)
        let context = ModelContext(container)
        context.autosaveEnabled = false
        try write(context)
        try context.save()
    }

    func testAVersion1StoreOpensWithTheCurrentSchemaAndKeepsItsItemsAndOutbox() throws {
        let folder = directory
        let account = AccountID(subject: AuthFixtures.subject)
        let beanID = UUID()
        let brewID = UUID()
        try writeOldStore(Schema(versionedSchema: CupmarkSchemaV1.self), account: account) { context in
            let bean = CupmarkSchemaV1.StoredBean(localID: beanID, barcode: "4006381333931")
            let entry = CupmarkSchemaV1.StoredShelfEntry(purchaseDate: try StoreFixtures.day("2026-11-01"))
            entry.bean = bean
            let brew = CupmarkSchemaV1.StoredBrew(localID: brewID, brewedAtMilliseconds: 1_000, methodID: try StoreFixtures.first(Vocabulary.Method.self).rawValue)
            brew.shelfEntry = entry
            brew.grindNormalised = 4.5
            context.insert(bean)
            context.insert(entry)
            context.insert(brew)
            context.insert(CupmarkSchemaV1.OutboxOperation(sequence: 1, resourceRaw: "bean", actionRaw: "create", localID: beanID))
            context.insert(CupmarkSchemaV1.OutboxOperation(sequence: 2, resourceRaw: "shelf_entry", actionRaw: "create", localID: entry.localID))
        }

        let store = try AccountStore.open(for: account, in: folder)

        XCTAssertEqual(try store.beans().map(\.localID), [beanID])
        XCTAssertEqual(try store.shelfEntries().first?.bean?.localID, beanID)
        XCTAssertEqual(try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }, [
            "create bean", "create shelf_entry",
        ])
        // The brew keeps its values, and has no grinder (the columns are new, M2-T26).
        let brew = try XCTUnwrap(try store.brew(localID: brewID))
        XCTAssertEqual(brew.grindNormalised, 4.5)
        XCTAssertNil(brew.grinder)
        XCTAssertNil(brew.grindSetting)
        // The new models and columns work in the migrated store.
        store.queueLabelPhoto(fileName: "label.jpg", beanLocalID: beanID)
        try store.save()
        XCTAssertEqual(try store.queuedLabelPhotoFileNames(), ["label.jpg"])
        brew.grinder = try XCTUnwrap(Vocabulary.Grinder.allCases.first { grinder in grinder.scale != nil })
        brew.grindSetting = try XCTUnwrap(brew.grinder?.scale?.minimum)
        try store.save()
        XCTAssertNotNil(try store.brew(localID: brewID)?.grinder)
    }

    func testAVersion2StoreOpensWithVersion3AndKeepsItsBrewsRecipesAndPhotos() throws {
        let folder = directory
        let account = AccountID(subject: AuthFixtures.subject)
        let brewID = UUID()
        let recipeID = UUID()
        let methodID = try StoreFixtures.first(Vocabulary.Method.self).rawValue
        try writeOldStore(Schema(versionedSchema: CupmarkSchemaV2.self), account: account) { context in
            let brew = CupmarkSchemaV1.StoredBrew(localID: brewID, brewedAtMilliseconds: 2_000, methodID: methodID)
            brew.doseDg = 180
            let recipe = CupmarkSchemaV1.StoredRecipe(localID: recipeID, methodID: methodID)
            recipe.waterG = 300
            context.insert(brew)
            context.insert(recipe)
            context.insert(CupmarkSchemaV2.QueuedLabelPhoto(beanLocalID: UUID(), fileName: "old.jpg"))
        }

        let store = try AccountStore.open(for: account, in: folder)

        let brew = try XCTUnwrap(try store.brew(localID: brewID))
        XCTAssertEqual(brew.doseDg, 180)
        XCTAssertNil(brew.grinder)
        XCTAssertNil(brew.grindSetting)
        let recipe = try XCTUnwrap(try store.recipe(localID: recipeID))
        XCTAssertEqual(recipe.waterG, 300)
        XCTAssertNil(recipe.grinderID)
        XCTAssertEqual(try store.queuedLabelPhotoFileNames(), ["old.jpg"])
    }

    func testAVersion2StoreOpensAgainWithItsQueuedPhotos() throws {
        let folder = directory
        let account = AccountID(subject: AuthFixtures.subject)
        do {
            let store = try AccountStore.open(for: account, in: folder)
            store.queueLabelPhoto(fileName: "label.jpg", beanLocalID: UUID())
            try store.save()
        }

        let reopened = try AccountStore.open(for: account, in: folder)

        XCTAssertEqual(try reopened.queuedLabelPhotoFileNames(), ["label.jpg"])
    }
}
