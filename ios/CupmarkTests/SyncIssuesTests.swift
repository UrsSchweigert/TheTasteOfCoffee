import SwiftData
import XCTest
@testable import Cupmark

/// Parked and flagged items and their redo and discard (M2-T18, ADR 0025), with the real
/// `SyncEngine` against `FakeSyncServer`: a 400 on a create, an update and a delete, a
/// 404-then-200 on `PUT`, a restored delete, a reverted bean change and a parked reference.
@MainActor
final class SyncIssuesTests: XCTestCase {
    /// Answers the first matching request itself, then lets the fake answer.
    private final class FirstAnswer: @unchecked Sendable {
        private let lock = NSLock()
        private var used = false
        private let method: String
        private let pathPrefix: String
        private let status: Int

        init(_ method: String, _ pathPrefix: String, status: Int) {
            self.method = method
            self.pathPrefix = pathPrefix
            self.status = status
        }

        func answer(_ request: RecordedRequest) -> StubResponse? {
            lock.withLock {
                guard !used, request.method == method, request.path.hasPrefix(pathPrefix) else {
                    return nil
                }
                used = true
                return StubResponse(status: status)
            }
        }
    }

    private struct Harness {
        let store: AccountStore
        let server: FakeSyncServer
        let engine: SyncEngine
    }

    private func makeHarness() throws -> Harness {
        let store = try AccountStore.inMemory()
        let server = try FakeSyncServer()
        let engine = SyncEngine(store: store, client: server.client(), jitter: { 1 }, sleep: { _ in })
        return Harness(store: store, server: server, engine: engine)
    }

    private func failFirst(_ harness: Harness, _ method: String, _ pathPrefix: String, status: Int) {
        let first = FirstAnswer(method, pathPrefix, status: status)
        harness.server.backend.setOverride { request in first.answer(request) }
    }

    private func id(_ n: Int) -> String {
        FakeSyncBackend.id(n)
    }

    private func serverBean(_ beanID: String) -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: nil,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: API.BeanAttributes(),
            operatorAttributes: API.BeanAttributes()
        )
    }

    private func shelfValues(beanID: String) throws -> API.ShelfEntryInput {
        var values = try StoreFixtures.shelfEntryInput()
        values.beanId = beanID
        return values
    }

    /// A bean on the server and, synced, on the device.
    private func syncedBean(_ harness: Harness, _ n: Int = 901) throws -> StoredBean {
        let bean = serverBean(id(n))
        harness.server.backend.seed(bean: bean)
        let local = StoredBean(bean)
        try harness.store.addBean(local, syncState: .synced)
        return local
    }

    /// A bean and a shelf entry on the server, and the same, synced, on the device.
    private func syncedShelfEntry(_ harness: Harness) throws -> StoredShelfEntry {
        let bean = try syncedBean(harness)
        let values = try shelfValues(beanID: id(901))
        harness.server.backend.seed(shelfEntry: id(902), values)
        let entry = StoredShelfEntry(values, serverID: id(902))
        try harness.store.addShelfEntry(entry, bean: bean, syncState: .synced)
        return entry
    }

    /// A shelf entry made on the device whose create the server refused (400).
    private func rejectedNewEntry(_ harness: Harness) async throws -> StoredShelfEntry {
        let bean = try syncedBean(harness)
        let entry = StoredShelfEntry(try shelfValues(beanID: id(901)))
        try harness.store.addShelfEntry(entry, bean: bean)
        failFirst(harness, "POST", "/shelf", status: 400)
        await drainToIdle(harness)
        return entry
    }

    /// Sends until nothing is left that is not parked.
    private func drainToIdle(_ harness: Harness, file: StaticString = #filePath, line: UInt = #line) async {
        let result = await harness.engine.drain()
        XCTAssertEqual(result, .idle, file: file, line: line)
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in
            "\(operation.actionRaw) \(operation.resourceRaw)\(operation.parked ? " parked" : "")"
        }
    }

    private func onlyIssue(_ store: AccountStore) throws -> SyncIssueItem {
        let issues = try store.syncIssues()
        XCTAssertEqual(issues.count, 1, "\(issues)")
        return try XCTUnwrap(issues.first)
    }

    // MARK: - Rejected create

    func testARejectedCreateIsListedAndRedoSendsItAgain() async throws {
        let harness = try makeHarness()
        let entry = try await rejectedNewEntry(harness)
        XCTAssertEqual(entry.syncIssue, .rejected)
        XCTAssertEqual(try queue(harness.store), ["create shelf_entry parked"])

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.resource, .shelfEntry)
        XCTAssertEqual(issue.localID, entry.localID)
        XCTAssertEqual(issue.kind, .parked(.create, .rejected))
        XCTAssertTrue(issue.isParked)
        XCTAssertTrue(issue.allowsDiscard)

        try harness.store.redo(issue)

        XCTAssertNil(entry.syncIssue)
        let operation = try XCTUnwrap(harness.store.outboxOperations().first)
        XCTAssertFalse(operation.parked)
        XCTAssertNil(operation.parkReason)
        XCTAssertEqual(operation.attemptCount, 0)
        XCTAssertEqual(operation.nextAttemptAt, Date.distantPast)
        XCTAssertEqual(try harness.store.syncIssues(), [])

        await drainToIdle(harness)
        XCTAssertEqual(try queue(harness.store), [])
        XCTAssertEqual(entry.syncState, .synced)
        let serverID = try XCTUnwrap(entry.serverID)
        XCTAssertEqual(harness.server.backend.shelfEntries[serverID], try entry.apiInput())
    }

    func testDiscardingARejectedCreateRemovesTheItem() async throws {
        let harness = try makeHarness()
        let entry = try await rejectedNewEntry(harness)
        let localID = entry.localID

        try harness.store.discard(try onlyIssue(harness.store))

        XCTAssertNil(try harness.store.shelfEntry(localID: localID))
        XCTAssertEqual(try queue(harness.store), [])
        XCTAssertEqual(try harness.store.syncIssues(), [])
        XCTAssertEqual(try harness.store.beans().count, 1, "the cached bean stays")
    }

    func testARejectedCreateWithBrewsCannotBeDiscarded() async throws {
        let harness = try makeHarness()
        let entry = try await rejectedNewEntry(harness)
        let brew = try StoredBrew(try StoreFixtures.brewInput())
        try harness.store.addBrew(brew, shelfEntry: entry)

        let issue = try XCTUnwrap(harness.store.syncIssues().first { item in item.localID == entry.localID })
        XCTAssertEqual(issue.discardBlock, .shelfEntryHasBrews)
        XCTAssertFalse(issue.allowsDiscard)
        XCTAssertThrowsError(try harness.store.discard(issue)) { error in
            XCTAssertEqual(error as? LocalStoreError, .shelfEntryHasBrews)
        }
        XCTAssertNotNil(try harness.store.shelfEntry(localID: entry.localID))

        let model = SyncIssuesModel(store: harness.store)
        model.reload()
        XCTAssertFalse(model.discard(issue))
        XCTAssertEqual(model.failure, .discardBlocked(.shelfEntryHasBrews))
    }

    // MARK: - Rejected update (400, and 404 then 200)

    func testARejectedUpdateIsDiscardedAndThePullBringsTheServerValuesBack() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let serverValues = try entry.apiInput()
        entry.bagSizeID = try StoreFixtures.last(Vocabulary.BagSize.self).rawValue
        try harness.store.markUpdated(entry)
        failFirst(harness, "PUT", "/shelf/", status: 400)
        await drainToIdle(harness)

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.kind, .parked(.update, .rejected))
        XCTAssertTrue(issue.allowsDiscard)

        try harness.store.discard(issue)

        XCTAssertNotNil(try harness.store.shelfEntry(localID: entry.localID), "the item stays, only the change goes")
        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertNil(entry.syncIssue)
        XCTAssertEqual(try queue(harness.store), [])
        let result = await Puller(store: harness.store, client: harness.server.client()).pull()
        guard case .completed = result else {
            return XCTFail("pull: \(result)")
        }
        XCTAssertEqual(try entry.apiInput(), serverValues)
    }

    func testA404Then200OnAPutIsParkedAndRedoSendsTheChange() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        entry.bagSizeID = try StoreFixtures.last(Vocabulary.BagSize.self).rawValue
        try harness.store.markUpdated(entry)
        failFirst(harness, "PUT", "/shelf/", status: 404)
        await drainToIdle(harness)
        XCTAssertTrue(harness.server.log.contains("GET /shelf/\(id(902))"), "the engine read the item")

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.kind, .parked(.update, .rejected))
        try harness.store.redo(issue)
        await drainToIdle(harness)

        XCTAssertEqual(try queue(harness.store), [])
        XCTAssertEqual(harness.server.backend.shelfEntries[id(902)]?.bagSize, try StoreFixtures.last(Vocabulary.BagSize.self))
        XCTAssertEqual(entry.syncState, .synced)
    }

    // MARK: - Rejected delete (still pendingDelete)

    func testARejectedDeleteIsListedWhileHiddenAndDiscardBringsItBack() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        try harness.store.markDeleted(entry)
        failFirst(harness, "DELETE", "/shelf/", status: 400)
        await drainToIdle(harness)
        XCTAssertEqual(entry.syncState, .pendingDelete)
        XCTAssertTrue(try harness.store.shelfEntries().isEmpty, "hidden from the shelf")

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.kind, .parked(.delete, .rejected))
        XCTAssertTrue(issue.allowsDiscard, "discard keeps the item, so brews do not block it")

        try harness.store.discard(issue)

        XCTAssertEqual(entry.syncState, .synced)
        XCTAssertNil(entry.syncIssue)
        XCTAssertEqual(try harness.store.shelfEntries().map(\.localID), [entry.localID])
        XCTAssertEqual(try queue(harness.store), [])
        XCTAssertNotNil(harness.server.backend.shelfEntries[id(902)])
    }

    func testRedoingARejectedDeleteRemovesTheItemOnTheServerAndHere() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        let localID = entry.localID
        try harness.store.markDeleted(entry)
        failFirst(harness, "DELETE", "/shelf/", status: 400)
        await drainToIdle(harness)

        try harness.store.redo(try onlyIssue(harness.store))
        await drainToIdle(harness)

        XCTAssertNil(try harness.store.shelfEntry(localID: localID))
        XCTAssertNil(harness.server.backend.shelfEntries[id(902)])
        XCTAssertEqual(try harness.store.syncIssues(), [])
    }

    // MARK: - Flags only

    func testARestoredDeleteIsAFlagThatRedoClears() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        try harness.store.markDeleted(entry)
        failFirst(harness, "DELETE", "/shelf/", status: 409)
        await drainToIdle(harness)
        XCTAssertEqual(entry.syncIssue, .deleteRestored)
        XCTAssertEqual(try harness.store.shelfEntries().map(\.localID), [entry.localID])

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.kind, .flagged(.deleteRestored))
        XCTAssertFalse(issue.isParked)
        XCTAssertFalse(issue.allowsDiscard)

        try harness.store.redo(issue)

        XCTAssertNil(entry.syncIssue)
        XCTAssertEqual(try harness.store.syncIssues(), [])
        XCTAssertEqual(try harness.store.shelfEntries().map(\.localID), [entry.localID])
    }

    func testARevertedBeanChangeIsAFlagThatRedoOrDiscardClears() async throws {
        let harness = try makeHarness()
        let entry = try syncedShelfEntry(harness)
        // A brew on the server references the entry, so the bean change answers 409 (D14).
        var brew = try StoreFixtures.brewInput()
        brew.shelfEntryId = id(902)
        harness.server.backend.seed(brew: id(903), brew)
        let other = try syncedBean(harness, 904)
        entry.bean = other
        try harness.store.markUpdated(entry)
        await drainToIdle(harness)
        XCTAssertEqual(entry.bean?.serverID, id(901), "the server's bean is back")
        XCTAssertEqual(entry.syncIssue, .beanChangeReverted)

        let issue = try onlyIssue(harness.store)
        XCTAssertEqual(issue.kind, .flagged(.beanChangeReverted))
        try harness.store.discard(issue)
        XCTAssertNil(entry.syncIssue)
        XCTAssertEqual(try harness.store.syncIssues(), [])

        entry.syncIssue = .beanChangeReverted
        try harness.store.save()
        try harness.store.redo(try onlyIssue(harness.store))
        XCTAssertNil(entry.syncIssue)
    }

    // MARK: - References

    func testRedoingAnEntryAlsoRedoesItsParkedBean() async throws {
        let harness = try makeHarness()
        let bean = StoredBean(API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: nil,
            attributes: API.BeanAttributes(process: try StoreFixtures.first(Vocabulary.Process.self))
        ))
        try harness.store.addBean(bean)
        let entry = StoredShelfEntry(try StoreFixtures.shelfEntryInput())
        try harness.store.addShelfEntry(entry, bean: bean)
        failFirst(harness, "POST", "/beans", status: 400)
        await drainToIdle(harness)
        XCTAssertEqual(try queue(harness.store), ["create bean parked", "create shelf_entry parked"])

        let issues = try harness.store.syncIssues()
        XCTAssertEqual(issues.map(\.localID), [bean.localID, entry.localID], "in queue order")
        XCTAssertEqual(issues.first?.kind, .parked(.create, .rejected))
        XCTAssertEqual(issues.last?.kind, .parked(.create, .missingReference))
        XCTAssertEqual(issues.first?.discardBlock, .beanHasShelfEntries, "the entry still names the bean")

        let entryIssue = try XCTUnwrap(issues.last)
        try harness.store.redo(entryIssue)
        XCTAssertEqual(try queue(harness.store), ["create bean", "create shelf_entry"])
        XCTAssertNil(bean.syncIssue)
        XCTAssertNil(entry.syncIssue)

        await drainToIdle(harness)
        XCTAssertNotNil(bean.serverID)
        XCTAssertNotNil(entry.serverID)
        XCTAssertEqual(try harness.store.syncIssues(), [])
    }

    // MARK: - The screen's model

    func testTheModelListsEachIssueWithWhatItIsAbout() async throws {
        let harness = try makeHarness()
        let entry = try await rejectedNewEntry(harness)
        let model = SyncIssuesModel(store: harness.store)

        model.reload()

        XCTAssertEqual(model.rows.map(\.id), [entry.localID])
        guard case .shelfEntry(let summary, let purchaseDate) = model.rows.first?.subject else {
            return XCTFail("not a shelf entry: \(String(describing: model.rows.first?.subject))")
        }
        XCTAssertEqual(summary, ShelfBeanSummary(entry.bean))
        XCTAssertEqual(purchaseDate, entry.purchaseDate)

        let row = try XCTUnwrap(model.rows.first)
        XCTAssertTrue(model.redo(row.item))
        XCTAssertEqual(model.rows, [])
        XCTAssertNil(model.failure)
    }
}
