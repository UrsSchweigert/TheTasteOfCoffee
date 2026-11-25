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

    /// The operation to send next: the lowest sequence that is not parked.
    func nextOutboxOperation() throws -> OutboxOperation? {
        var descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.parked == false },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
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
