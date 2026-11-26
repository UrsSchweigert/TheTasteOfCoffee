import Foundation
import Observation

/// F1 steps 2 and 3 for one scanned barcode (M2-T14): the catalogue lookup, the Open Food Facts
/// lookup the backend makes for an unknown barcode, and the user's confirmation.
///
/// - The phone sends only the barcode, the confirmation and vocabulary ids (ADR 0005). It never
///   contacts Open Food Facts: name, brand and image come through our API, the image as a
///   server-stored copy (ADR 0011).
/// - Open Food Facts text is shown as plain text only and is never sent back or logged.
/// - Every failure ends in a state that offers the pick-list entry (M2-T22), except a 401
///   that `APIClient` could not fix with its refresh: that is `signInRequired`, which asks the
///   user to sign in again instead of offering a retry that would fail the same way (M2-T18).
///
/// From the bean the flow continues to the shelf entry (M2-T18, `AddToShelfBar`).
@MainActor
@Observable
final class LookupModel {
    /// Why the screen offers the pick-list entry instead of a bean.
    enum PickListReason: Equatable, Sendable {
        /// The user said the Open Food Facts hit is not their coffee.
        case rejected
        /// Open Food Facts has no product for the barcode (404).
        case noProduct
        /// The daily lookup limit is used up (429 from the Open Food Facts route).
        case limitReached
        /// The lookup is unavailable for now: 503, another 5xx, a throttled request or no network.
        case unavailable
        /// Any other failure, for example an answer the app cannot read.
        case failed

        /// Whether the scanned barcode can be kept as a pending bean (M2-T25): the lookup could
        /// not answer now, but will once online or tomorrow. The outbox looks it up later.
        var allowsKeepingForLater: Bool {
            switch self {
            case .unavailable, .limitReached: true
            case .rejected, .noProduct, .failed: false
            }
        }

        /// Whether "Try again" makes sense. A rejection, a missing product or the daily limit
        /// would only give the same answer.
        var allowsRetry: Bool {
            switch self {
            case .unavailable, .failed: true
            case .rejected, .noProduct, .limitReached: false
            }
        }
    }

    enum State: Equatable, Sendable {
        /// Nothing asked yet.
        case idle
        /// `GET /barcodes/{barcode}`, then possibly `GET /barcodes/{barcode}/open_food_facts`.
        case lookingUp
        /// The catalogue's bean for the barcode. "Add to Shelf" follows (M2-T18).
        case bean(API.Bean)
        /// An Open Food Facts hit, waiting for Confirm or Reject.
        case openFoodFacts(API.OpenFoodFactsProduct)
        /// `POST /beans` for the confirmed hit is under way.
        case confirming(API.OpenFoodFactsProduct)
        /// No bean: the pick-list entry is offered.
        case pickList(PickListReason)
        /// The barcode is kept as a pending bean in the local store (M2-T25), with this local
        /// id. It can go on the shelf now; the outbox looks it up once online.
        case pending(UUID)
        /// The server refused the token, also after a refresh (401, `APIError.unauthorized`):
        /// the user has to sign in again. No retry and no pick-list entry, which would be
        /// refused the same way.
        case signInRequired
    }

    /// Which route an error came from: only the Open Food Facts route has the daily lookup cap.
    private enum Route {
        case catalogue
        case openFoodFacts
        case createBean
    }

    let barcode: CanonicalBarcode
    private(set) var state: State = .idle
    /// Optional picks sent with the confirmation, stored by the server with source "user".
    var picks = API.BeanAttributes()

    private let client: APIClient

    init(barcode: CanonicalBarcode, client: APIClient) {
        self.barcode = barcode
        self.client = client
    }

    /// Whether `lookUp()` would start a lookup now.
    var canLookUp: Bool {
        switch state {
        case .idle:
            true
        case .pickList(let reason):
            reason.allowsRetry
        case .lookingUp, .bean, .openFoodFacts, .confirming, .signInRequired, .pending:
            false
        }
    }

    /// Whether `keepForLater(in:)` would keep the barcode now.
    var canKeepForLater: Bool {
        if case .pickList(let reason) = state {
            return reason.allowsKeepingForLater
        }
        return false
    }

    /// The lookup could not answer now (no network, unavailable, the daily cap): keeps the
    /// barcode as a pending bean in `store` (`AccountStore.pendingBean(barcode:)`), so it can go
    /// on the shelf and have brews at once. Nothing is sent now; the outbox looks the barcode up
    /// once online (M2-T25). Returns the bean's local id, nil when nothing was kept.
    @discardableResult
    func keepForLater(in store: AccountStore) -> UUID? {
        guard canKeepForLater else {
            return nil
        }
        do {
            let bean = try store.pendingBean(barcode: barcode)
            state = .pending(bean.localID)
            return bean.localID
        } catch {
            // The store could not save: nothing was kept, and the choice is offered again.
            return nil
        }
    }

    /// Looks the barcode up: the catalogue first, then, on a 404, Open Food Facts through the
    /// backend. Also "Try again" after a retryable failure. Does nothing while a lookup or a
    /// confirmation runs, or once there is an answer.
    func lookUp() async {
        guard canLookUp else {
            return
        }
        guard let path = barcode.lookupBarcode else {
            state = .pickList(.failed)
            return
        }
        state = .lookingUp
        do {
            state = .bean(try await client.lookupBarcode(path))
            return
        } catch APIError.notFound {
            // Unknown barcode, or its bean was rejected: ask Open Food Facts through the backend.
        } catch {
            state = LookupModel.failureState(after: error, on: .catalogue, otherwise: .idle)
            return
        }
        do {
            state = .openFoodFacts(try await client.lookupOpenFoodFacts(path))
        } catch APIError.notFound {
            state = .pickList(.noProduct)
        } catch APIError.conflict {
            // Someone added the barcode meanwhile: use that bean.
            await lookUpKnownBean(path)
        } catch {
            state = LookupModel.failureState(after: error, on: .openFoodFacts, otherwise: .idle)
        }
    }

    /// The user confirms the Open Food Facts hit: `POST /beans` with the barcode,
    /// `open_food_facts_confirmed`, the optional picks and the bundled vocabulary version.
    /// No Open Food Facts text is sent; the server copies it from its own cache.
    func confirm() async {
        guard case .openFoodFacts(let product) = state else {
            return
        }
        guard let path = barcode.lookupBarcode else {
            state = .pickList(.failed)
            return
        }
        state = .confirming(product)
        let request = API.BeanCreate(
            vocabularyVersion: Vocabulary.version,
            barcode: barcode.digits,
            openFoodFactsConfirmed: true,
            attributes: picks
        )
        do {
            state = .bean(try await client.createBean(request))
        } catch APIError.conflict {
            // The barcode already points to a bean (or the server has no hit for it any more):
            // look it up and use that bean.
            await lookUpKnownBean(path)
        } catch {
            state = LookupModel.failureState(after: error, on: .createBean, otherwise: .openFoodFacts(product))
        }
    }

    /// The user says the hit is not their coffee: the pick-list entry follows (M2-T22).
    func reject() {
        guard case .openFoodFacts = state else {
            return
        }
        picks = API.BeanAttributes()
        state = .pickList(.rejected)
    }

    /// The bytes of a catalogue image, through `GET /catalogue_images/{image_id}` (or the disk
    /// cache). Nil if the id is malformed or the image cannot be loaded; the screen then shows
    /// no image.
    func image(_ imageID: API.Id) async -> Data? {
        guard let id = ResourceID(imageID) else {
            return nil
        }
        return try? await client.catalogueImage(id)
    }

    /// `GET /barcodes/{barcode}` after a 409: the barcode points to a bean now.
    private func lookUpKnownBean(_ path: LookupBarcode) async {
        do {
            state = .bean(try await client.lookupBarcode(path))
        } catch APIError.notFound {
            // A 409 and then a 404 contradict each other; "Try again" starts over.
            state = .pickList(.failed)
        } catch {
            state = LookupModel.failureState(after: error, on: .catalogue, otherwise: .idle)
        }
    }

    /// The state after a failed call. A cancelled call goes back to `cancelled`, so the
    /// screen can ask again.
    private static func failureState(after error: any Error, on route: Route, otherwise cancelled: State) -> State {
        if error is CancellationError {
            return cancelled
        }
        guard let apiError = error as? APIError else {
            return .pickList(.failed)
        }
        switch apiError {
        case .unauthorized:
            return .signInRequired
        case .tooManyRequests:
            // Only the Open Food Facts route counts lookups against the daily cap. Elsewhere a
            // 429 is throttling, so it is "try again later".
            return .pickList(route == .openFoodFacts ? .limitReached : .unavailable)
        case .serviceUnavailable, .server, .transport:
            return .pickList(.unavailable)
        case .badRequest, .notFound, .conflict, .unexpectedStatus, .undecodable, .invalidResponse, .invalidRequest:
            return .pickList(.failed)
        }
    }
}
