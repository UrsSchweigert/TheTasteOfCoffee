import Foundation
import XCTest
@testable import Cupmark

/// A small in-memory Cupmark API for the outbox tests (M2-T16), served through
/// `StubServer`, which records every request.
final class FakeSyncServer: @unchecked Sendable {
    let backend: FakeSyncBackend
    let stub: StubServer

    init() throws {
        let backend = FakeSyncBackend()
        self.backend = backend
        stub = try StubServer { request in try backend.respond(request) }
    }

    /// The requests so far, as `METHOD /path`.
    var log: [String] {
        stub.requests.map { request in "\(request.method) \(request.path)" }
    }

    var requests: [RecordedRequest] { stub.requests }

    /// A client whose requests go to this server.
    func client(tokens: any TokenProvider = FakeTokenProvider()) -> APIClient {
        APIClient(baseURL: stub.baseURL, tokenProvider: tokens, session: stub.makeSession(), imageCache: nil)
    }
}

/// The state and answers of `FakeSyncServer`. It keeps beans, shelf entries, brews, recipes
/// and the profile, answers the routes the engine uses with their contract statuses, and
/// lets a test answer any request itself first (`setOverride`).
final class FakeSyncBackend: @unchecked Sendable {
    /// Answers a request before the fake does; nil lets the fake answer. Throw a `URLError`
    /// to fail the request in transport.
    typealias Override = @Sendable (RecordedRequest) throws -> StubResponse?

    private let lock = NSLock()
    private var nextID = 1
    private var beans: [String: API.Bean] = [:]
    private var shelf: [String: API.ShelfEntryInput] = [:]
    private var brews: [String: API.BrewInput] = [:]
    private var recipes: [String: API.RecipeInput] = [:]
    private var profile: API.Profile?
    /// Open Food Facts products by 13-digit barcode, as the server's cache holds them (M2-T25).
    private var openFoodFacts: [String: API.OpenFoodFactsProduct] = [:]
    private var override: Override?

    func setOverride(_ override: Override?) {
        lock.withLock { self.override = override }
    }

    /// A new server-style id: a ULID of 26 Crockford base32 characters.
    func makeID() -> String {
        lock.withLock {
            defer { nextID += 1 }
            return FakeSyncBackend.id(nextID)
        }
    }

    static func id(_ n: Int) -> String {
        "01JDQ6Y8Z5W4V3T2S1R0P9" + String(format: "%04d", n)
    }

    // MARK: - Seeding and reading the server's state

    func seed(bean: API.Bean) {
        lock.withLock { beans[bean.beanId] = bean }
    }

    func seed(shelfEntry id: String, _ values: API.ShelfEntryInput) {
        lock.withLock { shelf[id] = values }
    }

    func seed(brew id: String, _ values: API.BrewInput) {
        lock.withLock { brews[id] = values }
    }

    func seed(recipe id: String, _ values: API.RecipeInput) {
        lock.withLock { recipes[id] = values }
    }

    func seed(profile values: API.Profile?) {
        lock.withLock { profile = values }
    }

    /// An Open Food Facts hit for `barcode` (M2-T25).
    func seed(openFoodFacts product: API.OpenFoodFactsProduct, barcode: String) {
        lock.withLock { openFoodFacts[barcode] = product }
    }

    /// Removes an item as another device would (M2-T17).
    func remove(shelfEntry id: String) {
        lock.withLock { shelf[id] = nil }
    }

    func remove(brew id: String) {
        lock.withLock { brews[id] = nil }
    }

    func remove(recipe id: String) {
        lock.withLock { recipes[id] = nil }
    }

    var storedProfile: API.Profile? { lock.withLock { profile } }

    var shelfEntries: [String: API.ShelfEntryInput] { lock.withLock { shelf } }
    var storedBrews: [String: API.BrewInput] { lock.withLock { brews } }
    var storedRecipes: [String: API.RecipeInput] { lock.withLock { recipes } }
    var storedBeans: [String: API.Bean] { lock.withLock { beans } }

    // MARK: - Answers

    func respond(_ request: RecordedRequest) throws -> StubResponse {
        if let override = lock.withLock({ self.override }), let answer = try override(request) {
            return answer
        }
        let parts = request.path.split(separator: "/").map(String.init)
        return try lock.withLock { () throws -> StubResponse in
            switch (request.method, parts.first ?? "", parts.count) {
            case ("POST", "beans", 1):
                let create = try decode(API.BeanCreate.self, request)
                // As the backend: a barcode has one bean, and a confirmation needs a cached hit.
                if let barcode = create.barcode, beans.values.contains(where: { bean in bean.barcode == barcode }) {
                    return StubResponse(status: 409)
                }
                var product: API.OpenFoodFactsProduct?
                if create.openFoodFactsConfirmed == true {
                    guard let barcode = create.barcode, let hit = openFoodFacts[barcode] else {
                        return StubResponse(status: 409)
                    }
                    product = hit
                }
                let bean = API.Bean(
                    beanId: nextServerID(),
                    vocabularyVersion: create.vocabularyVersion,
                    verified: false,
                    barcode: create.barcode,
                    openFoodFactsMatch: product != nil,
                    openFoodFacts: product,
                    pickedAttributes: create.attributes,
                    operatorAttributes: API.BeanAttributes()
                )
                beans[bean.beanId] = bean
                return try reply(201, bean)
            case ("GET", "beans", 2):
                return try beans[parts[1]].map { bean in try reply(200, bean) } ?? StubResponse(status: 404)
            case ("GET", "barcodes", 2):
                return try beans.values.first { bean in bean.barcode == parts[1] }.map { bean in try reply(200, bean) } ?? StubResponse(status: 404)
            case ("GET", "barcodes", 3) where parts[2] == "open_food_facts":
                if beans.values.contains(where: { bean in bean.barcode == parts[1] }) {
                    return StubResponse(status: 409)
                }
                return try openFoodFacts[parts[1]].map { product in try reply(200, product) } ?? StubResponse(status: 404)

            case ("POST", "shelf", 1):
                let values = try decode(API.ShelfEntryInput.self, request)
                guard beans[values.beanId] != nil else {
                    return StubResponse(status: 404)
                }
                let id = nextServerID()
                shelf[id] = values
                return try reply(201, API.ShelfEntry(shelfEntryId: id, values: values))
            case ("GET", "shelf", 1):
                let page = try FakeSyncBackend.page(shelf.sorted { $0.key < $1.key }, request)
                return try reply(200, API.ShelfEntryPage(items: page.items.map { API.ShelfEntry(shelfEntryId: $0.key, values: $0.value) }, nextCursor: page.next))
            case ("GET", "shelf", 2):
                return try shelf[parts[1]].map { values in try reply(200, API.ShelfEntry(shelfEntryId: parts[1], values: values)) } ?? StubResponse(status: 404)
            case ("PUT", "shelf", 2):
                let values = try decode(API.ShelfEntryInput.self, request)
                guard let old = shelf[parts[1]] else {
                    return StubResponse(status: 404)
                }
                let hasBrews = brews.values.contains { brew in brew.shelfEntryId == parts[1] }
                if hasBrews, old.beanId != values.beanId {
                    return StubResponse(status: 409)
                }
                shelf[parts[1]] = values
                return try reply(200, API.ShelfEntry(shelfEntryId: parts[1], values: values))
            case ("DELETE", "shelf", 2):
                guard shelf[parts[1]] != nil else {
                    return StubResponse(status: 404)
                }
                if brews.values.contains(where: { brew in brew.shelfEntryId == parts[1] }) {
                    return StubResponse(status: 409)
                }
                shelf[parts[1]] = nil
                return StubResponse(status: 204)

            case ("POST", "brews", 1):
                let values = try decode(API.BrewInput.self, request)
                guard shelf[values.shelfEntryId] != nil else {
                    return StubResponse(status: 404)
                }
                let id = nextServerID()
                brews[id] = values
                return try reply(201, API.Brew(brewId: id, values: values))
            case ("GET", "brews", 1):
                let page = try FakeSyncBackend.page(brews.sorted { $0.key < $1.key }, request)
                return try reply(200, API.BrewPage(items: page.items.map { API.Brew(brewId: $0.key, values: $0.value) }, nextCursor: page.next))
            case ("GET", "brews", 2):
                return try brews[parts[1]].map { values in try reply(200, API.Brew(brewId: parts[1], values: values)) } ?? StubResponse(status: 404)
            case ("PUT", "brews", 2):
                let values = try decode(API.BrewInput.self, request)
                guard brews[parts[1]] != nil else {
                    return StubResponse(status: 404)
                }
                brews[parts[1]] = values
                return try reply(200, API.Brew(brewId: parts[1], values: values))
            case ("DELETE", "brews", 2):
                guard brews.removeValue(forKey: parts[1]) != nil else {
                    return StubResponse(status: 404)
                }
                return StubResponse(status: 204)

            case ("POST", "recipes", 1):
                let values = try decode(API.RecipeInput.self, request)
                let id = nextServerID()
                recipes[id] = values
                return try reply(201, API.Recipe(recipeId: id, values: values))
            case ("GET", "recipes", 1):
                let page = try FakeSyncBackend.page(recipes.sorted { $0.key < $1.key }, request)
                return try reply(200, API.RecipePage(items: page.items.map { API.Recipe(recipeId: $0.key, values: $0.value) }, nextCursor: page.next))
            case ("GET", "recipes", 2):
                return try recipes[parts[1]].map { values in try reply(200, API.Recipe(recipeId: parts[1], values: values)) } ?? StubResponse(status: 404)
            case ("PUT", "recipes", 2):
                let values = try decode(API.RecipeInput.self, request)
                guard recipes[parts[1]] != nil else {
                    return StubResponse(status: 404)
                }
                recipes[parts[1]] = values
                return try reply(200, API.Recipe(recipeId: parts[1], values: values))
            case ("DELETE", "recipes", 2):
                guard recipes.removeValue(forKey: parts[1]) != nil else {
                    return StubResponse(status: 404)
                }
                return StubResponse(status: 204)

            case ("GET", "profile", 1):
                return try profile.map { values in try reply(200, values) } ?? StubResponse(status: 404)
            case ("PUT", "profile", 1):
                let values = try decode(API.Profile.self, request)
                profile = values
                return try reply(200, values)
            default:
                return StubResponse(status: 500)
            }
        }
    }

    /// One page of a list route: `limit` items (the contract's default, 50, without one)
    /// after the offset in `cursor` (`o<offset>`), and the cursor of the next page.
    static func page<Item>(_ all: [Item], _ request: RecordedRequest) throws -> (items: [Item], next: String?) {
        let query = request.queryItems
        let limit = query.first { item in item.name == "limit" }?.value.flatMap { value in Int(value) } ?? 50
        var offset = 0
        if let cursor = query.first(where: { item in item.name == "cursor" })?.value {
            guard cursor.hasPrefix("o"), let value = Int(cursor.dropFirst()) else {
                throw URLError(.badServerResponse)
            }
            offset = value
        }
        let start = min(offset, all.count)
        let end = min(start + max(1, limit), all.count)
        return (Array(all[start..<end]), end < all.count ? "o\(end)" : nil)
    }

    /// Called with the lock held.
    private func nextServerID() -> String {
        defer { nextID += 1 }
        return FakeSyncBackend.id(nextID)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ request: RecordedRequest) throws -> T {
        try JSONDecoder().decode(type, from: request.body ?? Data())
    }

    private func reply<T: Encodable>(_ status: Int, _ value: T) throws -> StubResponse {
        StubResponse(status: status, body: try JSONEncoder().encode(value))
    }
}
