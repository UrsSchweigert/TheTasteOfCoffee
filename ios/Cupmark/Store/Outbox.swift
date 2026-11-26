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
    /// then Open Food Facts through the backend. A known bean is used; an Open Food Facts
    /// miss becomes a `create`; a hit becomes `awaitConfirmation`. While it waits for its next
    /// attempt it does not hold the queue: only the operations that depend on its bean wait.
    case lookUp = "look_up"
    /// A bean with an Open Food Facts hit, waiting for the user's confirmation (M2-T25). Never
    /// sent: the user's confirm or reject turns it into a `create`. The operations that depend
    /// on the bean wait; every other one goes out.
    case awaitConfirmation = "await_confirmation"

    /// Whether the operation brings its item to the server for the first time: a create, or
    /// the look-up of a pending bean that ends in one.
    var createsItem: Bool {
        switch self {
        case .create, .lookUp, .awaitConfirmation: return true
        case .update, .delete: return false
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

    /// The operation to send next: the lowest sequence that is not parked and does not wait
    /// for a pending bean (M2-T25). A bean's look-up that waits for its next attempt, or for the
    /// user's confirmation, is skipped together with every operation whose item names that
    /// bean (a shelf entry on it, a brew on such an entry); everything else keeps its order.
    func nextOutboxOperation(at now: Date = Date()) throws -> OutboxOperation? {
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.parked == false },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        let candidates = try context.fetch(descriptor)
        let waiting = AccountStore.waitingBeanIDs(in: candidates, at: now)
        if waiting.isEmpty {
            return candidates.first
        }
        for operation in candidates {
            if try !dependsOnWaitingBean(operation, waiting: waiting) {
                return operation
            }
        }
        return nil
    }

    /// The local ids of the beans whose look-up waits at `now`: for the user's confirmation,
    /// or until its `nextAttemptAt` (M2-T25).
    static func waitingBeanIDs(in operations: [OutboxOperation], at now: Date) -> Set<UUID> {
        var waiting = Set<UUID>()
        for operation in operations where !operation.parked && operation.resource == .bean {
            switch operation.action {
            case .awaitConfirmation?:
                waiting.insert(operation.localID)
            case .lookUp? where operation.nextAttemptAt > now:
                waiting.insert(operation.localID)
            default:
                break
            }
        }
        return waiting
    }

    /// Whether the operation is a waiting bean's own, or its item names a waiting bean.
    private func dependsOnWaitingBean(_ operation: OutboxOperation, waiting: Set<UUID>) throws -> Bool {
        switch operation.resource {
        case .bean?:
            return waiting.contains(operation.localID)
        case .shelfEntry?:
            guard let bean = try shelfEntry(localID: operation.localID)?.bean else {
                return false
            }
            return waiting.contains(bean.localID)
        case .brew?:
            guard let bean = try brew(localID: operation.localID)?.shelfEntry?.bean else {
                return false
            }
            return waiting.contains(bean.localID)
        case .recipe?, .profile?, nil:
            return false
        }
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
        var descriptor = FetchDescriptor<OutboxOperation>(sortBy: [SortDescriptor(\OutboxOperation.sequence, order: .reverse)])
        descriptor.fetchLimit = 1
        let last = try context.fetch(descriptor).first?.sequence ?? 0
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
