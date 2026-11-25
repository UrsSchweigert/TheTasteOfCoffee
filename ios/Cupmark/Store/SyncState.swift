import Foundation

/// Where a local item stands against the server. Stored as its raw value
/// (`syncStateRaw`), never as an enum attribute, so predicates can compare plain strings.
enum SyncState: String, CaseIterable, Sendable {
    /// The server has the same values.
    case synced = "synced"
    /// Created on the device, not yet on the server.
    case pendingCreate = "pending_create"
    /// Changed on the device after the server had it.
    case pendingUpdate = "pending_update"
    /// Removed on the device, still on the server. Hidden from every list.
    case pendingDelete = "pending_delete"

    /// The state after a local edit. An item the server never had stays a create; a removed
    /// item stays removed.
    var afterLocalEdit: SyncState {
        switch self {
        case .synced, .pendingUpdate: return .pendingUpdate
        case .pendingCreate: return .pendingCreate
        case .pendingDelete: return .pendingDelete
        }
    }

    /// What a local delete does: an item the server never had is removed at once, any other
    /// is kept as `pendingDelete` until the server has removed it (M2-T16).
    var localDelete: LocalDelete {
        switch self {
        case .pendingCreate: return .removeNow
        case .synced, .pendingUpdate, .pendingDelete: return .markPendingDelete
        }
    }

    enum LocalDelete: Equatable, Sendable {
        case removeNow
        case markPendingDelete
    }
}

/// Errors of the local store. None carries an account id or a stored value other than a
/// vocabulary id.
enum LocalStoreError: Error, Equatable {
    /// The account has no stable id, so it has no store.
    case emptyAccountID
    /// A stored id is not in the bundled vocabulary, for example one picked with a newer
    /// version on another device.
    case unknownVocabularyID(namespace: Vocabulary.Namespace, id: String)
    /// A stored locale is not a language the app has labels for.
    case unknownLanguage(String)
    /// The item references another item that has no server id yet.
    case missingServerID
    /// A stored date or timestamp cannot be sent.
    case invalidDate
    /// A stored rating lacks the score of a criterion.
    case incompleteRating(missing: [Vocabulary.Criterion])
    /// The shelf entry still has brews (ADR 0012); remove them first.
    case shelfEntryHasBrews
}

/// Decodes stored vocabulary ids through the generated `Vocabulary` types.
enum StoredVocabulary {
    /// The entry for `id`, or nil when `id` is nil or unknown. Never traps.
    static func decode<Item: VocabularyItem>(_ id: String?, as type: Item.Type = Item.self) -> Item? {
        id.flatMap { raw in Item(rawValue: raw) }
    }

    /// The entry for `id`, nil when `id` is nil; throws `unknownVocabularyID` for an id
    /// the bundled vocabulary does not know. Used before a value is sent.
    static func require<Item: VocabularyItem>(_ id: String?, as type: Item.Type = Item.self) throws -> Item? {
        guard let id else {
            return nil
        }
        guard let item = Item(rawValue: id) else {
            throw LocalStoreError.unknownVocabularyID(namespace: Item.namespace, id: id)
        }
        return item
    }
}
