import Foundation
import SwiftData

// The outbox (M2-T16, ADR 0025): the local writes that still have to reach the server, in
// the order they were made. `AccountStore` adds an operation in the same save as the item
// change; `SyncEngine` (Sync/) sends them one at a time.

/// The API resource an outbox operation writes.
enum OutboxResource: String, CaseIterable, Sendable {
    /// `POST /beans`. A bean has no update and no delete route.
    case bean = "bean"
    /// `POST /shelf`, `PUT` and `DELETE /shelf/{shelf_entry_id}`.
    case shelfEntry = "shelf_entry"
    /// `POST /brews`, `PUT` and `DELETE /brews/{brew_id}`.
    case brew = "brew"
    /// `POST /recipes`, `PUT` and `DELETE /recipes/{recipe_id}`.
    case recipe = "recipe"
    /// `PUT /profile`, always an update: the API addresses the profile through the token.
    case profile = "profile"

    /// Whether a local edit of an item of this resource is sent. Beans are created and then
    /// only read; the profile is always sent as a whole `PUT`.
    var sendsUpdates: Bool {
        self != .bean
    }

    /// Whether a local delete is sent. Only shelf entries, brews and recipes have a delete route.
    var sendsDeletes: Bool {
        switch self {
        case .shelfEntry, .brew, .recipe: return true
        case .bean, .profile: return false
        }
    }
}

/// What an outbox operation does with its item.
enum OutboxAction: String, CaseIterable, Sendable {
    case create = "create"
    case update = "update"
    case delete = "delete"
    /// A bean scanned while the lookup could not answer (M2-T25): `GET /barcodes/{barcode}`,
    /// then Open Food Facts through the backend. A known bean is used; an Open Food Facts hit
    /// becomes `awaitConfirmation`, a miss `awaitDescription`. While it waits for its next
    /// attempt it does not hold the queue: only the operations that depend on its bean wait.
    case lookUp = "look_up"
    /// A bean with an Open Food Facts hit, waiting for the user's confirmation (M2-T25). Never
    /// sent: Confirm turns it into a `create`, "Not my coffee" into `awaitDescription`. The
    /// operations that depend on the bean wait; every other one goes out.
    case awaitConfirmation = "await_confirmation"
    /// A bean without a catalogue entry or an accepted Open Food Facts hit, waiting for the user
    /// to describe it with pick lists and a label photo, or to skip that (docs/04 F1 step 4,
    /// M2-T25). Never sent: either answer turns it into a `create`. Its dependants wait.
    case awaitDescription = "await_description"

    /// Whether the operation brings its item to the server for the first time: a create, or
    /// the look-up of a pending bean that ends in one.
    var createsItem: Bool {
        switch self {
        case .create, .lookUp, .awaitConfirmation, .awaitDescription: return true
        case .update, .delete: return false
        }
    }

    /// Whether this is the operation of a scanned bean that is not settled yet: a look-up or a
    /// question to the user (M2-T25).
    var isPendingScan: Bool {
        switch self {
        case .lookUp, .awaitConfirmation, .awaitDescription: return true
        case .create, .update, .delete: return false
        }
    }
}

/// Why an operation was parked. A parked operation is never sent again.
enum OutboxParkReason: String, CaseIterable, Sendable {
    /// The server answered 400 (or 404 on a create: the referenced item does not exist).
    case rejected = "rejected"
    /// The item cannot be turned into a request: a vocabulary id this build does not know, a
    /// date that cannot be sent, an incomplete rating.
    case notSendable = "not_sendable"
    /// An item it references never got a server id (its own create was parked).
    case missingReference = "missing_reference"
    /// The item itself never reached the server, so it cannot be updated there.
    case notOnServer = "not_on_server"
    /// The answer breaks the contract (an undocumented status, a body that does not decode).
    case unexpectedResponse = "unexpected_response"
    /// The stored operation names an unknown resource or action.
    case unknownOperation = "unknown_operation"
}

/// What the user is told about an item after a sync. Stored on the item as `syncIssueRaw`.
enum SyncIssue: String, CaseIterable, Sendable {
    /// The item could not be sent and stays on this device only (a parked operation).
    case rejected = "rejected"
    /// A bean change of a shelf entry with brews was refused (409, D14) and undone.
    case beanChangeReverted = "bean_change_reverted"
    /// A shelf entry delete was refused because brews still reference it (409), so the entry
    /// is back.
    case deleteRestored = "delete_restored"
}

extension StoredBean { static var outboxResource: OutboxResource { .bean } }
extension StoredShelfEntry { static var outboxResource: OutboxResource { .shelfEntry } }
extension StoredBrew { static var outboxResource: OutboxResource { .brew } }
extension StoredRecipe { static var outboxResource: OutboxResource { .recipe } }
extension StoredProfile { static var outboxResource: OutboxResource { .profile } }

extension OutboxOperation {
    /// Nil for a stored value this build does not know; such an operation is parked.
    var resource: OutboxResource? { OutboxResource(rawValue: resourceRaw) }

    var action: OutboxAction? { OutboxAction(rawValue: actionRaw) }

    var parkReason: OutboxParkReason? {
        get { parkReasonRaw.flatMap { raw in OutboxParkReason(rawValue: raw) } }
        set { parkReasonRaw = newValue?.rawValue }
    }
}

// MARK: - Queue

extension AccountStore {
    /// Every operation, parked ones included, in the order they go out.
    func outboxOperations() throws -> [OutboxOperation] {
        try context.fetch(FetchDescriptor<OutboxOperation>(sortBy: [SortDescriptor(\OutboxOperation.sequence)]))
    }

    /// The operation to send next (M2-T25 on top of ADR 0025): in sequence order, the first
    /// operation that can go now, or the create its item needs first.
    /// - An operation whose item names a bean or shelf entry that has no server id and still
    ///   has its own create (or look-up) queued needs that operation first, whatever the two
    ///   sequences are: a shelf entry made earlier and later moved to a bean scanned offline must
    ///   not go before that bean. That operation is returned instead.
    /// - A bean whose look-up waits (for its next attempt, or for the user's answer) is skipped
    ///   with everything that needs it; everything else keeps its order.
    /// - A delete never waits: an item the server never had is removed locally by the engine.
    /// - `skipping` lists sequences the caller already deferred in this pass (the engine's
    ///   drain), treated as waiting, so a deferred operation is never picked twice in a row.
    func nextOutboxOperation(at now: Date = Date(), skipping: Set<Int> = []) throws -> OutboxOperation? {
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.parked == false },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        let candidates = try context.fetch(descriptor)
        let queue = OutboxDependencies(operations: candidates, now: now)
        for operation in candidates {
            if let next = try resolve(operation, in: queue, depth: 0), !skipping.contains(next.sequence) {
                return next
            }
        }
        return nil
    }

    /// The operation to send for `operation`: itself, the create it needs first, or nil when it
    /// waits for a bean.
    private func resolve(_ operation: OutboxOperation, in queue: OutboxDependencies, depth: Int) throws -> OutboxOperation? {
        guard depth < 3 else {
            return operation
        }
        if operation.action == .delete {
            return operation
        }
        switch operation.resource {
        case .bean?:
            return queue.waitingBeans.contains(operation.localID) ? nil : operation
        case .shelfEntry?:
            guard let bean = try shelfEntry(localID: operation.localID)?.bean else {
                return operation
            }
            return try needing(bean.localID, serverID: bean.serverID, create: queue.beanCreates, for: operation, in: queue, depth: depth)
        case .brew?:
            guard let entry = try brew(localID: operation.localID)?.shelfEntry else {
                return operation
            }
            return try needing(entry.localID, serverID: entry.serverID, create: queue.entryCreates, for: operation, in: queue, depth: depth)
        case .recipe?, .profile?, nil:
            return operation
        }
    }

    /// `operation` names the item `localID`: without a server id and with its create queued,
    /// that create (resolved in turn) goes first.
    private func needing(
        _ localID: UUID,
        serverID: String?,
        create: [UUID: OutboxOperation],
        for operation: OutboxOperation,
        in queue: OutboxDependencies,
        depth: Int
    ) throws -> OutboxOperation? {
        guard serverID == nil, let first = create[localID], first.sequence != operation.sequence else {
            return operation
        }
        return try resolve(first, in: queue, depth: depth + 1)
    }

    /// The local ids of the beans whose look-up waits at `now`: for the user's answer, or until
    /// its `nextAttemptAt` (M2-T25).
    static func waitingBeanIDs(in operations: [OutboxOperation], at now: Date) -> Set<UUID> {
        var waiting = Set<UUID>()
        for operation in operations where !operation.parked && operation.resource == .bean {
            switch operation.action {
            case .awaitConfirmation?, .awaitDescription?:
                waiting.insert(operation.localID)
            case .lookUp? where operation.nextAttemptAt > now:
                waiting.insert(operation.localID)
            default:
                break
            }
        }
        return waiting
    }

    /// The earliest moment after `now` at which a waiting bean look-up may be tried again, nil
    /// when none waits for a moment. The engine rests no longer than that.
    func nextLookUpAttempt(after now: Date) throws -> Date? {
        let lookUpRaw = OutboxAction.lookUp.rawValue
        let beanRaw = OutboxResource.bean.rawValue
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in
                operation.parked == false && operation.actionRaw == lookUpRaw && operation.resourceRaw == beanRaw
            }
        )
        return try context.fetch(descriptor).map(\.nextAttemptAt).filter { date in date > now }.min()
    }

    /// The operation with this sequence number, if it is still queued.
    func outboxOperation(sequence: Int) throws -> OutboxOperation? {
        var descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.sequence == sequence }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The operations of one item, in order, parked ones included.
    func outboxOperations(for localID: UUID) throws -> [OutboxOperation] {
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.localID == localID },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        return try context.fetch(descriptor)
    }

    /// Adds an operation after every other one. Does not save: the caller saves it together
    /// with the item change.
    @discardableResult
    func enqueue(_ action: OutboxAction, _ resource: OutboxResource, localID: UUID) throws -> OutboxOperation {
        // Every operation, inserted-but-unsaved ones included, and the highest sequence among
        // them. A fetch with `fetchLimit` does not reliably see unsaved inserts (seen in the macOS
        // `ios` job): two operations queued before one save then got the same sequence, and the
        // engine, which finds an operation again by its sequence, picked the wrong one forever.
        // Queues are short, so reading them all is cheap.
        let last = try context.fetch(FetchDescriptor<OutboxOperation>()).map(\.sequence).max() ?? 0
        let operation = OutboxOperation(
            sequence: last + 1,
            resourceRaw: resource.rawValue,
            actionRaw: action.rawValue,
            localID: localID
        )
        context.insert(operation)
        return operation
    }

    /// Removes every operation of one item. Does not save.
    func removeOutboxOperations(for localID: UUID) throws {
        for operation in try outboxOperations(for: localID) {
            context.delete(operation)
        }
    }

    /// Queues an update after a local edit, unless an operation that has not been sent yet
    /// already carries it: the body is built when an operation is sent, so a create or an
    /// update that is still waiting sends the new values too. Nothing is queued for an item
    /// with a parked operation (it stays on the device, flagged) or one being deleted.
    func enqueueEdit<Model: SyncTracked>(of item: Model) throws {
        let resource = Model.outboxResource
        guard resource.sendsUpdates, item.syncState != .pendingDelete else {
            return
        }
        let operations = try outboxOperations(for: item.localID)
        if operations.contains(where: { operation in operation.parked }) {
            return
        }
        let carried = operations.contains { operation in
            (operation.action == .create || operation.action == .update) && !operation.sentWithoutAnswer
        }
        if !carried {
            try enqueue(.update, resource, localID: item.localID)
        }
    }

    /// Whether the server may already have an item that is still `pendingCreate`: its create
    /// was sent at least once without a clear answer, or is on its way.
    func createMayHaveReachedServer(_ localID: UUID) throws -> Bool {
        try outboxOperations(for: localID).contains { operation in
            operation.action == .create && operation.sentWithoutAnswer && !operation.parked
        }
    }

    // MARK: - Items by local id (the engine finds items this way)

    func bean(localID: UUID) throws -> StoredBean? {
        var descriptor = FetchDescriptor<StoredBean>(predicate: #Predicate<StoredBean> { bean in bean.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func shelfEntry(localID: UUID) throws -> StoredShelfEntry? {
        var descriptor = FetchDescriptor<StoredShelfEntry>(predicate: #Predicate<StoredShelfEntry> { entry in entry.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func brew(localID: UUID) throws -> StoredBrew? {
        var descriptor = FetchDescriptor<StoredBrew>(predicate: #Predicate<StoredBrew> { brew in brew.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func recipe(localID: UUID) throws -> StoredRecipe? {
        var descriptor = FetchDescriptor<StoredRecipe>(predicate: #Predicate<StoredRecipe> { recipe in recipe.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    // MARK: - Items by server id, removed ones included

    func shelfEntry(serverID: String) throws -> StoredShelfEntry? {
        let id: String? = serverID
        var descriptor = FetchDescriptor<StoredShelfEntry>(predicate: #Predicate<StoredShelfEntry> { entry in entry.serverID == id })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func brew(serverID: String) throws -> StoredBrew? {
        let id: String? = serverID
        var descriptor = FetchDescriptor<StoredBrew>(predicate: #Predicate<StoredBrew> { brew in brew.serverID == id })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func recipe(serverID: String) throws -> StoredRecipe? {
        let id: String? = serverID
        var descriptor = FetchDescriptor<StoredRecipe>(predicate: #Predicate<StoredRecipe> { recipe in recipe.serverID == id })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }
}

/// The unparked creates of beans and shelf entries, and the beans that wait, read once per
/// `nextOutboxOperation(at:)`.
struct OutboxDependencies {
    /// The first unparked create (or look-up) of each bean, by local id.
    let beanCreates: [UUID: OutboxOperation]
    /// The first unparked create of each shelf entry, by local id.
    let entryCreates: [UUID: OutboxOperation]
    let waitingBeans: Set<UUID>

    init(operations: [OutboxOperation], now: Date) {
        var beans: [UUID: OutboxOperation] = [:]
        var entries: [UUID: OutboxOperation] = [:]
        for operation in operations where !operation.parked && operation.action?.createsItem == true {
            switch operation.resource {
            case .bean?:
                if beans[operation.localID] == nil {
                    beans[operation.localID] = operation
                }
            case .shelfEntry?:
                if entries[operation.localID] == nil {
                    entries[operation.localID] = operation
                }
            default:
                break
            }
        }
        beanCreates = beans
        entryCreates = entries
        waitingBeans = AccountStore.waitingBeanIDs(in: operations, at: now)
    }
}
