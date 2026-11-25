import XCTest
@testable import Cupmark

/// Answers each `METHOD path` with its responses in turn; the last one repeats. Anything else
/// is a 500, so an unexpected request fails the test's expectations.
private final class BeanEntryRoutes: @unchecked Sendable {
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

/// `BeanEntryModel` (M2-T22) against a `URLProtocol` stub: the `POST /beans` body with and
/// without picks and barcode, the 409 lookup, the 400 that is never resent, and retries.
@MainActor
final class BeanEntryModelTests: XCTestCase {
    // MARK: - Fixtures

    /// A valid EAN-13 (check digit 1).
    private let digits = "4006381333931"
    private let beanID = "01JDQ6Y8Z5W4V3T2S1R0P9N8M1"
    private let createBean = "POST /beans"
    private var catalogue: String { "GET /barcodes/\(digits)" }

    private func barcode() throws -> CanonicalBarcode {
        try XCTUnwrap(CanonicalBarcode(digits))
    }

    private func first<T: CaseIterable>(_ type: T.Type) throws -> T {
        try XCTUnwrap(T.allCases.first, "\(T.self) has no entries")
    }

    private func last<T: CaseIterable>(_ type: T.Type) throws -> T {
        try XCTUnwrap(Array(T.allCases).last, "\(T.self) has no entries")
    }

    private func bean(barcode: String?, picked: API.BeanAttributes = API.BeanAttributes()) -> API.Bean {
        API.Bean(
            beanId: beanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            barcode: barcode,
            openFoodFactsMatch: false,
            openFoodFacts: nil,
            pickedAttributes: picked,
            operatorAttributes: API.BeanAttributes()
        )
    }

    private func json<T: Encodable>(_ value: T, status: Int = 200) throws -> StubResponse {
        StubResponse(status: status, body: try JSONEncoder().encode(value), headers: ["Content-Type": "application/json"])
    }

    private func status(_ code: Int) -> StubResponse {
        StubResponse(status: code)
    }

    private func makeModel(barcode: CanonicalBarcode?, _ routes: [String: [StubResponse]]) throws -> (BeanEntryModel, StubServer) {
        let table = BeanEntryRoutes(routes)
        let server = try StubServer { request in table.respond(to: request) }
        let client = APIClient(
            baseURL: server.baseURL,
            tokenProvider: FakeTokenProvider(),
            session: server.makeSession(),
            imageCache: nil
        )
        return (BeanEntryModel(barcode: barcode, client: client), server)
    }

    private func calls(_ server: StubServer) -> [String] {
        server.requests.map { "\($0.method) \($0.path)" }
    }

    /// The JSON object of the last request body.
    private func lastBody(_ server: StubServer) throws -> [String: Any] {
        let body = try XCTUnwrap(server.requests.last?.body)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    /// Every pick set: the first origin region, and the last entry of the other lists.
    private func allPicks() throws -> API.BeanAttributes {
        API.BeanAttributes(
            process: try last(Vocabulary.Process.self),
            roastLevel: try last(Vocabulary.RoastLevel.self),
            origin: try XCTUnwrap(Vocabulary.Origin.allCases.first { $0.country != nil }),
            species: try last(Vocabulary.Species.self),
            variety: try last(Vocabulary.Variety.self)
        )
    }

    // MARK: - The body

    func testNoPicksAndNoBarcodeSendOnlyTheVersionAndEmptyAttributes() async throws {
        let (model, server) = try makeModel(barcode: nil, [createBean: [try json(bean(barcode: nil), status: 201)]])

        await model.save()

        XCTAssertEqual(model.state, .saved(bean(barcode: nil)))
        XCTAssertEqual(calls(server), [createBean])
        let object = try lastBody(server)
        XCTAssertEqual(Set(object.keys), ["attributes", "vocabulary_version"])
        XCTAssertEqual(object["vocabulary_version"] as? Int, Vocabulary.version)
        XCTAssertEqual((object["attributes"] as? [String: Any])?.count, 0)
    }

    func testNoPicksWithABarcodeSendTheBarcodeButNoConfirmation() async throws {
        let saved = bean(barcode: digits)
        let (model, server) = try makeModel(barcode: try barcode(), [createBean: [try json(saved, status: 201)]])

        await model.save()

        XCTAssertEqual(model.state, .saved(saved))
        let object = try lastBody(server)
        // No Open Food Facts hit was confirmed on this path, so the flag is left out.
        XCTAssertEqual(Set(object.keys), ["attributes", "barcode", "vocabulary_version"])
        XCTAssertEqual(object["barcode"] as? String, digits)
        XCTAssertEqual(object["vocabulary_version"] as? Int, Vocabulary.version)
        XCTAssertEqual((object["attributes"] as? [String: Any])?.count, 0)
    }

    func testAllPicksWithoutABarcodeSendEveryAttributeAsItsVocabularyID() async throws {
        let picks = try allPicks()
        let saved = bean(barcode: nil, picked: picks)
        let (model, server) = try makeModel(barcode: nil, [createBean: [try json(saved, status: 201)]])
        model.picks = picks

        await model.save()

        XCTAssertEqual(model.state, .saved(saved))
        let object = try lastBody(server)
        XCTAssertEqual(Set(object.keys), ["attributes", "vocabulary_version"])
        let attributes = try XCTUnwrap(object["attributes"] as? [String: String])
        let origin = try XCTUnwrap(picks.origin)
        let species = try XCTUnwrap(picks.species)
        let process = try XCTUnwrap(picks.process)
        let variety = try XCTUnwrap(picks.variety)
        let roastLevel = try XCTUnwrap(picks.roastLevel)
        XCTAssertEqual(attributes, [
            "origin": origin.rawValue,
            "species": species.rawValue,
            "process": process.rawValue,
            "variety": variety.rawValue,
            "roast_level": roastLevel.rawValue,
        ])
    }

    func testAllPicksWithABarcodeSendBothAndMatchTheRequestProperty() async throws {
        let picks = try allPicks()
        let saved = bean(barcode: digits, picked: picks)
        let (model, server) = try makeModel(barcode: try barcode(), [createBean: [try json(saved, status: 201)]])
        model.picks = picks
        let expected = API.BeanCreate(vocabularyVersion: Vocabulary.version, barcode: digits, attributes: picks)
        XCTAssertEqual(model.request, expected)

        await model.save()

        let object = try lastBody(server)
        XCTAssertEqual(Set(object.keys), ["attributes", "barcode", "vocabulary_version"])
        XCTAssertEqual(object["barcode"] as? String, digits)
        XCTAssertEqual((object["attributes"] as? [String: String])?.count, 5)
        // What M2-T25 will queue is exactly what was sent.
        let sent = try JSONDecoder().decode(API.BeanCreate.self, from: try XCTUnwrap(server.requests.last?.body))
        XCTAssertEqual(sent, expected)
    }

    func testOtherAndUnknownAreSentAsTheirIDs() async throws {
        let picks = API.BeanAttributes(
            process: .other,
            origin: .unknown,
            species: .unknown,
            variety: .other
        )
        let (model, server) = try makeModel(barcode: nil, [createBean: [try json(bean(barcode: nil, picked: picks), status: 201)]])
        model.picks = picks

        await model.save()

        let object = try lastBody(server)
        let attributes = try XCTUnwrap(object["attributes"] as? [String: String])
        XCTAssertEqual(attributes, ["process": "other", "origin": "unknown", "species": "unknown", "variety": "other"])
    }

    // MARK: - Answers

    func testA409LooksUpTheBarcodesBeanAndUsesIt() async throws {
        let existing = bean(barcode: digits, picked: API.BeanAttributes(process: try first(Vocabulary.Process.self)))
        let (model, server) = try makeModel(barcode: try barcode(), [
            createBean: [status(409)],
            catalogue: [try json(existing)],
        ])

        await model.save()

        XCTAssertEqual(model.state, .saved(existing))
        XCTAssertEqual(calls(server), [createBean, catalogue])
    }

    func testA409ThenA404IsRetryableAndTheRetryStartsOver() async throws {
        let existing = bean(barcode: digits)
        let (model, server) = try makeModel(barcode: try barcode(), [
            createBean: [status(409)],
            catalogue: [status(404), try json(existing)],
        ])

        await model.save()
        XCTAssertEqual(model.state, .failed(.retryable))
        XCTAssertTrue(model.canSave)

        await model.save()
        XCTAssertEqual(model.state, .saved(existing))
        XCTAssertEqual(calls(server), [createBean, catalogue, createBean, catalogue])
    }

    func testA409WithoutABarcodeIsRetryableWithoutALookup() async throws {
        let (model, server) = try makeModel(barcode: nil, [createBean: [status(409)]])

        await model.save()

        XCTAssertEqual(model.state, .failed(.retryable))
        XCTAssertEqual(calls(server), [createBean])
    }

    func testA400IsShownAndTheSameBodyIsNeverSentAgain() async throws {
        let (model, server) = try makeModel(barcode: try barcode(), [createBean: [status(400)]])
        model.picks.species = try first(Vocabulary.Species.self)

        await model.save()
        XCTAssertEqual(model.state, .failed(.rejected))
        XCTAssertFalse(model.canSave)

        await model.save()
        XCTAssertEqual(calls(server), [createBean], "a 400 is not retried")
        XCTAssertEqual(model.state, .failed(.rejected))
    }

    func testAfterA400AChangedPickCanBeSaved() async throws {
        let saved = bean(barcode: nil)
        let (model, server) = try makeModel(barcode: nil, [createBean: [status(400), try json(saved, status: 201)]])
        model.picks.species = try first(Vocabulary.Species.self)
        await model.save()
        XCTAssertFalse(model.canSave)

        model.picks.species = try last(Vocabulary.Species.self)
        XCTAssertTrue(model.canSave)
        await model.save()

        XCTAssertEqual(model.state, .saved(saved))
        XCTAssertEqual(calls(server), [createBean, createBean])
    }

    func testOtherFailuresAreRetryable() async throws {
        for code in [429, 500, 503] {
            let saved = bean(barcode: nil)
            let (model, server) = try makeModel(barcode: nil, [createBean: [status(code), try json(saved, status: 201)]])

            await model.save()
            XCTAssertEqual(model.state, .failed(.retryable), "status \(code)")
            XCTAssertTrue(model.canSave, "status \(code)")

            await model.save()
            XCTAssertEqual(model.state, .saved(saved), "status \(code)")
            XCTAssertEqual(calls(server), [createBean, createBean], "status \(code)")
        }
    }

    func testNoNetworkIsRetryable() async throws {
        let server = try StubServer { _ in throw URLError(.notConnectedToInternet) }
        let client = APIClient(baseURL: server.baseURL, tokenProvider: FakeTokenProvider(), session: server.makeSession(), imageCache: nil)
        let model = BeanEntryModel(barcode: nil, client: client)

        await model.save()

        XCTAssertEqual(model.state, .failed(.retryable))
        XCTAssertTrue(model.canSave)
    }

    func testNothingIsSentOnceSaved() async throws {
        let saved = bean(barcode: nil)
        let (model, server) = try makeModel(barcode: nil, [createBean: [try json(saved, status: 201)]])

        await model.save()
        await model.save()

        XCTAssertEqual(calls(server), [createBean])
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.isEditable)
    }

    func testTheEntryStartsEditableWithNoPicks() throws {
        let configuration = URLSessionConfiguration.ephemeral
        let client = APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://unused.api.cupmark.test")),
            tokenProvider: FakeTokenProvider(),
            session: URLSession(configuration: configuration),
            imageCache: nil
        )
        let model = BeanEntryModel(barcode: try barcode(), client: client)
        XCTAssertEqual(model.state, .editing)
        XCTAssertEqual(model.picks, API.BeanAttributes())
        XCTAssertTrue(model.isEditable)
        XCTAssertTrue(model.canSave)
        XCTAssertEqual(model.barcode?.digits, digits)
    }

    // MARK: - Sign-in required (M2-T18)

    func testA401AsksForSignInAndIsNotSentAgain() async throws {
        let (model, server) = try makeModel(barcode: nil, [createBean: [status(401)]])

        await model.save()

        XCTAssertEqual(model.state, .failed(.signInRequired))
        XCTAssertFalse(model.canSave)
        await model.save()
        // The request and the client's one retry after its refresh, nothing more.
        XCTAssertEqual(calls(server), [createBean, createBean])
    }
}
