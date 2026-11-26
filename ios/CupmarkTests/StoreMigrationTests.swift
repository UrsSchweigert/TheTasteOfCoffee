import SwiftData
import XCTest
@testable import Cupmark

/// Schema version 2 (M2-T25): a store written with version 1 opens with the current schema,
/// keeps its items and its outbox, and takes the new label photo queue.
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

    func testAVersion1StoreOpensWithVersion2AndKeepsItsItemsAndOutbox() throws {
        let folder = directory
        let account = AccountID(subject: AuthFixtures.subject)
        let beanID: UUID
        do {
            // The store as a build of version 1 wrote it: no migration plan, version 1 only.
            let schema = Schema(versionedSchema: CupmarkSchemaV1.self)
            let configuration = ModelConfiguration(
                try StoreLocation.fileStem(for: account),
                schema: schema,
                url: try StoreLocation.fileURL(for: account, in: folder),
                allowsSave: true,
                cloudKitDatabase: .none
            )
            let old = AccountStore(container: try ModelContainer(for: schema, configurations: configuration))
            let bean = StoredBean(API.BeanCreate(vocabularyVersion: Vocabulary.version, barcode: "4006381333931", attributes: API.BeanAttributes()))
            try old.addBean(bean)
            let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
            try old.addShelfEntry(entry, bean: bean)
            beanID = bean.localID
        }

        let store = try AccountStore.open(for: account, in: folder)

        XCTAssertEqual(try store.beans().map(\.localID), [beanID])
        XCTAssertEqual(try store.shelfEntries().first?.bean?.localID, beanID)
        XCTAssertEqual(try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }, [
            "create bean", "create shelf_entry",
        ])
        // The new model works in the migrated store.
        store.queueLabelPhoto(fileName: "label.jpg", beanLocalID: beanID)
        try store.save()
        XCTAssertEqual(try store.queuedLabelPhotoFileNames(), ["label.jpg"])
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
