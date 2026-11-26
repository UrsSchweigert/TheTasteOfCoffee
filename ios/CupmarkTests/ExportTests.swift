import XCTest
@testable import Cupmark

/// Settings, then Export (M2-T30): the request, the file name, the bytes written unchanged,
/// the order of the steps, the pending-changes note and every error state.
@MainActor
final class ExportTests: XCTestCase {
    private var root: URL = FileManager.default.temporaryDirectory.appending(path: "ExportTests-\(UUID().uuidString)", directoryHint: .isDirectory)

    private var servers: [StubServer] = []

    override func tearDown() {
        servers.removeAll()
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    /// A CSV as the contract describes it: quoted fields, CRLF after every row. Followed by
    /// bytes that are not valid UTF-8, a NUL and a BOM, which a file written "as it is" keeps.
    private var csvBytes: Data {
        var data = Data("\"item_type\",\"locale\"\r\n\"profile\",\"de\"\r\n".utf8)
        data.append(contentsOf: [0xFF, 0x00, 0xEF, 0xBB, 0xBF, 0x0D, 0x0A])
        return data
    }

    private let day = Date(timeIntervalSince1970: 1_795_000_000) // 2026-11-18 11:06 UTC, the same day in Berlin and in UTC

    private func calendar(_ identifier: String) throws -> Calendar {
        try StoreFixtures.calendar(identifier)
    }

    private func makeModel(
        source: any ExportSource,
        drain: @escaping @MainActor () async -> SyncEngine.DrainResult = { .idle },
        pending: @escaping @MainActor () throws -> Int = { 0 },
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in },
        root: URL? = nil
    ) throws -> ExportModel {
        ExportModel(
            source: source,
            outbox: ExportOutbox(drain: drain, pendingChanges: pending),
            files: ExportFileStore(root: root ?? self.root),
            now: { [fixed = day] in fixed },
            calendar: try calendar("Europe/Berlin"),
            sleep: sleep
        )
    }

    private func readyFile(_ model: ExportModel, file: StaticString = #filePath, line: UInt = #line) throws -> ExportModel.ReadyFile {
        guard case .ready(let ready) = model.state else {
            XCTFail("expected a ready file, got \(model.state)", file: file, line: line)
            throw URLError(.unknown)
        }
        return ready
    }

    private func failure(_ model: ExportModel, file: StaticString = #filePath, line: UInt = #line) throws -> ExportModel.Failure {
        guard case .failed(let failure) = model.state else {
            XCTFail("expected a failure, got \(model.state)", file: file, line: line)
            throw URLError(.unknown)
        }
        return failure
    }

    private func apiSource(status: Int, body: Data = Data(), error: URLError? = nil) throws -> (StubServer, APIClient) {
        let server = try StubServer { _ in
            if let error {
                throw error
            }
            return StubResponse(status: status, body: body, headers: ["Content-Type": "text/csv; charset=utf-8; header=present"])
        }
        // The stub registry holds a server weakly and forgets its host when it is released, so
        // the test keeps every server alive until it ends; a caller that drops the returned
        // server would otherwise see "cannot find host" instead of the answer it set up.
        servers.append(server)
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        return (server, client)
    }

    // MARK: - The request

    func testItCallsGetExportWithTheTokenAndNothingElse() async throws {
        let (server, client) = try apiSource(status: 200, body: csvBytes)

        let model = try makeModel(source: client)
        await model.export()

        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/export")
        XCTAssertTrue(request.queryItems.isEmpty, "no query: the user is the token's subject")
        XCTAssertNil(request.body)
        XCTAssertEqual(request.header("Accept"), "text/csv")
        XCTAssertEqual(request.header("Authorization"), "Bearer access-token-1")
    }

    // MARK: - The file

    func testTheFileNameIsTheDayInTheDeviceCalendar() throws {
        // 2026-11-24 23:30 UTC is already the 25th in Berlin and still the 24th in UTC.
        let late = Date(timeIntervalSince1970: 1_795_563_000)
        XCTAssertEqual(ExportFileStore.fileName(for: late, calendar: try calendar("Europe/Berlin")), "cupmark-export-2026-11-25.csv")
        XCTAssertEqual(ExportFileStore.fileName(for: late, calendar: try calendar("UTC")), "cupmark-export-2026-11-24.csv")
        XCTAssertEqual(
            ExportFileStore.fileName(for: Date(timeIntervalSince1970: 1_767_225_600), calendar: try calendar("UTC")),
            "cupmark-export-2026-01-01.csv"
        )
    }

    func testTheBytesAreWrittenUnchangedToAFileWithThatName() async throws {
        let (_, client) = try apiSource(status: 200, body: csvBytes)

        let model = try makeModel(source: client)
        await model.export()

        let ready = try readyFile(model)
        XCTAssertEqual(ready.url.lastPathComponent, "cupmark-export-2026-11-18.csv")
        XCTAssertEqual(try Data(contentsOf: ready.url), csvBytes)
        XCTAssertTrue(ready.url.standardizedFileURL.path(percentEncoded: false).hasPrefix(root.standardizedFileURL.path(percentEncoded: false)))
        XCTAssertFalse(ready.hasPendingChanges)
    }

    func testAnEmptyExportIsStillAFile() async throws {
        let model = try makeModel(source: FakeExportSource(.success(Data())))
        await model.export()

        let ready = try readyFile(model)
        XCTAssertEqual(try Data(contentsOf: ready.url), Data())
    }

    func testTheFileIsDeletedWhenTheUserIsDone() async throws {
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)))
        await model.export()
        let url = try readyFile(model).url
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))

        model.discardFile()

        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path(percentEncoded: false)))
        XCTAssertEqual(model.state, .idle)
    }

    func testANewExportDeletesTheEarlierFileAndLeftovers() async throws {
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)))
        await model.export()
        let first = try readyFile(model).url
        let leftover = root.appending(path: "left-by-an-ended-app", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: leftover, withIntermediateDirectories: true)

        await model.export()

        let second = try readyFile(model).url
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path(percentEncoded: false)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path(percentEncoded: false)))
        XCTAssertEqual(try Data(contentsOf: second), csvBytes)
    }

    func testBuildingAModelDeletesNothing() async throws {
        // SwiftUI may build a model more than once; a file being shared must survive it.
        let source = FakeExportSource(.success(csvBytes))
        let first = try makeModel(source: source)
        await first.export()
        let url = try readyFile(first).url

        _ = try makeModel(source: source)

        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
    }

    func testOnlyAFileUnderTheRootIsEverDeleted() throws {
        let elsewhere = FileManager.default.temporaryDirectory.appending(path: "ExportTests-other-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: elsewhere) }
        let file = elsewhere.appending(path: "keep.csv", directoryHint: .notDirectory)
        try Data("x".utf8).write(to: file)

        ExportFileStore(root: root).remove(file)

        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
    }

    // MARK: - The steps

    func testTheOutboxIsDrainedBeforeTheRequest() async throws {
        let log = CallLog()
        let source = FakeExportSource(.success(csvBytes), log: log)

        let model = try makeModel(source: source, drain: {
            log.append("drain")
            return .idle
        }, pending: {
            log.append("pending")
            return 0
        })
        await model.export()

        XCTAssertEqual(log.entries, ["drain", "export", "pending"])
    }

    func testChangesStillPendingAreSaidToBeNotInTheFile() async throws {
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), drain: { .waiting(until: Date.distantFuture) }, pending: { 2 })
        await model.export()

        XCTAssertTrue(try readyFile(model).hasPendingChanges)
    }

    func testAnUnreadableOutboxCountsAsPending() async throws {
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), pending: { throw LocalStoreError.emptyAccountID })
        await model.export()

        XCTAssertTrue(try readyFile(model).hasPendingChanges)
    }

    func testAnEmptyOutboxHasNoNote() async throws {
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), pending: { 0 })
        await model.export()

        XCTAssertFalse(try readyFile(model).hasPendingChanges)
    }

    func testABusyDrainIsAskedAgainAfterASecond() async throws {
        let results = ResultQueue([.busy, .busy, .idle])
        let sleeps = CallLog()

        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), drain: { results.next() }, sleep: { seconds in
            sleeps.append("sleep \(seconds)")
        })
        await model.export()

        XCTAssertEqual(results.calls, 3)
        XCTAssertEqual(sleeps.entries, ["sleep 1.0", "sleep 1.0"])
        XCTAssertNotNil(try? readyFile(model))
    }

    func testADrainThatStaysBusyDoesNotHoldTheExportForever() async throws {
        let results = ResultQueue([.busy])
        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), drain: { results.next() }, pending: { 1 })
        await model.export()

        XCTAssertEqual(results.calls, ExportModel.busyRetries + 1)
        XCTAssertTrue(try readyFile(model).hasPendingChanges)
    }

    func testTheRealOutboxIsSentBeforeTheRequest() async throws {
        let server = try FakeSyncServer()
        let csv = csvBytes
        server.backend.setOverride { request in
            request.path == "/export" ? StubResponse(status: 200, body: csv) : nil
        }
        let store = try AccountStore.inMemory()
        _ = try store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: false)))
        XCTAssertEqual(try store.outboxOperations().count, 1)
        let engine = SyncEngine(store: store, client: server.client(), sleep: { _ in })

        let model = ExportModel(
            source: server.client(),
            outbox: .live(engine: engine, store: store),
            files: ExportFileStore(root: root),
            now: { [fixed = day] in fixed },
            calendar: try calendar("UTC"),
            sleep: { _ in }
        )
        await model.export()

        XCTAssertEqual(server.log, ["PUT /profile", "GET /export"])
        XCTAssertFalse(try readyFile(model).hasPendingChanges)
        XCTAssertEqual(try store.outboxOperations().count, 0)
    }

    func testAParkedChangeStaysPendingInTheRealOutbox() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { request in
            switch request.path {
            case "/export": return StubResponse(status: 200, body: Data("\"item_type\"\r\n".utf8))
            case "/profile": return StubResponse(status: 400)
            default: return nil
            }
        }
        let store = try AccountStore.inMemory()
        _ = try store.setProfile(API.Profile(locale: VocabularyLanguage.fallback, consent: API.Consent(contributeToAggregates: false)))
        let engine = SyncEngine(store: store, client: server.client(), sleep: { _ in })

        let model = ExportModel(
            source: server.client(),
            outbox: .live(engine: engine, store: store),
            files: ExportFileStore(root: root),
            sleep: { _ in }
        )
        await model.export()

        XCTAssertTrue(try readyFile(model).hasPendingChanges, "a refused change is not on the server")
    }

    // MARK: - Error states

    func testA500IsTheSizeLimitMessageAndWritesNoFile() async throws {
        let (_, client) = try apiSource(status: 500)

        let model = try makeModel(source: client)
        await model.export()

        XCTAssertEqual(try failure(model), .tooLarge)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path(percentEncoded: false)))
    }

    func testBeingOfflineIsItsOwnMessage() async throws {
        for code in [URLError.Code.notConnectedToInternet, .networkConnectionLost, .timedOut, .dataNotAllowed] {
            let (_, client) = try apiSource(status: 200, error: URLError(code))
            let model = try makeModel(source: client)
            await model.export()
            XCTAssertEqual(try failure(model), .offline, "\(code)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path(percentEncoded: false)))
    }

    func testOtherStatusesHaveTheirOwnStates() async throws {
        let cases: [(Int, ExportModel.Failure)] = [
            (401, .signInRequired),
            (429, .tooManyRequests),
            (503, .unavailable),
            (502, .unavailable),
            (504, .unavailable),
            (403, .unavailable),
        ]
        for (status, expected) in cases {
            let (_, client) = try apiSource(status: status)
            let model = try makeModel(source: client)
            await model.export()
            XCTAssertEqual(try failure(model), expected, "status \(status)")
        }
    }

    func testAFileThatCannotBeWrittenIsAFailureNotACrash() async throws {
        // The root lies under a regular file, so no folder can be made there. (The root itself
        // cannot be the file: `export()` clears the root first, which would remove that file.)
        let blocker = FileManager.default.temporaryDirectory.appending(path: "ExportTests-blocker-\(UUID().uuidString)", directoryHint: .notDirectory)
        try Data("x".utf8).write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let underFile = blocker.appending(path: "CupmarkExport", directoryHint: .isDirectory)

        let model = try makeModel(source: FakeExportSource(.success(csvBytes)), root: underFile)
        await model.export()

        XCTAssertEqual(try failure(model), .fileNotWritten)
    }

    func testAFailureCanBeRetried() async throws {
        let source = FakeExportSource(.failure(APIError.transport(.notConnectedToInternet)))
        let model = try makeModel(source: source)
        await model.export()
        XCTAssertEqual(try failure(model), .offline)

        source.result = .success(csvBytes)
        await model.export()

        XCTAssertEqual(try Data(contentsOf: try readyFile(model).url), csvBytes)
    }

    func testACancelledExportEndsIdle() async throws {
        let model = try makeModel(source: FakeExportSource(.failure(CancellationError())))
        await model.export()

        XCTAssertEqual(model.state, .idle)
    }

    func testTheErrorMapping() {
        XCTAssertEqual(ExportModel.failure(for: .server(status: 500)), .tooLarge)
        XCTAssertEqual(ExportModel.failure(for: .transport(.notConnectedToInternet)), .offline)
        XCTAssertEqual(ExportModel.failure(for: .unauthorized), .signInRequired)
        XCTAssertEqual(ExportModel.failure(for: .tooManyRequests), .tooManyRequests)
        XCTAssertEqual(ExportModel.failure(for: .serviceUnavailable), .unavailable)
        XCTAssertEqual(ExportModel.failure(for: .server(status: 502)), .unavailable)
        XCTAssertEqual(ExportModel.failure(for: .invalidResponse), .unavailable)
    }
}

// MARK: - Fakes

private final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func append(_ entry: String) {
        lock.withLock { values.append(entry) }
    }

    var entries: [String] { lock.withLock { values } }
}

/// Answers `drain()` from a list; the last answer repeats.
@MainActor
private final class ResultQueue {
    private var results: [SyncEngine.DrainResult]
    private(set) var calls = 0

    init(_ results: [SyncEngine.DrainResult]) {
        self.results = results
    }

    func next() -> SyncEngine.DrainResult {
        calls += 1
        return results.count > 1 ? results.removeFirst() : (results.first ?? .idle)
    }
}

private final class FakeExportSource: ExportSource, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Result<Data, any Error>
    private let log: CallLog?

    init(_ result: Result<Data, any Error>, log: CallLog? = nil) {
        current = result
        self.log = log
    }

    var result: Result<Data, any Error> {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }

    func exportData() async throws -> Data {
        log?.append("export")
        return try result.get()
    }
}
