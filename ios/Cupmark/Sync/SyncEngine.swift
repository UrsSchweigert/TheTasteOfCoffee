import Foundation
import SwiftData

/// The items that have a server id: everything but the profile.
protocol ServerIdentified: SyncTracked {
    var serverID: String? { get set }
}

extension StoredBean: ServerIdentified {}
extension StoredShelfEntry: ServerIdentified {}
extension StoredBrew: ServerIdentified {}
extension StoredRecipe: ServerIdentified {}

/// Sends one account's outbox (M2-T16, ADR 0025).
///
/// - One engine per account store. It sends one operation at a time, lowest sequence first,
///   and never starts the next before the current one has an outcome. A retry holds the
///   queue: later operations wait behind it, so the order of the user's writes is kept (and
///   two brew writes on one shelf entry never race, ADR 0012).
/// - The body of an operation is built from the item when it is sent. A shelf entry names
///   its bean and a brew its shelf entry through the local relationship, so the body carries
///   whatever server id the referenced item has by then. The referenced item's own create is
///   always earlier in the queue; if it was parked, the dependent operation is parked too.
/// - Answers (`APIError`, after `APIClient`'s one refresh and retry on a 401):
///   2xx stores the server id and values; 400 parks and flags the item; a network failure,
///   429, 503 and other 5xx back off (`SyncBackoff`, jitter) and retry; `unauthorized`
///   stops the engine and asks for sign-in, keeping every operation; 404 on a delete is
///   done; 409 on a shelf delete restores the entry;
///   409 on a shelf replace reverts the bean (D14) and sends the rest again. A 404 on a
///   replace is followed by a read of the item: 404 removes the local item, 200 means a
///   reference was refused and parks the operation.
/// - A create that was sent without a clear answer (`sentWithoutAnswer`, also after the
///   app was ended mid-request) is checked first: the engine lists the resource and adopts a
///   server item that matches and has no local counterpart, instead of creating a duplicate.
/// - A pending bean (M2-T25) is looked up when its `lookUp` operation comes: `GET
///   /barcodes/{barcode}` (a known bean is used), then Open Food Facts through the backend (a
///   miss is created as it is, a hit waits for the user's confirmation). A look-up that cannot
///   run now waits for its next attempt without holding the queue: only the operations of
///   items that name its bean wait with it (`AccountStore.nextOutboxOperation(at:)`).
///
/// - When the outbox is empty the run loop runs `onIdle` in the drain's slot: `SyncHost`
///   pulls there (M2-T17), so a pull never overlaps a drain and local writes go out first.
///
/// It runs on the main actor, where the app's `AccountStore` and its `ModelContext` live, so
/// the screens and the engine work on one context and never see stale copies of each
/// other's changes. Only the requests leave the main actor. Every item and operation is
/// fetched again after a request, since the user may have changed or removed it meanwhile.
@MainActor
final class SyncEngine {
    enum DrainResult: Equatable, Sendable {
        /// Nothing is left to send now: parked operations are not counted, nor a bean look-up
        /// that waits and the operations that wait for its bean (M2-T25).
        case idle
        /// The next operation backs off until then.
        case waiting(until: Date)
        /// The server refused the token, also after a refresh. The operations are kept.
        case signInRequired
        /// `stop()` was called or the task was cancelled.
        case stopped
        /// Another drain is running.
        case busy
    }

    let store: AccountStore
    private let client: APIClient
    private let backoff: SyncBackoff
    private let now: @Sendable () -> Date
    private let jitter: @Sendable () -> Double
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    /// Whether the engine's account is still the signed-in one. Asked before every request;
    /// false stops the engine, so nothing goes out with another account's token.
    private let isCurrentAccount: @Sendable () async -> Bool
    /// How long the run loop waits with an empty outbox before it looks again by itself.
    private let idleWait: TimeInterval

    /// Called once when the engine stops because the user must sign in again.
    var onSignInRequired: (@MainActor () -> Void)?

    /// What `onIdle` asks the engine to do next.
    enum IdleOutcome: Equatable, Sendable {
        /// Rest until a `kick()`, the backoff or `idleWait`, as usual.
        case done
        /// The server refused the token: stop like a drain that got `unauthorized`.
        case signInRequired
    }

    /// Work that must not overlap a drain, run by the run loop each time the outbox is empty
    /// (`SyncHost` pulls here, M2-T17). While it runs, `drain()` answers `.busy`; a `kick()`
    /// meanwhile makes the loop drain again as soon as it returns.
    var onIdle: (@MainActor () async -> IdleOutcome)?

    /// The next moment the idle work wants to run again by itself (`SyncHost`: the label photo
    /// queue's next attempt), nil for none. The run loop rests no longer than that.
    var nextIdleWake: (@MainActor () -> Date?)?

    /// How long a bean look-up waits after the daily Open Food Facts lookup cap answered 429
    /// (M2-T25). Other operations go out meanwhile.
    nonisolated static let lookUpLimitWait: TimeInterval = 3600

    /// How many operations the engine finished (sent, parked or dropped) since it was made.
    /// `SyncHost` pulls again when this has changed since its last pull.
    private(set) var finishedOperations = 0

    private(set) var isStopped = false
    private(set) var needsSignIn = false
    private var isDraining = false
    private var loop: Task<Void, Never>?
    private var nap: Task<Void, Never>?
    private var kicked = false

    init(
        store: AccountStore,
        client: APIClient,
        backoff: SyncBackoff = SyncBackoff(),
        now: @escaping @Sendable () -> Date = { Date() },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in try await Task.sleep(for: .seconds(seconds)) },
        idleWait: TimeInterval = 3600,
        isCurrentAccount: @escaping @Sendable () async -> Bool = { true }
    ) {
        self.store = store
        self.client = client
        self.backoff = backoff
        self.now = now
        self.jitter = jitter
        self.sleep = sleep
        self.idleWait = idleWait
        self.isCurrentAccount = isCurrentAccount
    }

    // MARK: - Running

    /// Starts the run loop: drain, then wait for the backoff, a `kick()` or `idleWait`.
    func start() {
        guard loop == nil, !isStopped, !needsSignIn else {
            return
        }
        loop = Task { [weak self] in
            await self?.run()
        }
    }

    /// Stops for good: the request on its way is cancelled and nothing more is sent. The
    /// operations stay in the store. Sign-out calls this (`SyncHost`).
    func stop() {
        isStopped = true
        loop?.cancel()
        loop = nil
        nap?.cancel()
        nap = nil
    }

    /// Asks the run loop to look at the outbox now, for example after a local write.
    func kick() {
        kicked = true
        nap?.cancel()
    }

    private func run() async {
        while !Task.isCancelled, !isStopped {
            switch await drain() {
            case .idle:
                guard await runIdleWork() else {
                    return
                }
                await rest(for: restAfterIdle())
            case .waiting(let until):
                await rest(for: max(0, until.timeIntervalSince(now())))
            case .busy:
                await rest(for: 1)
            case .signInRequired, .stopped:
                return
            }
        }
    }

    /// Runs `onIdle` in the drain's slot. False when the engine must stop: sign-in required.
    private func runIdleWork() async -> Bool {
        guard let onIdle, !isStopped, !Task.isCancelled, !isDraining else {
            return true
        }
        isDraining = true
        let outcome = await onIdle()
        isDraining = false
        if outcome == .signInRequired, !isStopped {
            needsSignIn = true
            onSignInRequired?()
            return false
        }
        return true
    }

    /// `idleWait`, or less when a bean look-up or the idle work wants to run again sooner.
    private func restAfterIdle() -> TimeInterval {
        let current = now()
        var wakes: [Date] = []
        if let lookUp = try? store.nextLookUpAttempt(after: current) {
            wakes.append(lookUp)
        }
        if let idle = nextIdleWake?() {
            wakes.append(idle)
        }
        guard let first = wakes.min() else {
            return idleWait
        }
        return min(idleWait, max(0, first.timeIntervalSince(current)))
    }

    private func rest(for seconds: TimeInterval) async {
        if kicked {
            kicked = false
            return
        }
        let sleep = self.sleep
        let nap = Task<Void, Never> {
            _ = try? await sleep(seconds)
        }
        self.nap = nap
        await nap.value
        self.nap = nil
        kicked = false
    }

    /// Sends operations in order until the outbox is empty, an operation backs off, the
    /// user must sign in, or the engine is stopped.
    func drain() async -> DrainResult {
        if isStopped {
            return .stopped
        }
        if needsSignIn {
            return .signInRequired
        }
        if isDraining {
            return .busy
        }
        isDraining = true
        defer { isDraining = false }
        // The operations deferred in this drain (a bean look-up that waits). They are not picked
        // again before the next drain, so the loop cannot spin on one that keeps deferring.
        var deferred = Set<Int>()

        while true {
            if isStopped || Task.isCancelled {
                return .stopped
            }
            let next: OutboxOperation?
            do {
                next = try store.nextOutboxOperation(at: now(), skipping: deferred)
            } catch {
                return .waiting(until: now().addingTimeInterval(backoff.maximum))
            }
            guard let operation = next else {
                return .idle
            }
            if operation.nextAttemptAt > now() {
                return .waiting(until: operation.nextAttemptAt)
            }
            let sequence = operation.sequence
            guard await isCurrentAccount(), !isStopped else {
                stop()
                return .stopped
            }
            // Fetched again: the user may have changed the outbox during the check.
            guard let current = try? store.outboxOperation(sequence: sequence), !current.parked else {
                continue
            }
            let outcome: Outcome
            do {
                outcome = try await process(current)
            } catch {
                // The store failed (fetch or save): try again later. What the operation changed
                // and did not save is undone first, saved models included
                // (`AccountStore.discardUnsavedChanges()`), so the retry's save below stores none
                // of it.
                store.discardUnsavedChanges()
                outcome = .retry
            }
            switch outcome {
            case .next:
                finishedOperations += 1
                continue
            case .deferred:
                // A bean look-up waits (for its next attempt or for the user); the rest goes on.
                deferred.insert(sequence)
                continue
            case .retry:
                guard let retried = try? store.outboxOperation(sequence: sequence) else {
                    continue
                }
                let wait = backoff.delay(afterAttempt: max(1, retried.attemptCount), jitter: jitter())
                let until = now().addingTimeInterval(wait)
                retried.nextAttemptAt = until
                try? store.save()
                return .waiting(until: until)
            case .signInRequired:
                needsSignIn = true
                onSignInRequired?()
                return .signInRequired
            case .cancelled:
                return .stopped
            }
        }
    }

    // MARK: - Operations

    private enum Outcome {
        /// Finished (done, parked or dropped): go on with the next operation.
        case next
        /// Back off, then send this one again.
        case retry
        /// The operation waits without holding the queue (a bean look-up, M2-T25): go on with
        /// the next one that does not depend on it.
        case deferred
        case signInRequired
        case cancelled
    }

    private enum Answer<Value> {
        case value(Value)
        case failed(APIError)
        case cancelled
    }

    private func process(_ operation: OutboxOperation) async throws -> Outcome {
        let sequence = operation.sequence
        let localID = operation.localID
        guard let resource = operation.resource, let action = operation.action else {
            return try park(sequence, .unknownOperation, resource: nil, localID: localID)
        }
        switch (resource, action) {
        case (.bean, .create):
            return try await createBean(sequence, localID)
        case (.bean, .lookUp):
            return try await lookUpBean(sequence, localID)
        case (.bean, .awaitConfirmation), (.bean, .awaitDescription):
            // Never picked (it waits for the user); if it were, it would go on waiting.
            return .deferred
        case (.shelfEntry, .create):
            return try await create(
                sequence, localID, resource: .shelfEntry,
                find: store.shelfEntry(localID:),
                findServer: store.shelfEntry(serverID:),
                body: { (entry: StoredShelfEntry) in try entry.apiInput() },
                list: { try await self.client.allShelfEntries().items },
                serverID: { (entry: API.ShelfEntry) in entry.shelfEntryId },
                // A shelf entry: the same bean and the same values.
                matches: { (candidate: API.ShelfEntry, body: API.ShelfEntryInput) in candidate.values == body },
                post: { body in try await self.client.createShelfEntry(body) },
                accept: { (entry: StoredShelfEntry, server: API.ShelfEntry) in entry.apply(server.values) }
            )
        case (.shelfEntry, .update):
            return try await replace(
                sequence, localID, resource: .shelfEntry,
                find: store.shelfEntry(localID:),
                body: { (entry: StoredShelfEntry) in try entry.apiInput() },
                put: { id, body in try await self.client.replaceShelfEntry(id, with: body) },
                get: { id in _ = try await self.client.getShelfEntry(id) },
                accept: { (entry: StoredShelfEntry, server: API.ShelfEntry) in entry.apply(server.values) }
            )
        case (.shelfEntry, .delete):
            return try await delete(sequence, localID, resource: .shelfEntry, find: store.shelfEntry(localID:)) { id in
                try await self.client.deleteShelfEntry(id)
            }
        case (.brew, .create):
            return try await create(
                sequence, localID, resource: .brew,
                find: store.brew(localID:),
                findServer: store.brew(serverID:),
                body: { (brew: StoredBrew) in try brew.apiInput() },
                list: { try await self.client.allBrews().items },
                serverID: { (brew: API.Brew) in brew.brewId },
                // A brew: the same shelf entry and the same `brewed_at`.
                matches: { (candidate: API.Brew, body: API.BrewInput) in
                    candidate.values.shelfEntryId == body.shelfEntryId && candidate.values.brewedAt == body.brewedAt
                },
                post: { body in try await self.client.createBrew(body) },
                accept: { (brew: StoredBrew, server: API.Brew) in _ = try? brew.apply(server.values) }
            )
        case (.brew, .update):
            return try await replace(
                sequence, localID, resource: .brew,
                find: store.brew(localID:),
                body: { (brew: StoredBrew) in try brew.apiInput() },
                put: { id, body in try await self.client.replaceBrew(id, with: body) },
                get: { id in _ = try await self.client.getBrew(id) },
                accept: { (brew: StoredBrew, server: API.Brew) in _ = try? brew.apply(server.values) }
            )
        case (.brew, .delete):
            return try await delete(sequence, localID, resource: .brew, find: store.brew(localID:)) { id in
                try await self.client.deleteBrew(id)
            }
        case (.recipe, .create):
            return try await create(
                sequence, localID, resource: .recipe,
                find: store.recipe(localID:),
                findServer: store.recipe(serverID:),
                body: { (recipe: StoredRecipe) in try recipe.apiInput() },
                list: { try await self.client.allRecipes().items },
                serverID: { (recipe: API.Recipe) in recipe.recipeId },
                // A recipe: the same parameters.
                matches: { (candidate: API.Recipe, body: API.RecipeInput) in candidate.values.parameters == body.parameters },
                post: { body in try await self.client.createRecipe(body) },
                accept: { (recipe: StoredRecipe, server: API.Recipe) in recipe.apply(server.values) }
            )
        case (.recipe, .update):
            return try await replace(
                sequence, localID, resource: .recipe,
                find: store.recipe(localID:),
                body: { (recipe: StoredRecipe) in try recipe.apiInput() },
                put: { id, body in try await self.client.replaceRecipe(id, with: body) },
                get: { id in _ = try await self.client.getRecipe(id) },
                accept: { (recipe: StoredRecipe, server: API.Recipe) in recipe.apply(server.values) }
            )
        case (.recipe, .delete):
            return try await delete(sequence, localID, resource: .recipe, find: store.recipe(localID:)) { id in
                try await self.client.deleteRecipe(id)
            }
        case (.profile, .update):
            return try await putProfile(sequence, localID)
        default:
            return try park(sequence, .unknownOperation, resource: resource, localID: localID)
        }
    }

    // MARK: - Create

    /// `POST` of a shelf entry, brew or recipe, with the check for an ambiguous earlier send.
    private func create<Model: PersistentModel & ServerIdentified, Body: Sendable & Codable, Response: Sendable>(
        _ sequence: Int,
        _ localID: UUID,
        resource: OutboxResource,
        find: (UUID) throws -> Model?,
        findServer: (String) throws -> Model?,
        body makeBody: (Model) throws -> Body,
        list: () async throws -> [Response],
        serverID: (Response) -> String,
        matches: (Response, Body) -> Bool,
        post: (Body) async throws -> Response,
        accept: (Model, Response) -> Void
    ) async throws -> Outcome {
        guard let item = try find(localID) else {
            return try drop(sequence)
        }
        if item.serverID != nil {
            // Adopted or created meanwhile.
            let isLast = try complete(sequence, localID: localID)
            settle(item, isLast: isLast)
            try store.save()
            return .next
        }
        let body: Body
        do {
            body = try makeBody(item)
        } catch LocalStoreError.missingServerID {
            return try park(sequence, .missingReference, resource: resource, localID: localID)
        } catch {
            return try park(sequence, .notSendable, resource: resource, localID: localID)
        }

        var checked = false
        if let operation = try store.outboxOperation(sequence: sequence), operation.sentWithoutAnswer {
            // The check counts as an attempt, so a failing list backs off like a send.
            operation.attemptCount += 1
            try store.save()
            checked = true
            // Matched against what was sent, not against the item as it is now: the user may
            // have edited it since (that edit is queued as an update behind this create).
            let sent = operation.sentBody.flatMap { data in try? JSONDecoder().decode(Body.self, from: data) } ?? body
            switch await call({ try await list() }) {
            case .value(let items):
                for candidate in items where matches(candidate, sent) {
                    // Only a server item no local item stands for yet.
                    if try findServer(serverID(candidate)) == nil {
                        return try created(sequence, localID, serverID: serverID(candidate), response: candidate, find: find, accept: accept)
                    }
                }
                // The earlier send created nothing.
                if let operation = try store.outboxOperation(sequence: sequence) {
                    operation.sentWithoutAnswer = false
                    try store.save()
                }
            case .cancelled:
                return .cancelled
            case .failed(let error):
                // An answer to the list says nothing about the earlier create: the check stays.
                return try failure(error, sequence, resource: resource, localID: localID, answersTheWrite: false)
            }
        }

        try markSending(sequence, sentBody: try? JSONEncoder().encode(body), countsAttempt: !checked)
        switch await call({ try await post(body) }) {
        case .value(let server):
            return try created(sequence, localID, serverID: serverID(server), response: server, find: find, accept: accept)
        case .cancelled:
            return .cancelled
        case .failed(.notFound):
            // `POST /shelf`: the bean does not exist or was rejected; `POST /brews`: the
            // shelf entry does not exist. Sending it again cannot help.
            return try park(sequence, .rejected, resource: resource, localID: localID)
        case .failed(let error):
            return try failure(error, sequence, resource: resource, localID: localID)
        }
    }

    /// Stores the server id and, when no later operation changes the item, the server values.
    private func created<Model: PersistentModel & ServerIdentified, Response>(
        _ sequence: Int,
        _ localID: UUID,
        serverID: String,
        response: Response,
        find: (UUID) throws -> Model?,
        accept: (Model, Response) -> Void
    ) throws -> Outcome {
        guard let item = try find(localID) else {
            return try drop(sequence)
        }
        let isLast = try complete(sequence, localID: localID)
        item.serverID = serverID
        if isLast, item.syncState != .pendingDelete {
            accept(item, response)
        }
        settle(item, isLast: isLast)
        try store.save()
        return .next
    }

    /// `POST /beans`. A 409 for a barcode the catalogue already has adopts that bean: the
    /// usual answer to a retried create whose first answer was lost.
    private func createBean(_ sequence: Int, _ localID: UUID) async throws -> Outcome {
        guard let bean = try store.bean(localID: localID) else {
            return try drop(sequence)
        }
        if bean.serverID != nil {
            let isLast = try complete(sequence, localID: localID)
            settle(bean, isLast: isLast)
            try store.save()
            return .next
        }
        let body: API.BeanCreate
        do {
            body = try bean.apiCreate()
        } catch {
            return try park(sequence, .notSendable, resource: .bean, localID: localID)
        }
        let barcode = bean.barcode.flatMap { code in LookupBarcode(code) }

        try markSending(sequence)
        switch await call({ try await self.client.createBean(body) }) {
        case .value(let server):
            return try adoptBean(server, sequence, localID)
        case .cancelled:
            return .cancelled
        case .failed(.conflict):
            guard let barcode else {
                return try park(sequence, .rejected, resource: .bean, localID: localID)
            }
            switch await call({ try await self.client.lookupBarcode(barcode) }) {
            case .value(let server):
                return try adoptBean(server, sequence, localID)
            case .cancelled:
                return .cancelled
            case .failed(.notFound):
                return try park(sequence, .rejected, resource: .bean, localID: localID)
            case .failed(let error):
                return try failure(error, sequence, resource: .bean, localID: localID)
            }
        case .failed(let error):
            return try failure(error, sequence, resource: .bean, localID: localID)
        }
    }

    /// Takes the server's bean. If another local bean already stands for it, the shelf
    /// entries move to that one and this copy goes, so one server bean has one local bean.
    private func adoptBean(_ server: API.Bean, _ sequence: Int, _ localID: UUID) throws -> Outcome {
        guard let bean = try store.bean(localID: localID) else {
            return try drop(sequence)
        }
        let isLast = try complete(sequence, localID: localID)
        if let existing = try store.bean(serverID: server.beanId), existing.localID != localID {
            let entries = bean.shelfEntries
            for entry in entries {
                entry.bean = existing
            }
            existing.apply(server)
            try store.moveQueuedLabelPhotos(from: localID, to: existing.localID)
            try store.removeOutboxOperations(for: localID)
            store.context.delete(bean)
        } else {
            bean.apply(server)
            settle(bean, isLast: isLast)
        }
        try store.save()
        return .next
    }

    // MARK: - Pending bean look-up (M2-T25)

    /// A bean scanned while the lookup could not answer: `GET /barcodes/{barcode}`, then
    /// `GET /barcodes/{barcode}/open_food_facts`.
    /// - 200 from the catalogue: that bean is used (`adoptBean`), without asking.
    /// - An Open Food Facts hit: kept on the bean, and the operation waits for the user's
    ///   confirmation (`awaitConfirmation`); what depends on the bean waits with it.
    /// - An Open Food Facts miss (404): the operation waits for the user to describe the bean or
    ///   skip that (`awaitDescription`, docs/04 F1 step 4); what depends on it waits with it.
    /// - A bean with no live shelf entry (its form was never saved, or its entries are gone) is
    ///   dropped without a request.
    /// - 409 from Open Food Facts: the barcode got a bean meanwhile; the next attempt finds it.
    /// - No network, 5xx, 429 (throttling, or the daily lookup cap of the Open Food Facts route):
    ///   the look-up waits for its next attempt (backoff, or `lookUpLimitWait` for the cap)
    ///   without holding the queue.
    private func lookUpBean(_ sequence: Int, _ localID: UUID) async throws -> Outcome {
        guard let bean = try store.bean(localID: localID) else {
            return try drop(sequence)
        }
        if bean.serverID != nil {
            let isLast = try complete(sequence, localID: localID)
            settle(bean, isLast: isLast)
            try store.save()
            return .next
        }
        if !bean.hasLiveShelfEntries {
            // Nothing on the device needs it: no catalogue bean is made for it.
            try store.dropPendingBean(bean)
            try store.save()
            return .next
        }
        guard let barcode = bean.barcode.flatMap({ code in LookupBarcode(code) }) else {
            // Nothing to look up: created from what it has.
            return try await createAfterLookUp(sequence, localID)
        }
        // A look-up counts as an attempt, so a failing one backs off.
        if let operation = try store.outboxOperation(sequence: sequence) {
            operation.attemptCount += 1
            try store.save()
        }

        switch await call({ try await self.client.lookupBarcode(barcode) }) {
        case .value(let server):
            return try adoptBean(server, sequence, localID)
        case .cancelled:
            return .cancelled
        case .failed(.notFound):
            break
        case .failed(let error):
            return try lookUpFailed(error, sequence, localID, openFoodFactsRoute: false)
        }

        switch await call({ try await self.client.lookupOpenFoodFacts(barcode) }) {
        case .value(let product):
            guard let current = try store.bean(localID: localID),
                  let operation = try store.outboxOperation(sequence: sequence) else {
                return try drop(sequence)
            }
            try store.write {
                current.holdOpenFoodFactsProduct(product)
                operation.actionRaw = OutboxAction.awaitConfirmation.rawValue
                operation.attemptCount = 0
                operation.nextAttemptAt = Date.distantPast
                try store.save()
            }
            return .deferred
        case .cancelled:
            return .cancelled
        case .failed(.notFound):
            // No product: the user describes the bean, or skips that, next time (F1 step 4).
            return try askForDescription(sequence)
        case .failed(.conflict):
            // The barcode points to a bean now: the next attempt's catalogue lookup finds it.
            return try deferLookUp(sequence, by: backoffDelay(sequence))
        case .failed(let error):
            return try lookUpFailed(error, sequence, localID, openFoodFactsRoute: true)
        }
    }

    /// The look-up found no bean and no product (or had no barcode): the operation becomes the
    /// bean's create and is sent at once.
    private func createAfterLookUp(_ sequence: Int, _ localID: UUID) async throws -> Outcome {
        guard let operation = try store.outboxOperation(sequence: sequence) else {
            return .next
        }
        try store.write {
            operation.actionRaw = OutboxAction.create.rawValue
            operation.attemptCount = 0
            operation.nextAttemptAt = Date.distantPast
            try store.save()
        }
        return try await createBean(sequence, localID)
    }

    /// The operation waits for the user's description (`awaitDescription`). When the save
    /// fails the operation stays the look-up it was (`AccountStore.write`), so no question is
    /// shown that the store does not hold, and the look-up is tried again.
    private func askForDescription(_ sequence: Int) throws -> Outcome {
        try store.write { () throws -> Outcome in
            guard let operation = try store.outboxOperation(sequence: sequence) else {
                return .next
            }
            operation.actionRaw = OutboxAction.awaitDescription.rawValue
            operation.attemptCount = 0
            operation.nextAttemptAt = Date.distantPast
            try store.save()
            return .deferred
        }
    }

    /// A failed catalogue or Open Food Facts lookup. Nothing was written on the server, so
    /// there is nothing to check before the next attempt.
    private func lookUpFailed(_ error: APIError, _ sequence: Int, _ localID: UUID, openFoodFactsRoute: Bool) throws -> Outcome {
        if openFoodFactsRoute, case .tooManyRequests = error {
            // The daily lookup cap: try again later, and let everything else go meanwhile.
            return try deferLookUp(sequence, by: SyncEngine.lookUpLimitWait)
        }
        if error.isRetryable {
            return try deferLookUp(sequence, by: backoffDelay(sequence))
        }
        switch error {
        case .unauthorized:
            return .signInRequired
        case .badRequest:
            return try park(sequence, .rejected, resource: .bean, localID: localID)
        default:
            return try park(sequence, .unexpectedResponse, resource: .bean, localID: localID)
        }
    }

    /// The backoff after the operation's attempts so far.
    private func backoffDelay(_ sequence: Int) throws -> TimeInterval {
        let attempts = try store.outboxOperation(sequence: sequence)?.attemptCount ?? 1
        return backoff.delay(afterAttempt: max(1, attempts), jitter: jitter())
    }

    /// The look-up waits `seconds` without holding the queue.
    private func deferLookUp(_ sequence: Int, by seconds: TimeInterval) throws -> Outcome {
        if let operation = try store.outboxOperation(sequence: sequence) {
            operation.nextAttemptAt = now().addingTimeInterval(seconds)
            try store.save()
        }
        return .deferred
    }

    // MARK: - Replace

    /// `PUT` of a shelf entry, brew or recipe.
    private func replace<Model: PersistentModel & ServerIdentified, Body: Sendable, Response: Sendable>(
        _ sequence: Int,
        _ localID: UUID,
        resource: OutboxResource,
        find: (UUID) throws -> Model?,
        body makeBody: (Model) throws -> Body,
        put: (ResourceID, Body) async throws -> Response,
        get: (ResourceID) async throws -> Void,
        accept: (Model, Response) -> Void
    ) async throws -> Outcome {
        guard let item = try find(localID) else {
            return try drop(sequence)
        }
        if item.syncState == .pendingDelete {
            // The delete behind it says the rest.
            return try drop(sequence)
        }
        guard let serverID = item.serverID else {
            return try park(sequence, .notOnServer, resource: resource, localID: localID)
        }
        guard let id = ResourceID(serverID) else {
            return try park(sequence, .unexpectedResponse, resource: resource, localID: localID)
        }
        let body: Body
        do {
            body = try makeBody(item)
        } catch LocalStoreError.missingServerID {
            return try park(sequence, .missingReference, resource: resource, localID: localID)
        } catch {
            return try park(sequence, .notSendable, resource: resource, localID: localID)
        }

        try markSending(sequence)
        switch await call({ try await put(id, body) }) {
        case .value(let server):
            guard let current = try find(localID) else {
                return try drop(sequence)
            }
            let isLast = try complete(sequence, localID: localID)
            if isLast, current.syncState != .pendingDelete {
                accept(current, server)
            }
            settle(current, isLast: isLast)
            try store.save()
            return .next
        case .cancelled:
            return .cancelled
        case .failed(.notFound):
            // The item may be gone, or a reference in the body may be (an unknown or
            // rejected bean, a deleted shelf entry): only a read of the item tells.
            switch await call({ try await get(id) }) {
            case .value:
                return try park(sequence, .rejected, resource: resource, localID: localID)
            case .failed(.notFound):
                // Gone on the server (deleted on another device): gone here too.
                return try removeLocally(sequence, localID, find: find)
            case .cancelled:
                return .cancelled
            case .failed(let error):
                return try failure(error, sequence, resource: resource, localID: localID, answersTheWrite: false)
            }
        case .failed(.conflict) where resource == .shelfEntry:
            return try await revertBean(sequence, localID, id: id)
        case .failed(let error):
            return try failure(error, sequence, resource: resource, localID: localID)
        }
    }

    /// 409 on `PUT /shelf/{id}` (D14): the bean may not change while brews reference the
    /// entry. The entry gets the server's bean back, is flagged `beanChangeReverted`, and the
    /// same operation goes again at once with the other values.
    private func revertBean(_ sequence: Int, _ localID: UUID, id: ResourceID) async throws -> Outcome {
        let server: API.ShelfEntry
        switch await call({ try await self.client.getShelfEntry(id) }) {
        case .value(let value):
            server = value
        case .cancelled:
            return .cancelled
        case .failed(.notFound):
            return try removeLocally(sequence, localID, find: store.shelfEntry(localID:))
        case .failed(let error):
            return try failure(error, sequence, resource: .shelfEntry, localID: localID)
        }

        var bean = try store.bean(serverID: server.values.beanId)
        if bean == nil {
            guard let beanID = ResourceID(server.values.beanId) else {
                return try park(sequence, .unexpectedResponse, resource: .shelfEntry, localID: localID)
            }
            switch await call({ try await self.client.getBean(beanID) }) {
            case .value(let fetched):
                if let cached = try store.bean(serverID: fetched.beanId) {
                    bean = cached
                } else {
                    let copy = StoredBean(fetched)
                    copy.syncState = .synced
                    store.context.insert(copy)
                    bean = copy
                }
            case .cancelled:
                return .cancelled
            case .failed(let error):
                return try failure(error, sequence, resource: .shelfEntry, localID: localID)
            }
        }
        guard let entry = try store.shelfEntry(localID: localID) else {
            return try drop(sequence)
        }
        entry.bean = bean
        entry.syncIssue = .beanChangeReverted
        if let operation = try store.outboxOperation(sequence: sequence) {
            operation.nextAttemptAt = Date.distantPast
        }
        try store.save()
        return .next
    }

    // MARK: - Delete

    /// `DELETE` of a shelf entry, brew or recipe. 2xx and 404 both mean the server has no
    /// such item any more; 409 (shelf entries only) brings the entry back.
    private func delete<Model: PersistentModel & ServerIdentified>(
        _ sequence: Int,
        _ localID: UUID,
        resource: OutboxResource,
        find: (UUID) throws -> Model?,
        send: (ResourceID) async throws -> Void
    ) async throws -> Outcome {
        guard let item = try find(localID) else {
            return try drop(sequence)
        }
        guard let serverID = item.serverID else {
            // Its create never reached the server.
            return try removeLocally(sequence, localID, find: find)
        }
        guard let id = ResourceID(serverID) else {
            return try park(sequence, .unexpectedResponse, resource: resource, localID: localID)
        }

        try markSending(sequence)
        switch await call({ try await send(id) }) {
        case .value, .failed(.notFound):
            return try removeLocally(sequence, localID, find: find)
        case .cancelled:
            return .cancelled
        case .failed(.conflict) where resource == .shelfEntry:
            // Brews the device does not have yet still reference the entry: it stays.
            guard let current = try find(localID) else {
                return try drop(sequence)
            }
            let isLast = try complete(sequence, localID: localID)
            current.syncState = isLast ? .synced : .pendingUpdate
            current.syncIssue = .deleteRestored
            try store.save()
            return .next
        case .failed(let error):
            return try failure(error, sequence, resource: resource, localID: localID)
        }
    }

    // MARK: - Profile

    /// `PUT /profile`. The profile has no server id; the token says whose it is.
    private func putProfile(_ sequence: Int, _ localID: UUID) async throws -> Outcome {
        guard let profile = try store.profile(), profile.localID == localID else {
            return try drop(sequence)
        }
        let body: API.Profile
        do {
            body = try profile.apiProfile()
        } catch {
            return try park(sequence, .notSendable, resource: .profile, localID: localID)
        }

        try markSending(sequence)
        switch await call({ try await self.client.putProfile(body) }) {
        case .value(let server):
            guard let current = try store.profile(), current.localID == localID else {
                return try drop(sequence)
            }
            let isLast = try complete(sequence, localID: localID)
            if isLast {
                current.apply(server)
            }
            settle(current, isLast: isLast)
            try store.save()
            return .next
        case .cancelled:
            return .cancelled
        case .failed(let error):
            return try failure(error, sequence, resource: .profile, localID: localID)
        }
    }

    // MARK: - Helpers

    /// Runs one request, after checking that the engine's account is still signed in (if
    /// not, the engine stops and nothing is sent). `APIClient` throws only `APIError` and
    /// `CancellationError`.
    private func call<Value>(_ request: () async throws -> Value) async -> Answer<Value> {
        guard !isStopped, await isCurrentAccount(), !isStopped else {
            stop()
            return .cancelled
        }
        do {
            return .value(try await request())
        } catch let error as APIError {
            return .failed(error)
        } catch {
            if error is CancellationError || Task.isCancelled {
                return .cancelled
            }
            return .failed(.invalidResponse)
        }
    }

    /// Counts the attempt and marks the operation as possibly on the server, on disk, before
    /// the request leaves. If the app is ended before the answer, the next launch knows.
    /// `sentBody`, when given, is saved on the operation: the encoded body of a create, the
    /// key of the check before it is sent again. `countsAttempt` is false right after a
    /// check, which was counted already.
    private func markSending(_ sequence: Int, sentBody: Data? = nil, countsAttempt: Bool = true) throws {
        guard let operation = try store.outboxOperation(sequence: sequence) else {
            return
        }
        if countsAttempt {
            operation.attemptCount += 1
        }
        if let sentBody {
            operation.sentBody = sentBody
        }
        operation.sentWithoutAnswer = true
        try store.save()
    }

    /// What an answer without a rule of its own means.
    /// `answersTheWrite` is false for the answer to a read made on the way (the list of the
    /// check): it then leaves `sentWithoutAnswer` as it is.
    private func failure(
        _ error: APIError,
        _ sequence: Int,
        resource: OutboxResource,
        localID: UUID,
        answersTheWrite: Bool = true
    ) throws -> Outcome {
        if answersTheWrite, !SyncEngine.mayHaveActed(error), let operation = try store.outboxOperation(sequence: sequence) {
            // The server said it did nothing, so no check is needed before the next send.
            operation.sentWithoutAnswer = false
            try store.save()
        }
        if error.isRetryable {
            return .retry
        }
        switch error {
        case .unauthorized:
            // After the client's refresh and retry: sign in again. Also the answer to a
            // write with a token of a deleted account (ADR 0017, Addendum).
            return .signInRequired
        case .badRequest:
            return try park(sequence, .rejected, resource: resource, localID: localID)
        default:
            return try park(sequence, .unexpectedResponse, resource: resource, localID: localID)
        }
    }

    /// Whether the server may have done the write although this error came back: the
    /// request was lost on the way back (transport), or the server failed while working
    /// (5xx), or the answer could not be read. 400, 401, 404, 409 and 429 say it did nothing,
    /// and so do the transport failures in `neverSentCodes` (no connection was made).
    nonisolated static let neverSentCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
    ]

    nonisolated static func mayHaveActed(_ error: APIError) -> Bool {
        switch error {
        case .transport(let code):
            // These fail before a byte reaches the server.
            return !SyncEngine.neverSentCodes.contains(code)
        case .server, .serviceUnavailable, .undecodable, .invalidResponse, .unexpectedStatus:
            return true
        case .badRequest, .unauthorized, .notFound, .conflict, .tooManyRequests, .invalidRequest:
            return false
        }
    }

    /// Parks the operation for good and flags its item.
    private func park(_ sequence: Int, _ reason: OutboxParkReason, resource: OutboxResource?, localID: UUID) throws -> Outcome {
        if let operation = try store.outboxOperation(sequence: sequence) {
            operation.parked = true
            operation.parkReason = reason
        }
        if let resource, let item = try trackedItem(resource, localID) {
            item.syncIssue = .rejected
        }
        try store.save()
        return .next
    }

    /// Removes an operation whose item is gone.
    private func drop(_ sequence: Int) throws -> Outcome {
        if let operation = try store.outboxOperation(sequence: sequence) {
            store.context.delete(operation)
        }
        try store.save()
        return .next
    }

    /// Removes the item and every operation of it.
    private func removeLocally<Model: PersistentModel>(_ sequence: Int, _ localID: UUID, find: (UUID) throws -> Model?) throws -> Outcome {
        try store.removeOutboxOperations(for: localID)
        if let item = try find(localID) {
            store.context.delete(item)
        }
        try store.save()
        return .next
    }

    /// Removes the finished operation. True when the item has no other operation waiting.
    private func complete(_ sequence: Int, localID: UUID) throws -> Bool {
        if let operation = try store.outboxOperation(sequence: sequence) {
            store.context.delete(operation)
        }
        let others = try store.outboxOperations(for: localID).filter { operation in
            operation.sequence != sequence && !operation.parked
        }
        return others.isEmpty
    }

    /// The sync state after a success: synced, unless more is queued or it is being deleted.
    private func settle(_ item: some SyncTracked, isLast: Bool) {
        if item.syncState != .pendingDelete {
            item.syncState = isLast ? .synced : .pendingUpdate
        }
    }

    private func trackedItem(_ resource: OutboxResource, _ localID: UUID) throws -> (any SyncTracked)? {
        switch resource {
        case .bean: return try store.bean(localID: localID)
        case .shelfEntry: return try store.shelfEntry(localID: localID)
        case .brew: return try store.brew(localID: localID)
        case .recipe: return try store.recipe(localID: localID)
        case .profile:
            let profile = try store.profile()
            return profile?.localID == localID ? profile : nil
        }
    }
}
