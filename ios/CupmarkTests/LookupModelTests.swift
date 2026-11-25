import XCTest
@testable import Cupmark

/// Records the host of every request a session starts, before any protocol answers it.
/// `canInit` returns false, so `StubURLProtocol` (next in the list) still handles the request,
/// and it fails every host but its server's. With this in front, a request to any other host,
/// Open Food Facts included, would show up here even though no stub server answers it.
final class HostRecordingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [String] = []

    static var hosts: [String] {
        lock.withLock { recorded }
    }

    static func reset() {
        lock.withLock { recorded = [] }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        let host = request.url?.host() ?? "(no host)"
        lock.withLock { recorded.append(host) }
        return false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }
}

/// Answers each `METHOD path` with its responses in turn; the last one repeats. Anything else
/// is a 500, so an unexpected request fails the test's expectations.
private final class RouteTable: @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [String: [StubResponse]]

    init(_ routes: [String: [StubResponse]]) {
        self.routes = routes
    }

    func respond(to request: RecordedRequest) -> StubResponse {
        lock.withLock {
            let key = "\(request.method) \(request.path)"
            guard var queue = routes[key], let first = queue.first else {
                return StubResponse(status: 500)
            }
            if queue.count > 1 {
                queue.removeFirst()
                routes[key] = queue
            }
            return first
        }
    }
}

/// `LookupModel` (M2-T14) against a `URLProtocol` stub: every answer of the lookup, the
/// confirmation and the rejection, and that no request goes anywhere but the API host.
@MainActor
final class LookupModelTests: XCTestCase {
    // MARK: - Fixtures

    /// A valid EAN-13 (check digit 1).
    private let digits = "4006381333931"

    private var catalogue: String { "GET /barcodes/\(digits)" }
    private var openFoodFacts: String { "GET /barcodes/\(digits)/open_food_facts" }
    private let createBean = "POST /beans"

    private func barcode() throws -> CanonicalBarcode {
        try XCTUnwrap(CanonicalBarcode(digits))
    }

    private func first<T: CaseIterable>(_ type: T.Type) throws -> T {
        try XCTUnwrap(T.allCases.first, "\(T.self) has no entries")
    }

    private func last<T: CaseIterable>(_ type: T.Type) throws -> T {
        try XCTUnwrap(Array(T.allCases).last, "\(T.self) has no entries")
    }

    private let imageID = "01JDQ6Y8Z5W4V3T2S1R0P9N8M7"
    private let beanID = "01JDQ6Y8Z5W4V3T2S1R0P9N8M1"
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])

    /// Open Food Facts text as the server returns it: untrusted, here with Markdown and a
    /// format specifier that must stay plain text.
    private func product() -> API.OpenFoodFactsProduct {
        API.OpenFoodFactsProduct(name: "**Crema** %@ [Roast](x)", brand: "Röster & Co", imageId: imageID)
    }

    private func bean(verified: Bool = false, offProduct: API.OpenFoodFactsProduct? = nil) throws -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: verified,
            barcode: digits,
            openFoodFactsMatch: offProduct != nil,
            openFoodFacts: offProduct,
            pickedAttributes: API.BeanAttributes(process: try first(Vocabulary.Process.self)),
            operatorAttributes: API.BeanAttributes()
        )
    }

    private func json<T: Encodable>(_ value: T, status: Int = 200) throws -> StubResponse {
        StubResponse(status: status, body: try JSONEncoder().encode(value), headers: ["Content-Type": "application/json"])
    }

    private func status(_ code: Int) -> StubResponse {
        StubResponse(status: code)
    }

    /// A stub server for `routes`, and a model whose client goes through the host recorder
    /// and the stub, with no disk cache.
    private func makeModel(_ routes: [String: [StubResponse]]) throws -> (LookupModel, StubServer) {
        let table = RouteTable(routes)
        let server = try StubServer { request in table.respond(to: request) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HostRecordingURLProtocol.self, StubURLProtocol.self]
        configuration.urlCache = nil
        let client = APIClient(
            baseURL: server.baseURL,
            tokenProvider: FakeTokenProvider(),
            session: URLSession(configuration: configuration),
            imageCache: nil
        )
        return (LookupModel(barcode: try barcode(), client: client), server)
    }

    private func calls(_ server: StubServer) -> [String] {
        server.requests.map { "\($0.method) \($0.path)" }
    }

    // MARK: - Known barcode

    func testAKnownBarcodeShowsItsBean() async throws {
        let known = try bean(verified: true, offProduct: product())
        let (model, server) = try makeModel([catalogue: [try json(known)]])

        await model.lookUp()

        XCTAssertEqual(model.state, .bean(known))
        XCTAssertEqual(calls(server), [catalogue])
        XCTAssertEqual(server.requests.first?.header("Authorization"), "Bearer access-token-1")
    }

    func testALookupRunsOnceAndNotAgainAfterAnAnswer() async throws {
        let (model, server) = try makeModel([catalogue: [try json(try bean())]])

        await model.lookUp()
        await model.lookUp()

        XCTAssertEqual(calls(server), [catalogue])
        XCTAssertFalse(model.canLookUp)
    }

    func testAUPCABarcodeIsLookedUpInItsThirteenDigitForm() async throws {
        // 036000291452 is UPC-A; the scanner hands it over as 0036000291452.
        let upc = try XCTUnwrap(CanonicalBarcode("036000291452"))
        let server = try StubServer { _ in StubResponse(status: 500) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        let model = LookupModel(barcode: upc, client: client)

        await model.lookUp()

        XCTAssertEqual(server.requests.first?.path, "/barcodes/0036000291452")
    }

    // MARK: - Operator wins

    func testTheOperatorsValueWinsOverAPickedOne() throws {
        let picked = try first(Vocabulary.Process.self)
        let operatorValue = try last(Vocabulary.Process.self)
        XCTAssertNotEqual(picked, operatorValue)
        let species = try first(Vocabulary.Species.self)
        let roast = try first(Vocabulary.RoastLevel.self)
        let value = API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            openFoodFactsMatch: false,
            pickedAttributes: API.BeanAttributes(process: picked, species: species),
            operatorAttributes: API.BeanAttributes(process: operatorValue, roastLevel: roast)
        )

        let rows = value.attributeRows

        XCTAssertEqual(rows.map(\.field), [.species, .process, .roastLevel])
        XCTAssertEqual(rows.first { $0.field == .process }, BeanAttributeRow(field: .process, valueID: operatorValue.rawValue, source: .operatorSet))
        XCTAssertEqual(rows.first { $0.field == .species }, BeanAttributeRow(field: .species, valueID: species.rawValue, source: .picked))
        XCTAssertEqual(rows.first { $0.field == .roastLevel }, BeanAttributeRow(field: .roastLevel, valueID: roast.rawValue, source: .operatorSet))
    }

    func testEveryAttributeFieldReadsItsOwnListAndABeanWithoutValuesHasNoRows() throws {
        let attributes = API.BeanAttributes(
            process: try first(Vocabulary.Process.self),
            roastLevel: try first(Vocabulary.RoastLevel.self),
            origin: try first(Vocabulary.Origin.self),
            species: try first(Vocabulary.Species.self),
            variety: try first(Vocabulary.Variety.self)
        )
        let full = API.Bean(beanId: beanID, vocabularyVersion: Vocabulary.version, verified: false, openFoodFactsMatch: false, pickedAttributes: attributes, operatorAttributes: API.BeanAttributes())
        let store = try VocabularyStore.load(from: Bundle(for: AppBundleToken.self))
        for row in full.attributeRows {
            XCTAssertNoThrow(try store.label(namespace: row.field.namespace, id: row.valueID, language: .fallback), "\(row.field)")
        }
        XCTAssertEqual(Set(full.attributeRows.map(\.field)), Set(BeanAttributeField.allCases))

        let empty = API.Bean(beanId: beanID, vocabularyVersion: Vocabulary.version, verified: false, openFoodFactsMatch: false, pickedAttributes: API.BeanAttributes(), operatorAttributes: API.BeanAttributes())
        XCTAssertEqual(empty.attributeRows, [])
    }

    // MARK: - Open Food Facts hit

    func testAnUnknownBarcodeShowsTheOpenFoodFactsHitAsIs() async throws {
        let hit = product()
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [try json(hit)],
        ])

        await model.lookUp()

        XCTAssertEqual(model.state, .openFoodFacts(hit))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts])
        // The text is kept exactly as received; the view shows it with Text(verbatim:).
        guard case .openFoodFacts(let shown) = model.state else {
            return XCTFail("no hit")
        }
        XCTAssertEqual(shown.name, "**Crema** %@ [Roast](x)")
        XCTAssertEqual(shown.brand, "Röster & Co")
    }

    func testTheImageLoadsFromTheAPI() async throws {
        let (model, server) = try makeModel([
            "GET /catalogue_images/\(imageID)": [StubResponse(status: 200, body: jpeg, headers: ["Content-Type": "image/jpeg"])],
        ])

        let data = await model.image(imageID)

        XCTAssertEqual(data, jpeg)
        XCTAssertEqual(calls(server), ["GET /catalogue_images/\(imageID)"])
        XCTAssertEqual(server.requests.first?.header("Accept"), "image/jpeg")
    }

    func testAMissingOrMalformedImageIsNil() async throws {
        let (model, server) = try makeModel([
            "GET /catalogue_images/\(imageID)": [status(404)],
        ])

        let missing = await model.image(imageID)
        let malformed = await model.image("not-an-id")

        XCTAssertNil(missing)
        XCTAssertNil(malformed)
        XCTAssertEqual(calls(server), ["GET /catalogue_images/\(imageID)"])
    }

    func testConfirmingCreatesTheBeanWithOnlyTheBarcodeTheFlagThePicksAndTheVersion() async throws {
        let created = try bean(offProduct: product())
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [try json(product())],
            createBean: [try json(created, status: 201)],
        ])
        await model.lookUp()
        let process = try first(Vocabulary.Process.self)
        let roast = try last(Vocabulary.RoastLevel.self)
        model.picks.process = process
        model.picks.roastLevel = roast

        await model.confirm()

        XCTAssertEqual(model.state, .bean(created))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, createBean])
        let body = try XCTUnwrap(server.requests.last?.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        // No Open Food Facts text goes back: only these four properties (ADR 0005).
        XCTAssertEqual(Set(object.keys), ["attributes", "barcode", "open_food_facts_confirmed", "vocabulary_version"])
        XCTAssertEqual(object["barcode"] as? String, digits)
        XCTAssertEqual(object["open_food_facts_confirmed"] as? Bool, true)
        XCTAssertEqual(object["vocabulary_version"] as? Int, Vocabulary.version)
        let attributes = try XCTUnwrap(object["attributes"] as? [String: String])
        XCTAssertEqual(attributes, ["process": process.rawValue, "roast_level": roast.rawValue])
        XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("Crema"))
    }

    func testConfirmingWithoutPicksSendsEmptyAttributes() async throws {
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [try json(product())],
            createBean: [try json(try bean(offProduct: product()), status: 201)],
        ])
        await model.lookUp()

        await model.confirm()

        let body = try XCTUnwrap(server.requests.last?.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual((object["attributes"] as? [String: Any])?.count, 0)
    }

    func testConfirmDoesNothingWithoutAHit() async throws {
        let (model, server) = try makeModel([:])

        await model.confirm()

        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(calls(server), [])
    }

    func testRejectingLeadsToThePickListEntryWithoutARequest() async throws {
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [try json(product())],
        ])
        await model.lookUp()
        model.picks.process = try first(Vocabulary.Process.self)

        model.reject()

        XCTAssertEqual(model.state, .pickList(.rejected))
        XCTAssertEqual(model.picks, API.BeanAttributes())
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts])
        XCTAssertFalse(model.canLookUp)
    }

    // MARK: - Other answers

    func testNoOpenFoodFactsProductLeadsToThePickListEntry() async throws {
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [status(404)],
        ])

        await model.lookUp()

        XCTAssertEqual(model.state, .pickList(.noProduct))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts])
        XCTAssertFalse(LookupModel.PickListReason.noProduct.allowsRetry)
    }

    func testA409FromOpenFoodFactsLooksTheBarcodeUpAgainAndUsesThatBean() async throws {
        let known = try bean(offProduct: product())
        let (model, server) = try makeModel([
            catalogue: [status(404), try json(known)],
            openFoodFacts: [status(409)],
        ])

        await model.lookUp()

        XCTAssertEqual(model.state, .bean(known))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, catalogue])
    }

    func testA409FromCreatingTheBeanLooksTheBarcodeUpAgainAndUsesThatBean() async throws {
        let known = try bean(verified: true)
        let (model, server) = try makeModel([
            catalogue: [status(404), try json(known)],
            openFoodFacts: [try json(product())],
            createBean: [status(409)],
        ])
        await model.lookUp()

        await model.confirm()

        XCTAssertEqual(model.state, .bean(known))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, createBean, catalogue])
    }

    func testA409ThenA404IsAFailureThatCanBeRetried() async throws {
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [status(409)],
        ])

        await model.lookUp()

        XCTAssertEqual(model.state, .pickList(.failed))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, catalogue])
        XCTAssertTrue(model.canLookUp)
    }

    func testA429FromOpenFoodFactsIsTheDailyLimit() async throws {
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [status(429)],
        ])

        await model.lookUp()

        XCTAssertEqual(model.state, .pickList(.limitReached))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts])
        XCTAssertFalse(model.canLookUp)
    }

    func testA429FromTheCatalogueIsThrottlingNotTheDailyLimit() async throws {
        let (model, server) = try makeModel([catalogue: [status(429)]])

        await model.lookUp()

        XCTAssertEqual(model.state, .pickList(.unavailable))
        XCTAssertEqual(calls(server), [catalogue])
    }

    func testA503OffersRetryAndARetryCanSucceed() async throws {
        let hit = product()
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [status(503), try json(hit)],
        ])

        await model.lookUp()
        XCTAssertEqual(model.state, .pickList(.unavailable))
        XCTAssertTrue(model.canLookUp)

        await model.lookUp()
        XCTAssertEqual(model.state, .openFoodFacts(hit))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, catalogue, openFoodFacts])
    }

    func testNoNetworkIsUnavailable() async throws {
        let server = try StubServer { _ in throw URLError(.notConnectedToInternet) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        let model = LookupModel(barcode: try barcode(), client: client)

        await model.lookUp()

        XCTAssertEqual(model.state, .pickList(.unavailable))
        XCTAssertEqual(calls(server), [catalogue])
    }

    func testAFailedConfirmationIsUnavailableAndARetryStartsOver() async throws {
        let created = try bean(offProduct: product())
        let (model, server) = try makeModel([
            catalogue: [status(404)],
            openFoodFacts: [try json(product())],
            createBean: [status(503), try json(created, status: 201)],
        ])
        await model.lookUp()

        await model.confirm()
        XCTAssertEqual(model.state, .pickList(.unavailable))

        await model.lookUp()
        await model.confirm()
        XCTAssertEqual(model.state, .bean(created))
        XCTAssertEqual(calls(server), [catalogue, openFoodFacts, createBean, catalogue, openFoodFacts, createBean])
    }

    func testAnUndecodableAnswerOrABadRequestIsAFailure() async throws {
        let (undecodable, first) = try makeModel([catalogue: [StubResponse(status: 200, body: Data("{}".utf8))]])
        await undecodable.lookUp()
        XCTAssertEqual(undecodable.state, .pickList(.failed))
        XCTAssertEqual(calls(first), [catalogue])

        let (badRequest, second) = try makeModel([catalogue: [status(404)], openFoodFacts: [status(400)]])
        await badRequest.lookUp()
        XCTAssertEqual(badRequest.state, .pickList(.failed))
        XCTAssertEqual(calls(second), [catalogue, openFoodFacts])
    }

    // MARK: - Only the API host

    func testEveryPathContactsOnlyTheAPIHost() async throws {
        HostRecordingURLProtocol.reset()
        var servers: [StubServer] = []
        let scenarios: [[String: [StubResponse]]] = [
            [catalogue: [try json(try bean(offProduct: product()))]],
            [catalogue: [status(404)], openFoodFacts: [status(404)]],
            [catalogue: [status(404)], openFoodFacts: [status(429)]],
            [catalogue: [status(404)], openFoodFacts: [status(503)]],
            [catalogue: [status(404), try json(try bean())], openFoodFacts: [status(409)]],
            [
                catalogue: [status(404), try json(try bean())],
                openFoodFacts: [try json(product())],
                createBean: [status(409)],
            ],
            [
                catalogue: [status(404)],
                openFoodFacts: [try json(product())],
                createBean: [try json(try bean(offProduct: product()), status: 201)],
                "GET /catalogue_images/\(imageID)": [StubResponse(status: 200, body: jpeg)],
            ],
        ]
        for routes in scenarios {
            let (model, server) = try makeModel(routes)
            servers.append(server)
            await model.lookUp()
            if case .openFoodFacts(let hit) = model.state {
                if let imageID = hit.imageId {
                    _ = await model.image(imageID)
                }
                await model.confirm()
            }
        }

        let apiHosts = Set(servers.map(\.host))
        let seen = HostRecordingURLProtocol.hosts
        XCTAssertFalse(seen.isEmpty)
        for host in seen {
            XCTAssertTrue(apiHosts.contains(host), "a request went to \(host)")
            XCTAssertFalse(host.lowercased().contains("openfoodfacts"), "a request went to \(host)")
        }
        // Every request the recorder saw reached a stub server, so none was lost on the way.
        XCTAssertEqual(Set(seen), apiHosts)
        XCTAssertTrue(servers.allSatisfy { !$0.requests.isEmpty })
    }
}
