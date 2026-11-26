import Foundation
import SwiftData

// The items whose sync went wrong, and the two ways out (M2-T18, ADR 0025): redo it or
// discard the local change. ADR 0025 leaves parked operations and flags on the device until
// a screen offers these; `SyncIssuesScreen` does.

/// Why a sync issue cannot be discarded now.
enum SyncIssueDiscardBlock: Equatable, Sendable {
    /// Discarding the entry's create removes the entry, and brews on the device still
    /// reference it (ADR 0012). Remove them first.
    case shelfEntryHasBrews
    /// Discarding the bean's create removes the bean, and shelf entries still name it.
    case beanHasShelfEntries
}

/// One item with a sync issue: a parked operation, or a flag the engine set
/// (`SyncIssue`) with nothing waiting.
struct SyncIssueItem: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// The item's operation was parked: it is never sent again until redone. The action
        /// is nil for an operation this build cannot read.
        /// - create: the server never accepted the item; it is on this device only;
        /// - update: a change (also a 404-then-200 on `PUT`) was refused;
        /// - delete: a removal was refused; the item is still `pendingDelete`, hidden.
        case parked(OutboxAction?, OutboxParkReason?)
        /// A flag only: `beanChangeReverted`, `deleteRestored`, or a `rejected` flag whose
        /// operation is gone. Redo clears it.
        case flagged(SyncIssue)
    }

    let resource: OutboxResource
    let localID: UUID
    let kind: Kind
    /// Why `discard` would refuse, nil when it would not.
    let discardBlock: SyncIssueDiscardBlock?

    var id: UUID { localID }

    /// Whether the item has a parked operation that redo sends again.
    var isParked: Bool {
        if case .parked = kind {
            return true
        }
        return false
    }

    /// Whether a discard is offered and possible: only a parked operation has a local change
    /// to drop. A flag is cleared with redo.
    var allowsDiscard: Bool {
        isParked && discardBlock == nil
    }
}

extension AccountStore {
    /// Every item with a parked operation (in queue order), then every flagged item without
    /// one. Items removed on the device are included: a rejected delete leaves its item
    /// `pendingDelete`, hidden from every other list. A parked operation whose resource this
    /// build does not know names no item it can show, and is left out.
    func syncIssues() throws -> [SyncIssueItem] {
        var items: [SyncIssueItem] = []
        var seen = Set<UUID>()

        let parked = try context.fetch(FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.parked == true },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        ))
        for operation in parked {
            guard let resource = operation.resource, !seen.contains(operation.localID),
                  try syncTrackedItem(resource, operation.localID) != nil else {
                continue
            }
            seen.insert(operation.localID)
            let action = operation.action
            let removesItem = try discardRemovesItem(resource, operation.localID, action: action)
            let block = try discardBlock(resource, operation.localID, removesItem: removesItem)
            items.append(SyncIssueItem(
                resource: resource,
                localID: operation.localID,
                kind: .parked(action, operation.parkReason),
                discardBlock: block
            ))
        }

        func addFlagged(_ resource: OutboxResource, _ flagged: [any SyncTracked]) {
            for item in flagged where !seen.contains(item.localID) {
                guard let issue = item.syncIssue else {
                    continue
                }
                seen.insert(item.localID)
                items.append(SyncIssueItem(resource: resource, localID: item.localID, kind: .flagged(issue), discardBlock: nil))
            }
        }
        addFlagged(.bean, try context.fetch(FetchDescriptor<StoredBean>(
            predicate: #Predicate<StoredBean> { bean in bean.syncIssueRaw != nil }
        )))
        addFlagged(.shelfEntry, try context.fetch(FetchDescriptor<StoredShelfEntry>(
            predicate: #Predicate<StoredShelfEntry> { entry in entry.syncIssueRaw != nil },
            sortBy: [SortDescriptor(\StoredShelfEntry.createdAt)]
        )))
        addFlagged(.brew, try context.fetch(FetchDescriptor<StoredBrew>(
            predicate: #Predicate<StoredBrew> { brew in brew.syncIssueRaw != nil },
            sortBy: [SortDescriptor(\StoredBrew.brewedAtMilliseconds)]
        )))
        addFlagged(.recipe, try context.fetch(FetchDescriptor<StoredRecipe>(
            predicate: #Predicate<StoredRecipe> { recipe in recipe.syncIssueRaw != nil },
            sortBy: [SortDescriptor(\StoredRecipe.createdAt)]
        )))
        if let profile = try profile() {
            addFlagged(.profile, [profile])
        }
        return items
    }

    /// Redo: a parked operation goes back into the queue at its own place, with a fresh
    /// attempt count and no wait, and is sent from the item's current values. A parked
    /// create of the item it references (a shelf entry's bean, a brew's shelf entry and that
    /// entry's bean) is redone with it, since without it the item would only be parked again
    /// as `missing_reference` (ADR 0025, Addendum). A referenced item's other parked
    /// operations (a refused update or delete) stay parked with their flag: they are its own
    /// issues. The flags of the redone items are cleared. For a flag only, clearing it is all.
    func redo(_ issue: SyncIssueItem) throws {
        // On failure every operation and flag goes back to its saved value (`write`).
        try write {
            try redoParked(issue)
        }
    }

    private func redoParked(_ issue: SyncIssueItem) throws {
        // The item itself, then the items it references.
        var targets: [(resource: OutboxResource, localID: UUID)] = [(issue.resource, issue.localID)]
        if issue.isParked {
            switch issue.resource {
            case .shelfEntry:
                if let bean = try shelfEntry(localID: issue.localID)?.bean {
                    targets.append((.bean, bean.localID))
                }
            case .brew:
                if let entry = try brew(localID: issue.localID)?.shelfEntry {
                    targets.append((.shelfEntry, entry.localID))
                    if let bean = entry.bean {
                        targets.append((.bean, bean.localID))
                    }
                }
            case .bean, .recipe, .profile:
                break
            }
        }
        for (index, target) in targets.enumerated() {
            let operations = try outboxOperations(for: target.localID).filter { operation in
                // The item itself: every parked operation. A referenced item: its create only.
                operation.parked && (index == 0 || operation.action?.createsItem == true)
            }
            if index > 0, operations.isEmpty {
                // A referenced item with no parked create keeps its flag.
                continue
            }
            for operation in operations {
                operation.parked = false
                operation.parkReason = nil
                operation.attemptCount = 0
                operation.nextAttemptAt = Date.distantPast
            }
            if let item = try syncTrackedItem(target.resource, target.localID) {
                item.syncIssue = nil
            }
        }
        try save()
    }

    /// Discard: drops the local change that was refused.
    /// - A parked create (or any parked operation of an item the server never had): the item
    ///   is removed with its operations. Refused while brews still reference a shelf entry or
    ///   shelf entries still name a bean (`discardBlock`).
    /// - A parked update or delete: the parked operations are removed and the item counts as
    ///   synced again (pending, if another operation still waits), so the next pull gives it
    ///   the server's values. A rejected delete brings the item back into the lists.
    /// - A flag only, or a row read before its operation was redone elsewhere (nothing of the
    ///   item is parked any more): the flag is cleared and nothing is removed.
    func discard(_ issue: SyncIssueItem) throws {
        // On failure every operation, flag and sync state goes back to its saved value, and
        // removed items come back (`write`).
        try write {
            try discardParked(issue)
        }
    }

    private func discardParked(_ issue: SyncIssueItem) throws {
        // Read again: the row may be stale (redone meanwhile), and then nothing is dropped.
        let parked = try outboxOperations(for: issue.localID).filter { operation in operation.parked }
        guard issue.isParked, let first = parked.first else {
            if let item = try syncTrackedItem(issue.resource, issue.localID) {
                item.syncIssue = nil
            }
            try save()
            return
        }
        let action = first.action
        guard try syncTrackedItem(issue.resource, issue.localID) != nil else {
            try removeOutboxOperations(for: issue.localID)
            try save()
            return
        }
        let removesItem = try discardRemovesItem(issue.resource, issue.localID, action: action)
        switch try discardBlock(issue.resource, issue.localID, removesItem: removesItem) {
        case .shelfEntryHasBrews:
            throw LocalStoreError.shelfEntryHasBrews
        case .beanHasShelfEntries:
            throw LocalStoreError.beanHasShelfEntries
        case nil:
            break
        }
        if removesItem {
            try removeOutboxOperations(for: issue.localID)
            try deleteTrackedItem(issue.resource, issue.localID)
        } else {
            let operations = try outboxOperations(for: issue.localID)
            for operation in operations where operation.parked {
                context.delete(operation)
            }
            let waiting = operations.filter { operation in !operation.parked }.compactMap(\.action)
            if let item = try syncTrackedItem(issue.resource, issue.localID) {
                item.syncState = AccountStore.syncState(whileWaiting: waiting)
                item.syncIssue = nil
            }
        }
        try save()
    }

    // MARK: - Helpers

    /// The sync state of a kept item whose parked operations were dropped, from the
    /// operations still waiting: a waiting delete keeps it `pendingDelete` (hidden), a waiting
    /// create `pendingCreate`, a waiting update `pendingUpdate`; nothing waiting is `synced`.
    static func syncState(whileWaiting actions: [OutboxAction]) -> SyncState {
        if actions.contains(.delete) {
            return .pendingDelete
        }
        if actions.contains(where: { action in action.createsItem }) {
            return .pendingCreate
        }
        if actions.contains(.update) {
            return .pendingUpdate
        }
        return .synced
    }

    /// Whether discarding the parked operation removes the item: a create, or any operation
    /// of an item that has no server id (the profile has none by design and is never removed).
    private func discardRemovesItem(_ resource: OutboxResource, _ localID: UUID, action: OutboxAction?) throws -> Bool {
        if resource == .profile {
            return false
        }
        if action?.createsItem == true {
            return true
        }
        switch resource {
        case .bean: return try bean(localID: localID)?.serverID == nil
        case .shelfEntry: return try shelfEntry(localID: localID)?.serverID == nil
        case .brew: return try brew(localID: localID)?.serverID == nil
        case .recipe: return try recipe(localID: localID)?.serverID == nil
        case .profile: return false
        }
    }

    private func discardBlock(_ resource: OutboxResource, _ localID: UUID, removesItem: Bool) throws -> SyncIssueDiscardBlock? {
        guard removesItem else {
            return nil
        }
        switch resource {
        case .shelfEntry:
            if let entry = try shelfEntry(localID: localID), entry.liveBrewCount > 0 {
                return .shelfEntryHasBrews
            }
        case .bean:
            if let bean = try bean(localID: localID), !bean.shelfEntries.isEmpty {
                return .beanHasShelfEntries
            }
        case .brew, .recipe, .profile:
            break
        }
        return nil
    }

    /// The item of `resource` with this local id, removed ones included.
    func syncTrackedItem(_ resource: OutboxResource, _ localID: UUID) throws -> (any SyncTracked)? {
        switch resource {
        case .bean: return try bean(localID: localID)
        case .shelfEntry: return try shelfEntry(localID: localID)
        case .brew: return try brew(localID: localID)
        case .recipe: return try recipe(localID: localID)
        case .profile:
            let profile = try profile()
            return profile?.localID == localID ? profile : nil
        }
    }

    private func deleteTrackedItem(_ resource: OutboxResource, _ localID: UUID) throws {
        switch resource {
        case .bean:
            if let item = try bean(localID: localID) { context.delete(item) }
        case .shelfEntry:
            if let item = try shelfEntry(localID: localID) { context.delete(item) }
        case .brew:
            if let item = try brew(localID: localID) { context.delete(item) }
        case .recipe:
            if let item = try recipe(localID: localID) { context.delete(item) }
        case .profile:
            break
        }
    }
}
