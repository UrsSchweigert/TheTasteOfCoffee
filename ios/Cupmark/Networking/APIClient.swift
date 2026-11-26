import Foundation

/// A page of a list route (`GET /shelf`, `/brews`, `/recipes`).
protocol APIPage: Decodable, Sendable {
    associatedtype Item: Sendable
    var items: [Item] { get }
    var nextCursor: API.Cursor? { get }
    var undecodableItems: [API.UndecodableItem] { get }
}

extension API.ShelfEntryPage: APIPage {}
extension API.BrewPage: APIPage {}
extension API.RecipePage: APIPage {}

/// Every item of a list route, collected page by page.
struct AllPages<Item: Sendable>: Sendable {
    /// The items that decoded, in the server's order.
    var items: [Item]
    /// The items that did not decode, from every page. `index` is the position on its page.
    var undecodableItems: [API.UndecodableItem]
    /// The number of pages fetched.
    var pageCount: Int
}

/// The Cupmark API (contracts/openapi.yaml), one method per operation the app calls.
///
/// - The base URL is injected (M2-T9 reads it from the stage configuration).
/// - Methods, paths and success statuses come from the generated `API.Endpoint` table. Path
///   parameters are `ResourceID` or `LookupBarcode` values only.
/// - Every request carries the bearer token of `tokenProvider`. The user is the token's
///   subject; no path, query or body names a user (invariant 3).
/// - On a 401 the client asks the provider to refresh once and retries once.
/// - Any status other than the route's success status throws an `APIError`. Error bodies are
///   not read. Nothing is logged, so no body, token or Open Food Facts text reaches a log
///   (docs/05, Security).
/// - Label photo bytes go to S3 with the presigned POST of `createLabelPhotoUpload` (M2-T24),
///   not through this client.
final class APIClient: Sendable {
    /// `limit` of every page that `allShelfEntries()`, `allBrews()` and `allRecipes()` fetch,
    /// the contract's maximum.
    static let pageLimit = 100
    /// The contract's `limit` range.
    static let limitRange = 1...100
    /// `allPages` gives up with `invalidResponse` after this many pages, 100,000 items at
    /// `pageLimit`, so a faulty server cannot keep it paging.
    static let maxPages = 1_000

    let baseURL: URL
    private let tokenProvider: any TokenProvider
    private let session: URLSession
    private let imageCache: CatalogueImageCache?

    init(
        baseURL: URL,
        tokenProvider: any TokenProvider,
        session: URLSession = APIClient.makeSession(),
        imageCache: CatalogueImageCache? = CatalogueImageCache.standard()
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
        self.imageCache = imageCache
    }

    /// A session that stores nothing on disk: no URL cache and no cookies. Responses hold the
    /// user's data; catalogue images are cached by `CatalogueImageCache` instead.
    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration)
    }

    // MARK: - Catalogue

    /// `GET /barcodes/{barcode}`. `notFound` when the catalogue has no bean for the barcode.
    func lookupBarcode(_ barcode: LookupBarcode) async throws -> API.Bean {
        let data = try await send(.lookupBarcode, path: ["barcode": barcode])
        return try decode(API.Bean.self, from: data)
    }

    /// `GET /barcodes/{barcode}/open_food_facts`. The name and brand are Open Food Facts text:
    /// shown for confirmation only, never logged and never sent back (ADR 0005).
    func lookupOpenFoodFacts(_ barcode: LookupBarcode) async throws -> API.OpenFoodFactsProduct {
        let data = try await send(.lookupOpenFoodFacts, path: ["barcode": barcode])
        return try decode(API.OpenFoodFactsProduct.self, from: data)
    }

    /// `POST /beans`.
    func createBean(_ bean: API.BeanCreate) async throws -> API.Bean {
        let data = try await send(.createBean, body: encode(bean))
        return try decode(API.Bean.self, from: data)
    }

    /// `GET /beans/{bean_id}`.
    func getBean(_ beanID: ResourceID) async throws -> API.Bean {
        let data = try await send(.getBean, path: ["bean_id": beanID])
        return try decode(API.Bean.self, from: data)
    }

    /// `GET /catalogue_images/{image_id}`: the JPEG bytes, loaded with the token and cached on
    /// disk by id. A cached image is returned without a request.
    func catalogueImage(_ imageID: ResourceID) async throws -> Data {
        if let cached = await imageCache?.data(for: imageID) {
            return cached
        }
        let data = try await send(.getCatalogueImage, path: ["image_id": imageID])
        guard data.starts(with: [0xFF, 0xD8, 0xFF]) else {
            throw APIError.invalidResponse
        }
        await imageCache?.store(data, for: imageID)
        return data
    }

    // MARK: - Label photos (ADR 0016)

    /// `POST /beans/{bean_id}/label_photos`: a photo id and the presigned S3 POST for it.
    func createLabelPhotoUpload(beanID: ResourceID) async throws -> API.LabelPhotoUpload {
        let data = try await send(.createLabelPhotoUpload, path: ["bean_id": beanID])
        return try decode(API.LabelPhotoUpload.self, from: data)
    }

    /// `POST /label_photos/{photo_id}/complete`, after the upload to S3 succeeded.
    func completeLabelPhoto(photoID: ResourceID) async throws {
        _ = try await send(.completeLabelPhoto, path: ["photo_id": photoID])
    }

    // MARK: - Shelf

    /// `GET /shelf`, one page.
    func listShelfEntries(cursor: API.Cursor? = nil, limit: Int? = nil) async throws -> API.ShelfEntryPage {
        let data = try await send(.listShelfEntries, query: pageQuery(cursor: cursor, limit: limit))
        return try decode(API.ShelfEntryPage.self, from: data)
    }

    /// `GET /shelf`, every page.
    func allShelfEntries() async throws -> AllPages<API.ShelfEntry> {
        try await allPages { cursor in
            try await self.listShelfEntries(cursor: cursor, limit: APIClient.pageLimit)
        }
    }

    /// `POST /shelf`.
    func createShelfEntry(_ entry: API.ShelfEntryInput) async throws -> API.ShelfEntry {
        let data = try await send(.createShelfEntry, body: encode(entry))
        return try decode(API.ShelfEntry.self, from: data)
    }

    /// `GET /shelf/{shelf_entry_id}`.
    func getShelfEntry(_ shelfEntryID: ResourceID) async throws -> API.ShelfEntry {
        let data = try await send(.getShelfEntry, path: ["shelf_entry_id": shelfEntryID])
        return try decode(API.ShelfEntry.self, from: data)
    }

    /// `PUT /shelf/{shelf_entry_id}`. `conflict` when the bean changes while brews reference the entry.
    func replaceShelfEntry(_ shelfEntryID: ResourceID, with entry: API.ShelfEntryInput) async throws -> API.ShelfEntry {
        let data = try await send(.replaceShelfEntry, path: ["shelf_entry_id": shelfEntryID], body: encode(entry))
        return try decode(API.ShelfEntry.self, from: data)
    }

    /// `DELETE /shelf/{shelf_entry_id}`. `conflict` while brews reference the entry.
    func deleteShelfEntry(_ shelfEntryID: ResourceID) async throws {
        _ = try await send(.deleteShelfEntry, path: ["shelf_entry_id": shelfEntryID])
    }

    // MARK: - Brews

    /// `GET /brews`, one page, newest first.
    func listBrews(cursor: API.Cursor? = nil, limit: Int? = nil) async throws -> API.BrewPage {
        let data = try await send(.listBrews, query: pageQuery(cursor: cursor, limit: limit))
        return try decode(API.BrewPage.self, from: data)
    }

    /// `GET /brews`, every page.
    func allBrews() async throws -> AllPages<API.Brew> {
        try await allPages { cursor in
            try await self.listBrews(cursor: cursor, limit: APIClient.pageLimit)
        }
    }

    /// `POST /brews`.
    func createBrew(_ brew: API.BrewInput) async throws -> API.Brew {
        let data = try await send(.createBrew, body: encode(brew))
        return try decode(API.Brew.self, from: data)
    }

    /// `GET /brews/{brew_id}`.
    func getBrew(_ brewID: ResourceID) async throws -> API.Brew {
        let data = try await send(.getBrew, path: ["brew_id": brewID])
        return try decode(API.Brew.self, from: data)
    }

    /// `PUT /brews/{brew_id}`.
    func replaceBrew(_ brewID: ResourceID, with brew: API.BrewInput) async throws -> API.Brew {
        let data = try await send(.replaceBrew, path: ["brew_id": brewID], body: encode(brew))
        return try decode(API.Brew.self, from: data)
    }

    /// `DELETE /brews/{brew_id}`.
    func deleteBrew(_ brewID: ResourceID) async throws {
        _ = try await send(.deleteBrew, path: ["brew_id": brewID])
    }

    // MARK: - Recipes

    /// `GET /recipes`, one page.
    func listRecipes(cursor: API.Cursor? = nil, limit: Int? = nil) async throws -> API.RecipePage {
        let data = try await send(.listRecipes, query: pageQuery(cursor: cursor, limit: limit))
        return try decode(API.RecipePage.self, from: data)
    }

    /// `GET /recipes`, every page.
    func allRecipes() async throws -> AllPages<API.Recipe> {
        try await allPages { cursor in
            try await self.listRecipes(cursor: cursor, limit: APIClient.pageLimit)
        }
    }

    /// `POST /recipes`.
    func createRecipe(_ recipe: API.RecipeInput) async throws -> API.Recipe {
        let data = try await send(.createRecipe, body: encode(recipe))
        return try decode(API.Recipe.self, from: data)
    }

    /// `GET /recipes/{recipe_id}`.
    func getRecipe(_ recipeID: ResourceID) async throws -> API.Recipe {
        let data = try await send(.getRecipe, path: ["recipe_id": recipeID])
        return try decode(API.Recipe.self, from: data)
    }

    /// `PUT /recipes/{recipe_id}`.
    func replaceRecipe(_ recipeID: ResourceID, with recipe: API.RecipeInput) async throws -> API.Recipe {
        let data = try await send(.replaceRecipe, path: ["recipe_id": recipeID], body: encode(recipe))
        return try decode(API.Recipe.self, from: data)
    }

    /// `DELETE /recipes/{recipe_id}`.
    func deleteRecipe(_ recipeID: ResourceID) async throws {
        _ = try await send(.deleteRecipe, path: ["recipe_id": recipeID])
    }

    // MARK: - Profile, export and account

    /// `GET /profile`. `notFound` while there is no profile yet (onboarding, M2-T29).
    func getProfile() async throws -> API.Profile {
        let data = try await send(.getProfile)
        return try decode(API.Profile.self, from: data)
    }

    /// `PUT /profile`.
    func putProfile(_ profile: API.Profile) async throws -> API.Profile {
        let data = try await send(.putProfile, body: encode(profile))
        return try decode(API.Profile.self, from: data)
    }

    /// `GET /export`: the CSV file, as received.
    func exportData() async throws -> Data {
        try await send(.exportData)
    }

    /// `DELETE /account`. Safe to repeat until it answers 204 (ADR 0017). `tokens` replaces the
    /// client's token provider for this request; account deletion passes an
    /// `AccountTokenProvider`, so the request never carries another account's token (M2-T31).
    func deleteAccount(tokens: (any TokenProvider)? = nil) async throws {
        _ = try await send(.deleteAccount, tokens: tokens)
    }

    // MARK: - Paging

    /// Fetches pages with `fetch`, following `next_cursor` until a page has none. A cursor
    /// that repeats or breaks the contract's pattern, or more than `maxPages` pages, throws
    /// `invalidResponse`, so a faulty server cannot keep the loop going.
    func allPages<Page: APIPage>(_ fetch: (API.Cursor?) async throws -> Page) async throws -> AllPages<Page.Item> {
        var result = AllPages<Page.Item>(items: [], undecodableItems: [], pageCount: 0)
        var cursor: API.Cursor?
        var seen = Set<API.Cursor>()
        repeat {
            let page = try await fetch(cursor)
            result.items += page.items
            result.undecodableItems += page.undecodableItems
            result.pageCount += 1
            cursor = page.nextCursor
            if let next = cursor {
                guard result.pageCount < APIClient.maxPages,
                      APIClient.isValidCursor(next),
                      seen.insert(next).inserted else {
                    throw APIError.invalidResponse
                }
            }
        } while cursor != nil
        return result
    }

    /// True if `cursor` matches the contract's `Cursor` pattern, `^[A-Za-z0-9_-]{1,512}$`.
    static func isValidCursor(_ cursor: API.Cursor) -> Bool {
        (1...512).contains(cursor.utf8.count) && cursor.utf8.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "_"),
                 UInt8(ascii: "-"):
                return true
            default:
                return false
            }
        }
    }

    // MARK: - Requests

    /// The `cursor` and `limit` query of a list route. Both are optional.
    private func pageQuery(cursor: API.Cursor?, limit: Int?) throws -> [URLQueryItem] {
        var query: [URLQueryItem] = []
        if let cursor {
            guard APIClient.isValidCursor(cursor) else {
                throw APIError.invalidRequest
            }
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        if let limit {
            guard APIClient.limitRange.contains(limit) else {
                throw APIError.invalidRequest
            }
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        return query
    }

    /// The URL of `endpoint` with every `{name}` of its path replaced by a typed value.
    func makeURL(
        for endpoint: API.Endpoint,
        path values: [String: any APIPathValue] = [:],
        query: [URLQueryItem] = []
    ) throws -> URL {
        var path = endpoint.path
        for (name, value) in values {
            let placeholder = "{\(name)}"
            guard path.contains(placeholder) else {
                throw APIError.invalidRequest
            }
            path = path.replacingOccurrences(of: placeholder, with: value.pathSegment)
        }
        guard !path.contains("{"),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidRequest
        }
        var basePath = components.percentEncodedPath
        if basePath.hasSuffix("/") {
            basePath.removeLast()
        }
        components.percentEncodedPath = basePath + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw APIError.invalidRequest
        }
        return url
    }

    /// Sends one request and returns the body of the route's success status. On a 401 it asks
    /// the token provider to refresh once and sends the request once more.
    private func send(
        _ endpoint: API.Endpoint,
        path: [String: any APIPathValue] = [:],
        query: [URLQueryItem] = [],
        body: Data? = nil,
        tokens: (any TokenProvider)? = nil
    ) async throws -> Data {
        let provider = tokens ?? tokenProvider
        let url = try makeURL(for: endpoint, path: path, query: query)
        var response = try await perform(endpoint, url: url, body: body, token: accessToken(from: provider))
        if response.status == 401 {
            do {
                try await provider.refresh()
            } catch {
                if Task.isCancelled || error is CancellationError {
                    throw CancellationError()
                }
                throw APIClient.tokenFailure(error)
            }
            try Task.checkCancellation()
            response = try await perform(endpoint, url: url, body: body, token: accessToken(from: provider))
        }
        guard response.status == endpoint.successStatus else {
            throw APIError(status: response.status)
        }
        return response.data
    }

    /// The provider's token; `unauthorized` when it has none, `transport` when it could not be
    /// refreshed for lack of a network.
    private func accessToken(from provider: any TokenProvider) async throws -> String {
        do {
            return try await provider.currentAccessToken()
        } catch {
            if Task.isCancelled || error is CancellationError {
                throw CancellationError()
            }
            throw APIClient.tokenFailure(error)
        }
    }

    /// What a failure of the token provider becomes (M2-T11). Only a failure that means
    /// "sign in again" is `unauthorized`; a failure of Cognito itself is retryable, so the
    /// outbox backs off instead of signing the user out:
    /// - a network failure while refreshing stays `transport`;
    /// - a Cognito 5xx, or a token response the app cannot use, is `serviceUnavailable`;
    /// - a Cognito 429 is `tooManyRequests`;
    /// - anything else (`invalid_grant` as `sessionExpired`, no saved sign-in, an account
    ///   mismatch, another 4xx, a Keychain failure) is `unauthorized`.
    static func tokenFailure(_ error: any Error) -> APIError {
        if let apiError = error as? APIError, case .transport = apiError {
            return apiError
        }
        switch error as? AuthError {
        case .server(let status) where (500...599).contains(status):
            return .serviceUnavailable
        case .server(429):
            return .tooManyRequests
        case .invalidResponse:
            return .serviceUnavailable
        default:
            return .unauthorized
        }
    }

    private func perform(_ endpoint: API.Endpoint, url: URL, body: Data?, token: String) async throws -> (data: Data, status: Int) {
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Bearer header set per request on purpose: the session has no auth-challenge delegate.
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let accept = endpoint.responseContentType {
            request.setValue(accept, forHTTPHeaderField: "Accept")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            // A cancelled task makes URLSession throw URLError(.cancelled): that is cancellation,
            // never a transport failure to retry.
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            throw APIError.transport((error as? URLError)?.code ?? .unknown)
        }
        guard let http = result.1 as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        return (data: result.0, status: http.statusCode)
    }

    private func encode<Value: Encodable>(_ value: Value) throws -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw APIError.invalidRequest
        }
    }

    /// Decodes a success body. The decoding error is dropped, since it can quote server data.
    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.undecodable
        }
    }
}
