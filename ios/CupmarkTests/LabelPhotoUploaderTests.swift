import XCTest
@testable import Cupmark

/// `LabelPhotoUploader` (M2-T24, ADR 0016) with a fake API and a stub S3 transport: the three
/// steps, the multipart POST without the API token, and every status path of
/// `createLabelPhotoUpload`, the S3 POST and `completeLabelPhoto`.
final class LabelPhotoUploaderTests: XCTestCase {
    private var store = LabelPhotoFixtures.fileStore()

    override func tearDown() {
        try? FileManager.default.removeItem(at: store.directory)
        super.tearDown()
    }

    private func makeUploader(
        api: FakeLabelPhotoAPI,
        transport: StubPresignedPostTransport,
        now: Date = LabelPhotoFixtures.now
    ) -> LabelPhotoUploader {
        LabelPhotoUploader(
            api: api,
            transport: transport,
            files: store,
            now: { now },
            makeBoundary: { "CupmarkFormBoundaryTEST" }
        )
    }

    private func makeJob() throws -> LabelPhotoUploadJob {
        LabelPhotoUploadJob(beanID: try LabelPhotoFixtures.bean(), file: try store.write(LabelPhotoFixtures.jpeg))
    }

    private func photo(_ n: Int) throws -> ResourceID {
        try XCTUnwrap(ResourceID(LabelPhotoFixtures.photoID(n)))
    }

    // MARK: - The three steps

    func testAPhotoIsStartedPostedToS3AndCompleted() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.success(())])
        let transport = StubPresignedPostTransport([.success(204)])
        let job = try makeJob()

        let result = await makeUploader(api: api, transport: transport).run(job)

        XCTAssertEqual(result.outcome, .completed)
        let createCalls = await api.createCalls
        let completeCalls = await api.completeCalls
        XCTAssertEqual(createCalls, [try LabelPhotoFixtures.bean()])
        XCTAssertEqual(completeCalls, [try photo(1)])
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.request.url?.absoluteString, LabelPhotoFixtures.url)
        XCTAssertEqual(sent.first?.request.httpMethod, "POST")
    }

    func testTheFileIsDeletedAfterThe204() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.success(())])
        let job = try makeJob()
        XCTAssertTrue(LabelPhotoFixtures.fileExists(job.file))

        _ = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(job)

        XCTAssertFalse(LabelPhotoFixtures.fileExists(job.file))
    }

    func testTheS3PostIsMultipartWithEveryFieldAndTheFileLast() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.success(())])
        let transport = StubPresignedPostTransport()

        _ = await makeUploader(api: api, transport: transport).run(try makeJob())

        let sentAll = await transport.sent
        let sent = try XCTUnwrap(sentAll.first)
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=CupmarkFormBoundaryTEST")
        let parts = try MultipartParser.parse(sent.body, boundary: "CupmarkFormBoundaryTEST")
        XCTAssertEqual(parts.map(\.name), [
            "key", "bucket", "Content-Type", "Policy", "X-Amz-Algorithm", "X-Amz-Credential",
            "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Signature", "file",
        ])
        XCTAssertEqual(String(decoding: parts[0].content, as: UTF8.self), "uploads/\(LabelPhotoFixtures.photoID(1)).jpg")
        XCTAssertEqual(parts.last?.content, LabelPhotoFixtures.jpeg)
        XCTAssertEqual(parts.last?.headers.last, "Content-Type: image/jpeg")
    }

    func testTheS3PostCarriesNoBearerToken() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.success(())])
        let transport = StubPresignedPostTransport()

        _ = await makeUploader(api: api, transport: transport).run(try makeJob())

        let sentAll = await transport.sent
        let sent = try XCTUnwrap(sentAll.first)
        XCTAssertNil(sent.request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(sent.request.allHTTPHeaderFields?.values.contains { $0.contains("Bearer") } ?? false)
        XCTAssertNil(sent.body.range(of: Data("Bearer".utf8)))
    }

    func testTheAPICallsCarryTheTokenAndTheS3PostDoesNot() async throws {
        // The live `APIClient` against a URLProtocol stub, the S3 side through the stub transport.
        let upload = try JSONEncoder().encode(try LabelPhotoFixtures.upload(1))
        let server = try StubServer { request in
            request.path.hasSuffix("/label_photos") ? StubResponse(status: 201, body: upload) : StubResponse(status: 204)
        }
        let client = APIClient(
            baseURL: server.baseURL,
            tokenProvider: FakeTokenProvider(),
            session: server.makeSession(),
            imageCache: nil
        )
        let transport = StubPresignedPostTransport()
        let uploader = LabelPhotoUploader(api: client, transport: transport, files: store, now: { LabelPhotoFixtures.now })

        let result = await uploader.run(try makeJob())

        XCTAssertEqual(result.outcome, .completed)
        XCTAssertEqual(server.requests.map(\.path), [
            "/beans/\(LabelPhotoFixtures.beanID)/label_photos",
            "/label_photos/\(LabelPhotoFixtures.photoID(1))/complete",
        ])
        XCTAssertEqual(server.requests.map { $0.header("Authorization") }, ["Bearer access-token-1", "Bearer access-token-1"])
        let sentAll = await transport.sent
        let sent = try XCTUnwrap(sentAll.first)
        XCTAssertNil(sent.request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(sent.body.range(of: Data("access-token-1".utf8)))
    }

    // MARK: - Upload URL

    func testNothingIsSentToAURLOutsideTheContract() async throws {
        let foreign = try LabelPhotoFixtures.upload(1, url: "https://attacker.example.com/", bucket: "cupmark-dev-photos-123456789012")
        let api = FakeLabelPhotoAPI(create: [.success(foreign)])
        let transport = StubPresignedPostTransport()
        let job = try makeJob()

        let result = await makeUploader(api: api, transport: transport).run(job)

        XCTAssertEqual(result.outcome, .failed)
        XCTAssertEqual(result.job.stage, .notStarted)
        let sent = await transport.sent
        XCTAssertTrue(sent.isEmpty)
        let completeCalls = await api.completeCalls
        XCTAssertTrue(completeCalls.isEmpty)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(job.file))
    }

    func testNothingIsSentToAnotherRegion() async throws {
        let foreign = try LabelPhotoFixtures.upload(1, url: "https://cupmark-dev-photos-123456789012.s3.us-east-1.amazonaws.com/")
        let transport = StubPresignedPostTransport()

        let result = await makeUploader(api: FakeLabelPhotoAPI(create: [.success(foreign)]), transport: transport).run(try makeJob())

        XCTAssertEqual(result.outcome, .failed)
        let sent = await transport.sent
        XCTAssertTrue(sent.isEmpty)
    }

    // MARK: - Expiry and 404: a new upload

    func testAnExpiredPresignedPostStartsANewUpload() async throws {
        let api = FakeLabelPhotoAPI(
            create: [.success(try LabelPhotoFixtures.upload(1, expiresIn: -1)), .success(try LabelPhotoFixtures.upload(2))],
            complete: [.success(())]
        )
        let transport = StubPresignedPostTransport()

        let result = await makeUploader(api: api, transport: transport).run(try makeJob())

        XCTAssertEqual(result.outcome, .completed)
        let createCalls = await api.createCalls
        XCTAssertEqual(createCalls.count, 2)
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 1)
        let parts = try MultipartParser.parse(try XCTUnwrap(sent.first).body, boundary: "CupmarkFormBoundaryTEST")
        XCTAssertEqual(String(decoding: parts[0].content, as: UTF8.self), "uploads/\(LabelPhotoFixtures.photoID(2)).jpg")
        let completeCalls = await api.completeCalls
        XCTAssertEqual(completeCalls, [try photo(2)])
    }

    func testAPresignedPostAboutToExpireIsNotUsed() async throws {
        let api = FakeLabelPhotoAPI(
            create: [.success(try LabelPhotoFixtures.upload(1, expiresIn: 10)), .success(try LabelPhotoFixtures.upload(2))],
            complete: [.success(())]
        )

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(try makeJob())

        XCTAssertEqual(result.outcome, .completed)
        let completeCalls = await api.completeCalls
        XCTAssertEqual(completeCalls, [try photo(2)])
    }

    func testAnS3403StartsANewUpload() async throws {
        let api = FakeLabelPhotoAPI(
            create: [.success(try LabelPhotoFixtures.upload(1)), .success(try LabelPhotoFixtures.upload(2))],
            complete: [.success(())]
        )
        let transport = StubPresignedPostTransport([.success(403), .success(204)])

        let result = await makeUploader(api: api, transport: transport).run(try makeJob())

        XCTAssertEqual(result.outcome, .completed)
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 2)
        let completeCalls = await api.completeCalls
        XCTAssertEqual(completeCalls, [try photo(2)])
    }

    func testA404OnCompletionStartsANewUpload() async throws {
        let api = FakeLabelPhotoAPI(
            create: [.success(try LabelPhotoFixtures.upload(1)), .success(try LabelPhotoFixtures.upload(2))],
            complete: [.failure(.notFound), .success(())]
        )
        let transport = StubPresignedPostTransport()
        let job = try makeJob()

        let result = await makeUploader(api: api, transport: transport).run(job)

        XCTAssertEqual(result.outcome, .completed)
        let completeCalls = await api.completeCalls
        XCTAssertEqual(completeCalls, [try photo(1), try photo(2)])
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 2)
        XCTAssertFalse(LabelPhotoFixtures.fileExists(job.file))
    }

    func testNewUploadsAreBoundedPerRun() async throws {
        let api = FakeLabelPhotoAPI(
            create: try (1...5).map { n in Result<API.LabelPhotoUpload, APIError>.success(try LabelPhotoFixtures.upload(n)) },
            complete: Array(repeating: .failure(.notFound), count: 5)
        )
        let job = try makeJob()

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(job)

        XCTAssertEqual(result.outcome, .failed)
        let createCalls = await api.createCalls
        XCTAssertEqual(createCalls.count, LabelPhotoUploader.maxUploadsPerRun)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(job.file))
    }

    // MARK: - Completion statuses

    func testA400OnCompletionRejectsThePhoto() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.badRequest)])

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(try makeJob())

        XCTAssertEqual(result.outcome, .rejected)
        XCTAssertEqual(result.job.stage, .notStarted)
        let createCalls = await api.createCalls
        XCTAssertEqual(createCalls.count, 1)
    }

    func testA409OnCompletionMeansNoMorePhotos() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.conflict)])

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(try makeJob())

        XCTAssertEqual(result.outcome, .noMorePhotos)
    }

    func testA429OnCompletionIsTheDailyLimit() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.tooManyRequests)])
        let job = try makeJob()

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(job)

        XCTAssertEqual(result.outcome, .dailyLimitReached)
        XCTAssertTrue(LabelPhotoFixtures.fileExists(job.file))
    }

    func testA401OnCompletionAsksToSignInAndKeepsTheUpload() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.unauthorized)])

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport()).run(try makeJob())

        XCTAssertEqual(result.outcome, .signInRequired)
        XCTAssertEqual(result.job.stage, .uploaded(photoID: try photo(1), completionUnconfirmed: false))
    }

    func testAFailedCompletionIsRetriedWithoutANewUpload() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.transport(.notConnectedToInternet))])
        let transport = StubPresignedPostTransport()
        let uploader = makeUploader(api: api, transport: transport)
        let job = try makeJob()

        let first = await uploader.run(job)
        XCTAssertEqual(first.outcome, .failed)
        XCTAssertEqual(first.job.stage, .uploaded(photoID: try photo(1), completionUnconfirmed: true))

        await api.setComplete([.success(())])
        let second = await uploader.run(first.job)

        XCTAssertEqual(second.outcome, .completed)
        let createCalls = await api.createCalls
        XCTAssertEqual(createCalls.count, 1)
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(LabelPhotoFixtures.fileExists(job.file))
    }

    func testA409AfterAnUnconfirmedCompletionCountsAsCompleted() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.failure(.transport(.networkConnectionLost))])
        let uploader = makeUploader(api: api, transport: StubPresignedPostTransport())
        let job = try makeJob()
        let first = await uploader.run(job)

        await api.setComplete([.failure(.conflict)])
        let second = await uploader.run(first.job)

        XCTAssertEqual(second.outcome, .completed)
        XCTAssertFalse(LabelPhotoFixtures.fileExists(job.file))
    }

    // MARK: - S3 statuses

    func testAFailedS3PostIsRetriedWithTheSamePresignedPost() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))], complete: [.success(())])
        let transport = StubPresignedPostTransport([.failure(.transport(.timedOut))])
        let uploader = makeUploader(api: api, transport: transport)

        let first = await uploader.run(try makeJob())
        XCTAssertEqual(first.outcome, .failed)
        XCTAssertEqual(first.job.stage, .issued(try LabelPhotoFixtures.upload(1)))

        let second = await uploader.run(first.job)

        XCTAssertEqual(second.outcome, .completed)
        let createCalls = await api.createCalls
        XCTAssertEqual(createCalls.count, 1)
        let sent = await transport.sent
        XCTAssertEqual(sent.count, 2)
    }

    func testAnS35xxFails() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))])

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport([.success(503)])).run(try makeJob())

        XCTAssertEqual(result.outcome, .failed)
        let completeCalls = await api.completeCalls
        XCTAssertTrue(completeCalls.isEmpty)
    }

    func testAnS3400RejectsThePhoto() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))])

        let result = await makeUploader(api: api, transport: StubPresignedPostTransport([.success(400)])).run(try makeJob())

        XCTAssertEqual(result.outcome, .rejected)
        let completeCalls = await api.completeCalls
        XCTAssertTrue(completeCalls.isEmpty)
    }

    func testAMissingFileIsRejectedWithoutAPost() async throws {
        let api = FakeLabelPhotoAPI(create: [.success(try LabelPhotoFixtures.upload(1))])
        let transport = StubPresignedPostTransport()
        let job = try makeJob()
        store.delete(job.file)

        let result = await makeUploader(api: api, transport: transport).run(job)

        XCTAssertEqual(result.outcome, .rejected)
        let sent = await transport.sent
        XCTAssertTrue(sent.isEmpty)
    }

    // MARK: - Start statuses

    func testTheStatusesOfStartingAnUpload() async throws {
        let cases: [(APIError, LabelPhotoUploadOutcome)] = [
            (.conflict, .noMorePhotos),
            (.notFound, .noMorePhotos),
            (.badRequest, .noMorePhotos),
            (.tooManyRequests, .dailyLimitReached),
            (.unauthorized, .signInRequired),
            (.transport(.notConnectedToInternet), .failed),
            (.server(status: 500), .failed),
        ]
        for (error, expected) in cases {
            let api = FakeLabelPhotoAPI(create: [.failure(error)])
            let transport = StubPresignedPostTransport()
            let job = try makeJob()

            let result = await makeUploader(api: api, transport: transport).run(job)

            XCTAssertEqual(result.outcome, expected, "\(error)")
            XCTAssertEqual(result.job.stage, .notStarted)
            let sent = await transport.sent
            XCTAssertTrue(sent.isEmpty)
            XCTAssertTrue(LabelPhotoFixtures.fileExists(job.file))
        }
    }

    // MARK: - File store

    func testTheStoreDeletesOnlyItsOwnFiles() throws {
        let outside = FileManager.default.temporaryDirectory.appending(path: "outside-\(UUID().uuidString).jpg")
        try LabelPhotoFixtures.jpeg.write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }

        store.delete(outside)

        XCTAssertTrue(LabelPhotoFixtures.fileExists(outside))
    }

    func testStaleFilesAreRemoved() throws {
        let fresh = try store.write(LabelPhotoFixtures.jpeg)
        let stale = try store.write(LabelPhotoFixtures.jpeg)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-LabelPhotoFileStore.staleAge - 60)],
            ofItemAtPath: stale.path(percentEncoded: false)
        )

        store.removeStale()

        XCTAssertTrue(LabelPhotoFixtures.fileExists(fresh))
        XCTAssertFalse(LabelPhotoFixtures.fileExists(stale))
    }
}
