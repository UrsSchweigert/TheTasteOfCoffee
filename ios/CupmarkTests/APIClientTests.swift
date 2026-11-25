import XCTest
@testable import Cupmark

/// `APIClient` (M2-T8) against a `URLProtocol` stub: each route's method, path, headers and
/// body; every documented error status; one refresh and one retry on a 401; paging over three
/// pages; and the disk cache of catalogue images. Vocabulary values come from the generated
/// enums, never typed here.
final class APIClientTests: XCTestCase {
    // MARK: - Fixtures

    /// One route: what the client must send and what the stub answers on success.
    private struct Route: Sendable {
        let endpoint: API.Endpoint
        let method: String
        let path: String
        let query: [String: String]
        let requestBody: Data?
        let response: Data
        let call: @Sendable (APIClient) async throws -> Void
    }

    /// A server-style ULID; `n` is 0 to 9.
    private func id(_ n: Int) throws -> ResourceID {
        try XCTUnwrap(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8M\(n)"))
    }

    private func first<T: CaseIterable>(_ type: T.Type) throws -> T {
        try XCTUnwrap(T.allCases.first, "\(T.self) has no entries")
    }

    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        try JSONEncoder().encode(value)
    }

    /// A few bytes that start like a JPEG.
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])

    private func makeParameters() throws -> API.BrewParameters {
        API.BrewParameters(
            method: try first(Vocabulary.Method.self),
            doseDg: 150,
            waterG: 250,
            waterTemperature: .celsius(94),
            brewTimeS: 180
        )
    }

    private func makeBrewInput(shelfEntryID: ResourceID) throws -> API.BrewInput {
        let scores = API.Scores(aroma: 7, flavour: 7.5, aftertaste: 6, acidity: 7, body: 6.5, sweetness: 7, balance: 7, overall: 7.5)
        let rating = API.Rating(
            scores: scores,
            intensities: API.Intensities(acidity: try first(Vocabulary.IntensityLevel.self)),
            flavourNotes: [try first(Vocabulary.FlavourNote.self)],
            buyAgain: true
        )
        return API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: shelfEntryID.rawValue,
            brewedAt: try XCTUnwrap(API.Timestamp(rfc3339: "2026-11-25T08:30:00.123Z")),
            parameters: try makeParameters(),
            rating: rating
        )
    }

    private func makeShelfEntryInput(beanID: ResourceID) throws -> API.ShelfEntryInput {
        API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: beanID.rawValue,
            purchaseDate: try XCTUnwrap(API.CalendarDate("2026-11-20")),
            roastDate: try XCTUnwrap(API.CalendarDate("2026-11-10")),
            bagSize: try first(Vocabulary.BagSize.self),
            priceBand: try first(Vocabulary.PriceBand.self)
        )
    }

    /// Every route of `API.Endpoint`, with the expected request written out by hand, so the
    /// test does not trust the generated table it checks.
    private func makeRoutes() throws -> [Route] {
        let beanID = try id(1)
        let shelfEntryID = try id(2)
        let brewID = try id(3)
        let recipeID = try id(4)
        let photoID = try id(5)
        let imageID = try id(6)
        let barcode = try XCTUnwrap(LookupBarcode("4006381333931"))

        let attributes = API.BeanAttributes(process: try first(Vocabulary.Process.self))
        let beanCreate = API.BeanCreate(vocabularyVersion: Vocabulary.version, barcode: barcode.rawValue, openFoodFactsConfirmed: true, attributes: attributes)
        let bean = API.Bean(
            beanId: beanID.rawValue,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: barcode.rawValue,
            openFoodFactsMatch: false,
            pickedAttributes: attributes,
            operatorAttributes: API.BeanAttributes()
        )
        let product = API.OpenFoodFactsProduct(imageId: imageID.rawValue)
        let upload = API.LabelPhotoUpload(
            photoId: photoID.rawValue,
            upload: API.LabelPhotoUploadForm(
                url: "https://cupmark-dev-photos.s3.eu-central-1.amazonaws.com/",
                fields: API.LabelPhotoUploadFields(
                    key: "uploads/\(photoID.rawValue).jpg",
                    bucket: "cupmark-dev-photos",
                    contentType: "image/jpeg",
                    policy: "fake-policy",
                    xAmzAlgorithm: "AWS4-HMAC-SHA256",
                    xAmzCredential: "fake-credential",
                    xAmzDate: "20261125T083000Z",
                    xAmzSignature: "fake-signature"
                )
            ),
            expiresAt: try XCTUnwrap(API.Timestamp(rfc3339: "2026-11-25T08:40:00.000Z")),
            maxBytes: 8_388_608
        )
        let shelfInput = try makeShelfEntryInput(beanID: beanID)
        let shelfEntry = API.ShelfEntry(shelfEntryId: shelfEntryID.rawValue, values: shelfInput)
        let brewInput = try makeBrewInput(shelfEntryID: shelfEntryID)
        let brew = API.Brew(brewId: brewID.rawValue, values: brewInput)
        let recipeInput = API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try makeParameters())
        let recipe = API.Recipe(recipeId: recipeID.rawValue, values: recipeInput)
        let profile = API.Profile(locale: try first(VocabularyLanguage.self), consent: API.Consent(contributeToAggregates: true))
        let csv = Data("\"item_type\"\r\n".utf8)

        let b = beanID.rawValue
        let s = shelfEntryID.rawValue
        let w = brewID.rawValue
        let r = recipeID.rawValue
        return [
            Route(endpoint: .lookupBarcode, method: "GET", path: "/barcodes/4006381333931", query: [:], requestBody: nil, response: try encoded(bean)) { client in
                _ = try await client.lookupBarcode(barcode)
            },
            Route(endpoint: .lookupOpenFoodFacts, method: "GET", path: "/barcodes/4006381333931/open_food_facts", query: [:], requestBody: nil, response: try encoded(product)) { client in
                _ = try await client.lookupOpenFoodFacts(barcode)
            },
            Route(endpoint: .createBean, method: "POST", path: "/beans", query: [:], requestBody: try encoded(beanCreate), response: try encoded(bean)) { client in
                _ = try await client.createBean(beanCreate)
            },
            Route(endpoint: .getBean, method: "GET", path: "/beans/\(b)", query: [:], requestBody: nil, response: try encoded(bean)) { client in
                _ = try await client.getBean(beanID)
            },
            Route(endpoint: .createLabelPhotoUpload, method: "POST", path: "/beans/\(b)/label_photos", query: [:], requestBody: nil, response: try encoded(upload)) { client in
                _ = try await client.createLabelPhotoUpload(beanID: beanID)
            },
            Route(endpoint: .getCatalogueImage, method: "GET", path: "/catalogue_images/\(imageID.rawValue)", query: [:], requestBody: nil, response: jpeg) { client in
                _ = try await client.catalogueImage(imageID)
            },
            Route(endpoint: .completeLabelPhoto, method: "POST", path: "/label_photos/\(photoID.rawValue)/complete", query: [:], requestBody: nil, response: Data()) { client in
                try await client.completeLabelPhoto(photoID: photoID)
            },
            Route(endpoint: .listShelfEntries, method: "GET", path: "/shelf", query: ["cursor": "abc_-1", "limit": "20"], requestBody: nil, response: try encoded(API.ShelfEntryPage(items: [shelfEntry]))) { client in
                _ = try await client.listShelfEntries(cursor: "abc_-1", limit: 20)
            },
            Route(endpoint: .createShelfEntry, method: "POST", path: "/shelf", query: [:], requestBody: try encoded(shelfInput), response: try encoded(shelfEntry)) { client in
                _ = try await client.createShelfEntry(shelfInput)
            },
            Route(endpoint: .getShelfEntry, method: "GET", path: "/shelf/\(s)", query: [:], requestBody: nil, response: try encoded(shelfEntry)) { client in
                _ = try await client.getShelfEntry(shelfEntryID)
            },
            Route(endpoint: .replaceShelfEntry, method: "PUT", path: "/shelf/\(s)", query: [:], requestBody: try encoded(shelfInput), response: try encoded(shelfEntry)) { client in
                _ = try await client.replaceShelfEntry(shelfEntryID, with: shelfInput)
            },
            Route(endpoint: .deleteShelfEntry, method: "DELETE", path: "/shelf/\(s)", query: [:], requestBody: nil, response: Data()) { client in
                try await client.deleteShelfEntry(shelfEntryID)
            },
            Route(endpoint: .listBrews, method: "GET", path: "/brews", query: [:], requestBody: nil, response: try encoded(API.BrewPage(items: [brew]))) { client in
                _ = try await client.listBrews()
            },
            Route(endpoint: .createBrew, method: "POST", path: "/brews", query: [:], requestBody: try encoded(brewInput), response: try encoded(brew)) { client in
                _ = try await client.createBrew(brewInput)
            },
            Route(endpoint: .getBrew, method: "GET", path: "/brews/\(w)", query: [:], requestBody: nil, response: try encoded(brew)) { client in
                _ = try await client.getBrew(brewID)
            },
            Route(endpoint: .replaceBrew, method: "PUT", path: "/brews/\(w)", query: [:], requestBody: try encoded(brewInput), response: try encoded(brew)) { client in
                _ = try await client.replaceBrew(brewID, with: brewInput)
            },
            Route(endpoint: .deleteBrew, method: "DELETE", path: "/brews/\(w)", query: [:], requestBody: nil, response: Data()) { client in
                try await client.deleteBrew(brewID)
            },
            Route(endpoint: .listRecipes, method: "GET", path: "/recipes", query: ["limit": "100"], requestBody: nil, response: try encoded(API.RecipePage(items: [recipe]))) { client in
                _ = try await client.listRecipes(limit: 100)
            },
            Route(endpoint: .createRecipe, method: "POST", path: "/recipes", query: [:], requestBody: try encoded(recipeInput), response: try encoded(recipe)) { client in
                _ = try await client.createRecipe(recipeInput)
            },
            Route(endpoint: .getRecipe, method: "GET", path: "/recipes/\(r)", query: [:], requestBody: nil, response: try encoded(recipe)) { client in
                _ = try await client.getRecipe(recipeID)
            },
            Route(endpoint: .replaceRecipe, method: "PUT", path: "/recipes/\(r)", query: [:], requestBody: try encoded(recipeInput), response: try encoded(recipe)) { client in
                _ = try await client.replaceRecipe(recipeID, with: recipeInput)
            },
            Route(endpoint: .deleteRecipe, method: "DELETE", path: "/recipes/\(r)", query: [:], requestBody: nil, response: Data()) { client in
                try await client.deleteRecipe(recipeID)
            },
            Route(endpoint: .getProfile, method: "GET", path: "/profile", query: [:], requestBody: nil, response: try encoded(profile)) { client in
                _ = try await client.getProfile()
            },
            Route(endpoint: .putProfile, method: "PUT", path: "/profile", query: [:], requestBody: try encoded(profile), response: try encoded(profile)) { client in
                _ = try await client.putProfile(profile)
            },
            Route(endpoint: .exportData, method: "GET", path: "/export", query: [:], requestBody: nil, response: csv) { client in
                _ = try await client.exportData()
            },
            Route(endpoint: .deleteAccount, method: "DELETE", path: "/account", query: [:], requestBody: nil, response: Data()) { client in
                try await client.deleteAccount()
            },
        ]
    }

    // MARK: - Helpers

    private func makeClient(_ server: StubServer, tokens: FakeTokenProvider = FakeTokenProvider(), cache: CatalogueImageCache? = nil) -> APIClient {
        APIClient(baseURL: server.baseURL, tokenProvider: tokens, session: server.makeSession(), imageCache: cache)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "CupmarkTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    private func query(of request: RecordedRequest) -> [String: String] {
        Dictionary(request.queryItems.map { item in (item.name, item.value ?? "") }, uniquingKeysWith: { lhs, _ in lhs })
    }

    private func assertSameJSON(_ actual: Data?, _ expected: Data, _ message: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let body = try XCTUnwrap(actual, message, file: file, line: line)
        let lhs = try JSONSerialization.jsonObject(with: body) as? NSObject
        let rhs = try JSONSerialization.jsonObject(with: expected) as? NSObject
        XCTAssertNotNil(lhs, message, file: file, line: line)
        XCTAssertEqual(lhs, rhs, message, file: file, line: line)
    }

    private func assertThrows(
        _ expected: APIError,
        _ message: String = "",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected \(expected) \(message)", file: file, line: line)
        } catch let error as APIError {
            XCTAssertEqual(error, expected, message, file: file, line: line)
        } catch {
            XCTFail("unexpected \(error) \(message)", file: file, line: line)
        }
    }

    // MARK: - Routes

    func testEveryRouteIsCoveredOnce() throws {
        let routes = try makeRoutes()
        XCTAssertEqual(routes.map(\.endpoint).sorted { $0.rawValue < $1.rawValue }, API.Endpoint.allCases.sorted { $0.rawValue < $1.rawValue })
        for route in routes {
            XCTAssertEqual(route.method, route.endpoint.method.rawValue, route.endpoint.rawValue)
        }
    }

    func testEachRouteSendsItsMethodPathHeadersAndBody() async throws {
        for route in try makeRoutes() {
            let name = route.endpoint.rawValue
            let server = try StubServer { _ in StubResponse(status: route.endpoint.successStatus, body: route.response) }
            try await route.call(makeClient(server))

            let requests = server.requests
            XCTAssertEqual(requests.count, 1, name)
            let request = try XCTUnwrap(requests.first, name)
            XCTAssertEqual(request.method, route.method, name)
            XCTAssertEqual(request.path, route.path, name)
            XCTAssertEqual(query(of: request), route.query, name)
            XCTAssertEqual(request.header("Authorization"), "Bearer access-token-1", name)
            if let accept = route.endpoint.responseContentType {
                XCTAssertEqual(request.header("Accept"), accept, name)
            }
            if let expected = route.requestBody {
                XCTAssertEqual(request.header("Content-Type"), "application/json", name)
                try assertSameJSON(request.body, expected, name)
            } else {
                XCTAssertTrue(request.body?.isEmpty ?? true, name)
                XCTAssertNil(request.header("Content-Type"), name)
            }
            // Invariant 3: the only query parameters are the page's cursor and limit.
            XCTAssertTrue(Set(query(of: request).keys).isSubset(of: ["cursor", "limit"]), name)
        }
    }

    func testResponsesDecodeToTheContractTypes() async throws {
        let brewID = try id(3)
        let brew = API.Brew(brewId: brewID.rawValue, values: try makeBrewInput(shelfEntryID: try id(2)))
        let server = try StubServer { _ in StubResponse(status: 200, body: (try? JSONEncoder().encode(brew)) ?? Data()) }
        let received = try await makeClient(server).getBrew(brewID)
        XCTAssertEqual(received, brew)
    }

    func testTheBaseURLPathIsKept() async throws {
        let profile = API.Profile(locale: try first(VocabularyLanguage.self), consent: API.Consent(contributeToAggregates: false))
        let body = try encoded(profile)
        let server = try StubServer(basePath: "/dev/") { _ in StubResponse(status: 200, body: body) }
        _ = try await makeClient(server).getProfile()
        XCTAssertEqual(server.requests.first?.path, "/dev/profile")
    }

    // MARK: - Statuses

    /// Every status any route of the contract lists, and the error it becomes.
    private let documentedErrors: [Int: APIError] = [
        400: .badRequest,
        401: .unauthorized,
        404: .notFound,
        409: .conflict,
        429: .tooManyRequests,
        503: .serviceUnavailable,
    ]

    func testEveryDocumentedStatusOfEveryRouteMapsToItsError() async throws {
        for route in try makeRoutes() {
            let statuses = route.endpoint.documentedErrorStatuses + [500, 502]
            for status in statuses {
                let name = "\(route.endpoint.rawValue) \(status)"
                let expected: APIError
                if let documented = documentedErrors[status] {
                    expected = documented
                } else {
                    // A status the contract adds later fails here until this test knows it.
                    XCTAssertTrue((500...599).contains(status), "no expected error for \(name)")
                    expected = .server(status: status)
                }
                let server = try StubServer { _ in StubResponse(status: status, body: Data("{\"message\":\"x\"}".utf8)) }
                let tokens = FakeTokenProvider()
                await assertThrows(expected, name) {
                    try await route.call(self.makeClient(server, tokens: tokens))
                }
                // A 401 is refreshed and retried once; every other status is final.
                XCTAssertEqual(server.requests.count, status == 401 ? 2 : 1, name)
                let refreshes = await tokens.refreshCount
                XCTAssertEqual(refreshes, status == 401 ? 1 : 0, name)
            }
        }
    }

    func testStatusMapping() {
        XCTAssertEqual(APIError(status: 400), .badRequest)
        XCTAssertEqual(APIError(status: 401), .unauthorized)
        XCTAssertEqual(APIError(status: 404), .notFound)
        XCTAssertEqual(APIError(status: 409), .conflict)
        XCTAssertEqual(APIError(status: 429), .tooManyRequests)
        XCTAssertEqual(APIError(status: 503), .serviceUnavailable)
        XCTAssertEqual(APIError(status: 500), .server(status: 500))
        XCTAssertEqual(APIError(status: 504), .server(status: 504))
        XCTAssertEqual(APIError(status: 403), .unexpectedStatus(403))
        XCTAssertEqual(APIError(status: 200), .unexpectedStatus(200))
        XCTAssertTrue(APIError.tooManyRequests.isRetryable)
        XCTAssertTrue(APIError.server(status: 500).isRetryable)
        XCTAssertTrue(APIError.transport(.timedOut).isRetryable)
        XCTAssertFalse(APIError.badRequest.isRetryable)
        XCTAssertFalse(APIError.conflict.isRetryable)
    }

    func testASuccessStatusOtherThanTheRoutesIsUnexpected() async throws {
        let shelfInput = try makeShelfEntryInput(beanID: try id(1))
        let body = try encoded(API.ShelfEntry(shelfEntryId: try id(2).rawValue, values: shelfInput))
        let server = try StubServer { _ in StubResponse(status: 200, body: body) }
        await assertThrows(.unexpectedStatus(200)) {
            _ = try await self.makeClient(server).createShelfEntry(shelfInput)
        }
    }

    func testABodyThatDoesNotDecodeIsUndecodable() async throws {
        let server = try StubServer { _ in StubResponse(status: 200, body: Data("{}".utf8)) }
        let brewID = try id(3)
        await assertThrows(.undecodable) {
            _ = try await self.makeClient(server).getBrew(brewID)
        }
    }

    func testATransportFailureIsTyped() async throws {
        let server = try StubServer { _ in throw URLError(.notConnectedToInternet) }
        await assertThrows(.transport(.notConnectedToInternet)) {
            _ = try await self.makeClient(server).getProfile()
        }
    }

    // MARK: - Token refresh

    func testA401IsRefreshedOnceAndRetriedOnceWithTheSameRequest() async throws {
        let brewInput = try makeBrewInput(shelfEntryID: try id(2))
        let brew = API.Brew(brewId: try id(3).rawValue, values: brewInput)
        let created = try encoded(brew)
        let server = try StubServer { request in
            request.header("Authorization") == "Bearer access-token-2"
                ? StubResponse(status: 201, body: created)
                : StubResponse(status: 401)
        }
        let tokens = FakeTokenProvider()
        let received = try await makeClient(server, tokens: tokens).createBrew(brewInput)

        XCTAssertEqual(received, brew)
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 1)
        let requests = server.requests
        XCTAssertEqual(requests.map { $0.header("Authorization") }, ["Bearer access-token-1", "Bearer access-token-2"])
        XCTAssertEqual(requests.map(\.method), ["POST", "POST"])
        XCTAssertEqual(requests.map(\.path), ["/brews", "/brews"])
        let expected = try encoded(brewInput)
        for request in requests {
            try assertSameJSON(request.body, expected, "retried body")
        }
    }

    func testA401AfterTheRetryIsUnauthorized() async throws {
        let server = try StubServer { _ in StubResponse(status: 401) }
        let tokens = FakeTokenProvider()
        await assertThrows(.unauthorized) {
            _ = try await self.makeClient(server, tokens: tokens).getProfile()
        }
        XCTAssertEqual(server.requests.count, 2)
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 1)
    }

    func testAFailedRefreshIsUnauthorizedWithoutARetry() async throws {
        let server = try StubServer { _ in StubResponse(status: 401) }
        let tokens = FakeTokenProvider(refreshFails: true)
        await assertThrows(.unauthorized) {
            _ = try await self.makeClient(server, tokens: tokens).getProfile()
        }
        XCTAssertEqual(server.requests.count, 1)
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 1)
    }

    func testNoTokenSendsNothing() async throws {
        let server = try StubServer { _ in StubResponse(status: 200) }
        let tokens = FakeTokenProvider(signedIn: false)
        await assertThrows(.unauthorized) {
            _ = try await self.makeClient(server, tokens: tokens).getProfile()
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    // MARK: - Cancellation

    func testCancellingDuringARequestThrowsCancellationErrorWithoutRefreshOrRetry() async throws {
        // A slow 401: if cancellation were taken for a transport error or the 401, the client
        // would refresh and retry.
        let server = try StubServer { _ in StubResponse(status: 401, delay: 5) }
        let tokens = FakeTokenProvider()
        let client = makeClient(server, tokens: tokens)
        let task = Task { try await client.getProfile() }
        for _ in 0..<500 where server.requests.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(server.requests.count, 1)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(server.requests.count, 1)
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 0)
    }

    func testCancellingDuringTheRefreshStopsBeforeTheRetry() async throws {
        let server = try StubServer { _ in StubResponse(status: 401) }
        let tokens = CancellingTokenProvider()
        let client = APIClient(baseURL: server.baseURL, tokenProvider: tokens, session: server.makeSession(), imageCache: nil)
        let task = Task { try await client.getProfile() }
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(server.requests.count, 1)
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 1)
    }

    func testACancelledTransportErrorIsNeverRetryable() {
        XCTAssertFalse(APIError.transport(.cancelled).isRetryable)
        XCTAssertTrue(APIError.transport(.notConnectedToInternet).isRetryable)
    }

    // MARK: - Paging

    func testPagingStopsAfterMaxPages() async throws {
        let server = try StubServer { _ in StubResponse(status: 200) }
        let client = makeClient(server)
        let counter = PageCounter()
        await assertThrows(.invalidResponse) {
            _ = try await client.allPages { (_: API.Cursor?) async throws -> API.RecipePage in
                let n = await counter.next()
                return API.RecipePage(items: [], nextCursor: "page\(n)")
            }
        }
        let fetched = await counter.count
        XCTAssertEqual(fetched, APIClient.maxPages)
        XCTAssertTrue(server.requests.isEmpty)
    }

    /// A brew page, with the item at `undecodableIndex` given a method no vocabulary has.
    private func brewPage(ids: [Int], next: String?, undecodableIndex: Int? = nil) throws -> Data {
        let brews = try ids.map { n in API.Brew(brewId: try id(n).rawValue, values: try makeBrewInput(shelfEntryID: try id(0))) }
        let data = try encoded(API.BrewPage(items: brews, nextCursor: next))
        guard let index = undecodableIndex else {
            return data
        }
        var page = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var items = try XCTUnwrap(page["items"] as? [[String: Any]])
        var values = try XCTUnwrap(items[index]["values"] as? [String: Any])
        var parameters = try XCTUnwrap(values["parameters"] as? [String: Any])
        parameters["method"] = "zz_not_in_any_vocabulary"
        values["parameters"] = parameters
        items[index]["values"] = values
        page["items"] = items
        return try JSONSerialization.data(withJSONObject: page)
    }

    func testAllBrewsFollowsTheCursorWithLimit100OverThreePages() async throws {
        let pages: [String: Data] = [
            "": try brewPage(ids: [1, 2], next: "page2"),
            "page2": try brewPage(ids: [3, 4, 5], next: "page3", undecodableIndex: 1),
            "page3": try brewPage(ids: [6], next: nil),
        ]
        let server = try StubServer { request in
            let cursor = request.queryItems.first { $0.name == "cursor" }?.value ?? ""
            guard let body = pages[cursor] else {
                return StubResponse(status: 400)
            }
            return StubResponse(status: 200, body: body)
        }
        let all = try await makeClient(server).allBrews()

        XCTAssertEqual(all.pageCount, 3)
        XCTAssertEqual(all.items.map(\.brewId), try [1, 2, 3, 5, 6].map { try id($0).rawValue })
        XCTAssertEqual(all.undecodableItems.count, 1)
        XCTAssertEqual(all.undecodableItems.first?.index, 1)
        let requests = server.requests
        XCTAssertEqual(requests.map(query(of:)), [
            ["limit": "100"],
            ["cursor": "page2", "limit": "100"],
            ["cursor": "page3", "limit": "100"],
        ])
        XCTAssertEqual(Set(requests.map(\.path)), ["/brews"])
    }

    func testAllShelfEntriesAndAllRecipesPageWithLimit100() async throws {
        let shelf = API.ShelfEntry(shelfEntryId: try id(2).rawValue, values: try makeShelfEntryInput(beanID: try id(1)))
        let recipe = API.Recipe(recipeId: try id(4).rawValue, values: API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try makeParameters()))
        let shelfPages = [try encoded(API.ShelfEntryPage(items: [shelf], nextCursor: "next")), try encoded(API.ShelfEntryPage(items: [shelf]))]
        let recipePage = try encoded(API.RecipePage(items: [recipe, recipe]))
        let server = try StubServer { request in
            if request.path == "/recipes" {
                return StubResponse(status: 200, body: recipePage)
            }
            let hasCursor = request.queryItems.contains { $0.name == "cursor" }
            return StubResponse(status: 200, body: shelfPages[hasCursor ? 1 : 0])
        }
        let client = makeClient(server)
        let entries = try await client.allShelfEntries()
        let recipes = try await client.allRecipes()

        XCTAssertEqual(entries.items, [shelf, shelf])
        XCTAssertEqual(entries.pageCount, 2)
        XCTAssertEqual(recipes.items, [recipe, recipe])
        XCTAssertEqual(recipes.pageCount, 1)
        XCTAssertEqual(server.requests.map(query(of:)), [
            ["limit": "100"],
            ["cursor": "next", "limit": "100"],
            ["limit": "100"],
        ])
    }

    func testARepeatedCursorStopsThePaging() async throws {
        let body = try brewPage(ids: [1], next: "again")
        let server = try StubServer { _ in StubResponse(status: 200, body: body) }
        await assertThrows(.invalidResponse) {
            _ = try await self.makeClient(server).allBrews()
        }
        XCTAssertEqual(server.requests.count, 2)
    }

    func testAMalformedCursorStopsThePaging() async throws {
        let body = try brewPage(ids: [1], next: "not a cursor")
        let server = try StubServer { _ in StubResponse(status: 200, body: body) }
        await assertThrows(.invalidResponse) {
            _ = try await self.makeClient(server).allBrews()
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func testAnOutOfRangeLimitOrBadCursorIsRefusedBeforeSending() async throws {
        let server = try StubServer { _ in StubResponse(status: 200) }
        let client = makeClient(server)
        await assertThrows(.invalidRequest) { _ = try await client.listBrews(limit: 0) }
        await assertThrows(.invalidRequest) { _ = try await client.listBrews(limit: 101) }
        await assertThrows(.invalidRequest) { _ = try await client.listRecipes(cursor: "a/b") }
        await assertThrows(.invalidRequest) { _ = try await client.listShelfEntries(cursor: "") }
        XCTAssertTrue(server.requests.isEmpty)
    }

    // MARK: - Typed path values

    func testPathValuesAcceptOnlyTheContractPatterns() {
        XCTAssertNotNil(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8M0"))
        XCTAssertNotNil(ResourceID("0123456789ABCDEFGHJKMNPQRS"))
        XCTAssertNil(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8M"))
        XCTAssertNil(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8M00"))
        XCTAssertNil(ResourceID("01jdq6y8z5w4v3t2s1r0p9n8m0"))
        XCTAssertNil(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8MI"))
        XCTAssertNil(ResourceID("01JDQ6Y8Z5W4V3T2S1R0P9N8MU"))
        XCTAssertNil(ResourceID("../../account/0000000000000"))
        XCTAssertNil(ResourceID(""))

        XCTAssertNotNil(LookupBarcode("4006381333931"))
        XCTAssertNotNil(LookupBarcode("036000291452"))
        XCTAssertNil(LookupBarcode("03600029145"))
        XCTAssertNil(LookupBarcode("40063813339310"))
        XCTAssertNil(LookupBarcode("40063813339a1"))
        XCTAssertNil(LookupBarcode("４００６３８１３３３９３１"))

        XCTAssertTrue(APIClient.isValidCursor("abc-DEF_123"))
        XCTAssertFalse(APIClient.isValidCursor(""))
        XCTAssertFalse(APIClient.isValidCursor("a+b"))
        XCTAssertFalse(APIClient.isValidCursor(String(repeating: "a", count: 513)))
    }

    // MARK: - Catalogue images

    func testACatalogueImageIsLoadedWithTheTokenAndThenServedFromDisk() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = CatalogueImageCache(directory: directory)
        let image = jpeg
        let server = try StubServer { _ in StubResponse(status: 200, body: image) }
        let client = makeClient(server, cache: cache)
        let imageID = try id(6)

        let loaded = try await client.catalogueImage(imageID)
        let again = try await client.catalogueImage(imageID)

        XCTAssertEqual(loaded, image)
        XCTAssertEqual(again, image)
        let requests = server.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.header("Authorization"), "Bearer access-token-1")
        XCTAssertEqual(requests.first?.header("Accept"), "image/jpeg")
        let file = await cache.fileURL(for: imageID)
        XCTAssertEqual(file.lastPathComponent, "\(imageID.rawValue).jpg")
        XCTAssertEqual(try Data(contentsOf: file), image)

        // A second client on the same directory (a new app launch) reads the disk.
        let relaunched = makeClient(server, cache: CatalogueImageCache(directory: directory))
        let fromDisk = try await relaunched.catalogueImage(imageID)
        XCTAssertEqual(fromDisk, image)
        XCTAssertEqual(server.requests.count, 1)
    }

    func testABodyThatIsNotAJPEGIsRejectedAndNotCached() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = CatalogueImageCache(directory: directory)
        let server = try StubServer { _ in StubResponse(status: 200, body: Data("<html>".utf8)) }
        let client = makeClient(server, cache: cache)
        let imageID = try id(7)

        await assertThrows(.invalidResponse) { _ = try await client.catalogueImage(imageID) }
        await assertThrows(.invalidResponse) { _ = try await client.catalogueImage(imageID) }
        XCTAssertEqual(server.requests.count, 2)
        let cached = await cache.data(for: imageID)
        XCTAssertNil(cached)
    }

    func testTheImageCacheStaysWithinItsSizeBound() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = CatalogueImageCache(directory: directory, byteLimit: 10)
        let older = try id(1)
        let newer = try id(2)
        let tooLarge = try id(3)

        await cache.store(Data(repeating: 1, count: 6), for: older)
        await cache.store(Data(repeating: 2, count: 6), for: newer)
        await cache.store(Data(repeating: 3, count: 11), for: tooLarge)

        let olderData = await cache.data(for: older)
        let newerData = await cache.data(for: newer)
        let tooLargeData = await cache.data(for: tooLarge)
        XCTAssertNil(olderData)
        XCTAssertEqual(newerData, Data(repeating: 2, count: 6))
        XCTAssertNil(tooLargeData)

        await cache.removeAll()
        let afterRemoval = await cache.data(for: newer)
        XCTAssertNil(afterRemoval)
    }
}

/// Counts the pages a paging test has served.
private actor PageCounter {
    private(set) var count = 0

    func next() -> Int {
        count += 1
        return count
    }
}

/// Cancels the calling task inside `refresh()`, which then succeeds: the client must notice
/// the cancellation before it retries.
private actor CancellingTokenProvider: TokenProvider {
    private(set) var refreshCount = 0

    func currentAccessToken() async throws -> String {
        "access-token-1"
    }

    func refresh() async throws {
        refreshCount += 1
        withUnsafeCurrentTask { task in
            task?.cancel()
        }
    }
}
