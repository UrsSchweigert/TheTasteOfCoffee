import Foundation
import SwiftData

// The local store (M2-T15). SwiftData is the device's copy of the user's own data
// (docs/04, Non-functional: Offline). One store per account (`StoreLocation`, ADR 0020).
//
// Rules for every model:
// - `localID` is created on the device and never changes. `serverID` is the server's id,
//   nil until the server has the item.
// - `vocabularyVersion` is the version the values were picked from.
// - `syncStateRaw` holds a `SyncState` raw value.
// - Vocabulary values are stored as their contract ids (`...ID` properties) and read through
//   the generated `Vocabulary` types: an id the bundled vocabulary does not know reads as nil
//   and is kept as it is, never dropped and never a crash. No list is defined here.
//
// - `syncIssueRaw` holds a `SyncIssue` raw value, nil while nothing went wrong (M2-T16).
//
// `OutboxOperation` (M2-T16, ADR 0025) joined version 1 before any release: no store with
// the shorter model list exists outside development, so no migration stage is needed.
// Later versions add a `CupmarkSchemaV<N>` and a stage in `CupmarkMigrationPlan`; version 2
// (M2-T25) adds `QueuedLabelPhoto` and changes no model of version 1.

/// Version 1 of the local schema.
enum CupmarkSchemaV1: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(1, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [StoredBean.self, StoredShelfEntry.self, StoredBrew.self, StoredRecipe.self, StoredProfile.self, OutboxOperation.self]
    }

    /// A catalogue bean the user has on a shelf entry or has scanned (API `Bean`), or a bean
    /// picked from lists on the device and not yet created (API `BeanCreate`).
    @Model
    final class StoredBean {
        /// The only unique attribute: the outbox (M2-T16) finds items by it.
        @Attribute(.unique) var localID: UUID = UUID()
        /// `bean_id`.
        var serverID: String?
        var vocabularyVersion: Int = Vocabulary.version
        var syncStateRaw: String = SyncState.pendingCreate.rawValue
        /// A `SyncIssue` raw value, nil while the item has none.
        var syncIssueRaw: String?

        /// 13-digit `barcode`, as the server stores it.
        var barcode: String?
        var verified: Bool = false
        /// `open_food_facts_match`.
        var openFoodFactsMatch: Bool = false
        /// `open_food_facts_confirmed` of a bean created on the device.
        var openFoodFactsConfirmed: Bool = false
        /// Whether the server sent an `open_food_facts` object.
        var hasOpenFoodFactsProduct: Bool = false
        /// Untrusted text from the server's Open Food Facts copy (ADR 0005). Shown as plain
        /// text only, never logged, never sent back.
        var openFoodFactsName: String?
        var openFoodFactsBrand: String?
        var openFoodFactsImageID: String?

        /// `picked_attributes`, as contract ids.
        var pickedProcessID: String?
        var pickedRoastLevelID: String?
        var pickedOriginID: String?
        var pickedSpeciesID: String?
        var pickedVarietyID: String?

        /// `operator_attributes`, as contract ids.
        var operatorProcessID: String?
        var operatorRoastLevelID: String?
        var operatorOriginID: String?
        var operatorSpeciesID: String?
        var operatorVarietyID: String?

        @Relationship(deleteRule: .nullify, inverse: \StoredShelfEntry.bean)
        var shelfEntries: [StoredShelfEntry] = []

        init(
            localID: UUID = UUID(),
            serverID: String? = nil,
            vocabularyVersion: Int = Vocabulary.version,
            barcode: String? = nil
        ) {
            self.localID = localID
            self.serverID = serverID
            self.vocabularyVersion = vocabularyVersion
            self.syncStateRaw = SyncState.pendingCreate.rawValue
            self.syncIssueRaw = nil
            self.barcode = barcode
            self.verified = false
            self.openFoodFactsMatch = false
            self.openFoodFactsConfirmed = false
            self.hasOpenFoodFactsProduct = false
            self.openFoodFactsName = nil
            self.openFoodFactsBrand = nil
            self.openFoodFactsImageID = nil
            self.pickedProcessID = nil
            self.pickedRoastLevelID = nil
            self.pickedOriginID = nil
            self.pickedSpeciesID = nil
            self.pickedVarietyID = nil
            self.operatorProcessID = nil
            self.operatorRoastLevelID = nil
            self.operatorOriginID = nil
            self.operatorSpeciesID = nil
            self.operatorVarietyID = nil
            self.shelfEntries = []
        }
    }

    /// A bag on the user's shelf (API `ShelfEntryInput` / `ShelfEntry`).
    @Model
    final class StoredShelfEntry {
        @Attribute(.unique) var localID: UUID = UUID()
        /// `shelf_entry_id`.
        var serverID: String?
        var vocabularyVersion: Int = Vocabulary.version
        var syncStateRaw: String = SyncState.pendingCreate.rawValue
        /// A `SyncIssue` raw value, nil while the item has none.
        var syncIssueRaw: String?
        /// When the item was made on this device; orders entries with the same purchase date.
        var createdAt: Date = Date.now

        /// The bean; its `serverID` is the entry's `bean_id`.
        var bean: StoredBean?
        /// `purchase_date`, `YYYY-MM-DD`. Sorts as a string.
        var purchaseDateRaw: String = ""
        /// `roast_date`, `YYYY-MM-DD`.
        var roastDateRaw: String?
        /// `bag_size`, a contract id.
        var bagSizeID: String?
        /// `price_band`, a contract id.
        var priceBandID: String?

        @Relationship(deleteRule: .nullify, inverse: \StoredBrew.shelfEntry)
        var brews: [StoredBrew] = []

        init(
            localID: UUID = UUID(),
            serverID: String? = nil,
            vocabularyVersion: Int = Vocabulary.version,
            purchaseDate: API.CalendarDate,
            createdAt: Date = Date.now
        ) {
            self.localID = localID
            self.serverID = serverID
            self.vocabularyVersion = vocabularyVersion
            self.syncStateRaw = SyncState.pendingCreate.rawValue
            self.syncIssueRaw = nil
            self.createdAt = createdAt
            self.bean = nil
            self.purchaseDateRaw = purchaseDate.description
            self.roastDateRaw = nil
            self.bagSizeID = nil
            self.priceBandID = nil
            self.brews = []
        }
    }

    /// One brew with its optional rating (API `BrewInput` / `Brew`).
    @Model
    final class StoredBrew {
        @Attribute(.unique) var localID: UUID = UUID()
        /// `brew_id`.
        var serverID: String?
        var vocabularyVersion: Int = Vocabulary.version
        var syncStateRaw: String = SyncState.pendingCreate.rawValue
        /// A `SyncIssue` raw value, nil while the item has none.
        var syncIssueRaw: String?

        /// The shelf entry; its `serverID` is the brew's `shelf_entry_id`.
        var shelfEntry: StoredShelfEntry?
        /// `brewed_at` in whole milliseconds since 1970, exactly as `API.Timestamp` holds it.
        var brewedAtMilliseconds: Int64 = 0

        /// `parameters` (see `BrewParameterColumns`).
        var methodID: String = ""
        var doseDg: Int?
        var waterG: Int?
        var waterTempC: Int?
        var waterTempSpecialID: String?
        var brewTimeS: Int?
        var grindNormalised: Double?
        var waterTypeID: String?
        var milkID: String?

        /// `rating`, a JSON-encoded `RatingValues` (criterion, dimension and note ids as
        /// keys and values), nil for an unrated brew. Read it through `rating`.
        var ratingData: Data?

        init(
            localID: UUID = UUID(),
            serverID: String? = nil,
            vocabularyVersion: Int = Vocabulary.version,
            brewedAtMilliseconds: Int64,
            methodID: String
        ) {
            self.localID = localID
            self.serverID = serverID
            self.vocabularyVersion = vocabularyVersion
            self.syncStateRaw = SyncState.pendingCreate.rawValue
            self.syncIssueRaw = nil
            self.shelfEntry = nil
            self.brewedAtMilliseconds = brewedAtMilliseconds
            self.methodID = methodID
            self.doseDg = nil
            self.waterG = nil
            self.waterTempC = nil
            self.waterTempSpecialID = nil
            self.brewTimeS = nil
            self.grindNormalised = nil
            self.waterTypeID = nil
            self.milkID = nil
            self.ratingData = nil
        }
    }

    /// A saved set of brew parameters (API `RecipeInput` / `Recipe`).
    @Model
    final class StoredRecipe {
        @Attribute(.unique) var localID: UUID = UUID()
        /// `recipe_id`.
        var serverID: String?
        var vocabularyVersion: Int = Vocabulary.version
        var syncStateRaw: String = SyncState.pendingCreate.rawValue
        /// A `SyncIssue` raw value, nil while the item has none.
        var syncIssueRaw: String?
        /// When the recipe was made on this device; recipes list newest first.
        var createdAt: Date = Date.now

        var methodID: String = ""
        var doseDg: Int?
        var waterG: Int?
        var waterTempC: Int?
        var waterTempSpecialID: String?
        var brewTimeS: Int?
        var grindNormalised: Double?
        var waterTypeID: String?
        var milkID: String?

        init(
            localID: UUID = UUID(),
            serverID: String? = nil,
            vocabularyVersion: Int = Vocabulary.version,
            methodID: String,
            createdAt: Date = Date.now
        ) {
            self.localID = localID
            self.serverID = serverID
            self.vocabularyVersion = vocabularyVersion
            self.syncStateRaw = SyncState.pendingCreate.rawValue
            self.syncIssueRaw = nil
            self.createdAt = createdAt
            self.methodID = methodID
            self.doseDg = nil
            self.waterG = nil
            self.waterTempC = nil
            self.waterTempSpecialID = nil
            self.brewTimeS = nil
            self.grindNormalised = nil
            self.waterTypeID = nil
            self.milkID = nil
        }
    }

    /// The user's profile (API `Profile`): one per store. The API addresses it as `/profile`
    /// through the token and gives it no id, so it has a `localID` but no `serverID`;
    /// `syncState` says whether the server has the current values.
    @Model
    final class StoredProfile {
        @Attribute(.unique) var localID: UUID = UUID()
        /// Kept for the same rule as every model. The profile holds no vocabulary list value.
        var vocabularyVersion: Int = Vocabulary.version
        var syncStateRaw: String = SyncState.pendingCreate.rawValue
        /// A `SyncIssue` raw value, nil while the item has none.
        var syncIssueRaw: String?

        /// `locale`, a `VocabularyLanguage` raw value.
        var localeID: String = VocabularyLanguage.fallback.rawValue
        /// `consent.contribute_to_aggregates`. False until the user agrees (D1, ADR 0017).
        var contributeToAggregates: Bool = false

        init(
            localID: UUID = UUID(),
            vocabularyVersion: Int = Vocabulary.version,
            localeID: String,
            contributeToAggregates: Bool
        ) {
            self.localID = localID
            self.vocabularyVersion = vocabularyVersion
            self.syncStateRaw = SyncState.pendingCreate.rawValue
            self.syncIssueRaw = nil
            self.localeID = localeID
            self.contributeToAggregates = contributeToAggregates
        }
    }

    /// One local write waiting for the server (M2-T16, ADR 0025). It is written in the same
    /// save as the item change, so a write that returned is also queued. It names the item by
    /// `localID` only: the request body is built from the item's current values when the
    /// operation is sent, so a reference to another item (a shelf entry's bean, a brew's
    /// shelf entry) is resolved to that item's server id at that moment.
    @Model
    final class OutboxOperation {
        /// The order of the operations of this store: lower goes first. Not unique on
        /// purpose; SwiftData would make a duplicate an upsert.
        var sequence: Int = 0
        /// An `OutboxResource` raw value.
        var resourceRaw: String = ""
        /// An `OutboxAction` raw value.
        var actionRaw: String = ""
        /// The `localID` of the item.
        var localID: UUID = UUID()
        var createdAt: Date = Date.now
        /// How often it was sent. Counted before each send.
        var attemptCount: Int = 0
        /// Not sent again before this moment (backoff).
        var nextAttemptAt: Date = Date.distantPast
        /// True once the request may have reached the server without an answer that says
        /// what happened. A create with this flag is checked against the server's list before
        /// it is sent again (ADR 0025).
        var sentWithoutAnswer: Bool = false
        /// The JSON body of the last send of a create, nil before. The check before a retry
        /// matches the server's items against it, not against the item's current values.
        var sentBody: Data?
        /// A parked operation failed for good and is never sent again; the item is flagged.
        var parked: Bool = false
        /// An `OutboxParkReason` raw value, nil unless parked.
        var parkReasonRaw: String?

        init(sequence: Int, resourceRaw: String, actionRaw: String, localID: UUID, createdAt: Date = Date.now) {
            self.sequence = sequence
            self.resourceRaw = resourceRaw
            self.actionRaw = actionRaw
            self.localID = localID
            self.createdAt = createdAt
            self.attemptCount = 0
            self.nextAttemptAt = Date.distantPast
            self.sentWithoutAnswer = false
            self.sentBody = nil
            self.parked = false
            self.parkReasonRaw = nil
        }
    }
}

/// Version 2 of the local schema (M2-T25): version 1's models, unchanged, and
/// `QueuedLabelPhoto`, a label photo waiting for its bean's server id or for the network.
///
/// The models of version 1 are listed as they are, so their entities keep the hashes of
/// version 1 and a store written by version 1 migrates with one lightweight stage that only
/// adds the new entity. Stores of version 1 may exist on development devices, so
/// the new model is a new version rather than an edit of version 1.
enum CupmarkSchemaV2: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(2, 0, 0) }

    static var models: [any PersistentModel.Type] {
        CupmarkSchemaV1.models + [QueuedLabelPhoto.self]
    }

    /// A label photo taken for a bean, kept in the account's store until it is uploaded
    /// (M2-T25, ADR 0016). The JPEG is a file of the account's queue folder
    /// (`LabelPhotoFolders`); `fileName` names it, so a moved app container does not matter.
    /// The upload runs once the bean has a server id, and resumes from `jobData`.
    @Model
    final class QueuedLabelPhoto {
        @Attribute(.unique) var localID: UUID = UUID()
        /// The `localID` of the `StoredBean` the photo is for.
        var beanLocalID: UUID = UUID()
        /// The JPEG's file name in the account's queue folder.
        var fileName: String = ""
        var createdAt: Date = Date.now
        /// The encoded `LabelPhotoUploadJob` of the last run, nil before the first. A retry
        /// resumes from its stage, so a successful S3 POST is not repeated.
        var jobData: Data?
        /// Runs so far; the backoff after a failed run grows with it.
        var attemptCount: Int = 0
        /// Not run again before this moment.
        var nextAttemptAt: Date = Date.distantPast

        init(localID: UUID = UUID(), beanLocalID: UUID, fileName: String, createdAt: Date = Date.now) {
            self.localID = localID
            self.beanLocalID = beanLocalID
            self.fileName = fileName
            self.createdAt = createdAt
            self.jobData = nil
            self.attemptCount = 0
            self.nextAttemptAt = Date.distantPast
        }
    }
}

/// Migrations between local schema versions. A new version adds its schema to `schemas` and
/// a `MigrationStage` here.
enum CupmarkMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [CupmarkSchemaV1.self, CupmarkSchemaV2.self] }

    /// Version 1 to 2 adds an entity and changes none: lightweight.
    static var stages: [MigrationStage] {
        [MigrationStage.lightweight(fromVersion: CupmarkSchemaV1.self, toVersion: CupmarkSchemaV2.self)]
    }
}

// The current models. A new schema version moves these aliases; version 2 kept every
// model of version 1 as it was.
typealias StoredBean = CupmarkSchemaV1.StoredBean
typealias StoredShelfEntry = CupmarkSchemaV1.StoredShelfEntry
typealias StoredBrew = CupmarkSchemaV1.StoredBrew
typealias StoredRecipe = CupmarkSchemaV1.StoredRecipe
typealias StoredProfile = CupmarkSchemaV1.StoredProfile
typealias OutboxOperation = CupmarkSchemaV1.OutboxOperation
typealias QueuedLabelPhoto = CupmarkSchemaV2.QueuedLabelPhoto
