import SwiftData
import XCTest
@testable import Cupmark

/// Schema versions 2 (M2-T25), 3 (M2-T26) and 4 (M2-T42): a store written with version 1, 2 or 3
/// opens with the current schema, keeps its items and its outbox, and takes the new label photo
/// queue, the grinder columns and the brew photos.
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
    /// of that schema, named by their version (the current aliases may belong to a later one).
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

    /// Version 4 (M2-T42, ADR 0033): a store file written with version 3's schema opens with the
    /// current one through the lightweight stage, keeps every brew, recipe, outbox operation and
    /// queued label photo, has an empty photo list, and takes brew photos.
    func testAVersion3StoreOpensWithVersion4AndKeepsEveryBrewWithAnEmptyPhotoList() throws {
        let folder = directory
        let account = AccountID(subject: AuthFixtures.subject)
        let brewIDs = [UUID(), UUID(), UUID()]
        let recipeID = UUID()
        let methodID = try StoreFixtures.first(Vocabulary.Method.self).rawValue
        let grinder = try XCTUnwrap(Vocabulary.Grinder.allCases.first { grinder in grinder.scale != nil })
        try writeOldStore(Schema(versionedSchema: CupmarkSchemaV3.self), account: account) { context in
            let bean = CupmarkSchemaV3.StoredBean(barcode: "4006381333931")
            let entry = CupmarkSchemaV3.StoredShelfEntry(purchaseDate: try StoreFixtures.day("2026-11-01"))
            context.insert(bean)
            context.insert(entry)
            entry.bean = bean
            for (index, brewID) in brewIDs.enumerated() {
                let brew = CupmarkSchemaV3.StoredBrew(localID: brewID, brewedAtMilliseconds: Int64(3_000 + index), methodID: methodID)
                brew.doseDg = 180 + index
                brew.grinderID = grinder.rawValue
                context.insert(brew)
                brew.shelfEntry = entry
            }
            let recipe = CupmarkSchemaV3.StoredRecipe(localID: recipeID, methodID: methodID)
            recipe.waterG = 250
            context.insert(recipe)
            context.insert(CupmarkSchemaV1.OutboxOperation(sequence: 1, resourceRaw: "brew", actionRaw: "create", localID: brewIDs[0]))
            context.insert(CupmarkSchemaV2.QueuedLabelPhoto(beanLocalID: bean.localID, fileName: "label.jpg"))
        }
        let photos = BrewPhotoFolders(root: folder.appending(path: "BrewPhotos", directoryHint: .isDirectory))

        let store = try AccountStore.open(for: account, in: folder, brewPhotos: photos)

        XCTAssertEqual(Set(try store.brewsNewestFirst().map(\.localID)), Set(brewIDs))
        for (index, brewID) in brewIDs.enumerated() {
            let brew = try XCTUnwrap(try store.brew(localID: brewID))
            XCTAssertEqual(brew.doseDg, 180 + index)
            XCTAssertEqual(brew.grinder, grinder)
            XCTAssertEqual(brew.shelfEntry?.bean?.barcode, "4006381333931")
            XCTAssertEqual(try store.brewPhotos(of: brew).count, 0)
        }
        XCTAssertEqual(try store.recipe(localID: recipeID)?.waterG, 250)
        XCTAssertEqual(try store.outboxOperations().map(\.localID), [brewIDs[0]])
        XCTAssertEqual(try store.queuedLabelPhotoFileNames(), ["label.jpg"])
        XCTAssertTrue(try store.allBrewPhotos().isEmpty)
        // The new model works in the migrated store, and opens again.
        let brew = try XCTUnwrap(try store.brew(localID: brewIDs[1]))
        let added = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.start)
        XCTAssertEqual(try store.brewPhotos(of: brew).map(\.localID), [added.localID])
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
