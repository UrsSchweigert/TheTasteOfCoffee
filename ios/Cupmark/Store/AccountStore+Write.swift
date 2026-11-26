import Foundation
import os
import SwiftData

// Failed writes put every changed model back (M2-T35, ADR 0025 Addendum M2-T35).
//
// `ModelContext.rollback()` drops inserted models and unsaved deletes, but it does not restore
// an attribute changed on a model that was already saved (seen in the macOS `ios` job). A
// failed edit would then stay in memory with no operation queued, and the next unrelated save,
// by a screen or by the sync engine, would store it without ever sending it.
//
// So a failed write first puts back, on every model the context lists as changed or deleted,
// the values the store holds for it, and only then rolls back. The store is the snapshot: no
// write leaves anything unsaved (every write saves at once, and screens edit drafts, ADR 0025),
// so the last save is exactly the state a failed write returns to. The saved values are read
// through a fresh `ModelContext` on the same container, which sees only what is on disk. This
// needs no list of models from the caller, so it also covers what a write touches on the side:
// the outbox operations it changes, the bean a shelf entry leaves, a catalogue bean it updates.
//
// Writes nest (M2-T36): `addShelfEntry` and `addBrew` are writes of their own and are also
// called inside the screens' writes. Only the outermost write discards; an inner one just runs
// its body, and its error reaches the outer one, which owns every change made so far. An error
// of an inner write must not be caught inside the outer one: if it is, the outer write refuses
// every further save and throws `WriteNestingError.innerWriteFailed` at its end, after
// discarding, so nothing of the failed inner write is ever stored.
//
// The limits (M2-T36): a failure of `ModelContext.save()` itself is tested on a store opened
// read-only (`allowsSave: false`), the one way found to make SwiftData's save throw without the
// `willSave` hook. A uniqueness violation cannot be used: inserting a second model with the
// `localID` of another is an upsert in SwiftData, not a failed save, and the schema has no other
// constraint (no `.deny` delete rule, no relationship counts), and no schema change is made for
// a test.

/// The state of the writes under way, kept by `write { }` only.
struct WriteNesting {
    /// How many writes are running, one inside the other.
    var depth = 0
    /// True when an inner write threw inside the current outermost one.
    var innerWriteFailed = false
}

/// Thrown when an inner write's error was caught inside its outer write (see above).
enum WriteNestingError: Error, Equatable {
    /// A save after the failed inner write, or the outer write's end, was refused.
    case innerWriteFailed
}

/// Fixed messages only: no ids, no values, no paths.
private let writeLogger = Logger(subsystem: "Cupmark", category: "Store")

/// A model whose stored properties a failed write can put back from the store.
protocol SavedValuesRestorable: PersistentModel {
    /// The same model as last saved, read through `context` (a fresh context on the store's
    /// container), nil when the store does not have it.
    static func savedCopy(of model: Self, in context: ModelContext) throws -> Self?

    /// Every stored property but the key `savedCopy` finds the model by. The schema test
    /// checks that nothing else is left out.
    static var restoredProperties: [RestoredProperty<Self>] { get }
}

/// One stored property that a failed write puts back.
struct RestoredProperty<Model: PersistentModel> {
    /// The property's name in the schema.
    let name: String
    /// The property that `restore` sets. The schema test checks it against the schema's key
    /// path for `name`, so a name and a key path that do not match fail there.
    let keyPath: PartialKeyPath<Model>
    /// Sets the property of the live model (first) to the saved copy's value (second).
    let restore: (Model, Model, AccountStore) -> Void

    /// An attribute: the saved value is set as it is.
    static func attribute<Value>(_ name: String, _ keyPath: ReferenceWritableKeyPath<Model, Value>) -> RestoredProperty {
        RestoredProperty(name: name, keyPath: keyPath) { live, saved, _ in
            live[keyPath: keyPath] = saved[keyPath: keyPath]
        }
    }
}

extension SavedValuesRestorable {
    /// Puts the values the store holds back on this model. A model the store does not have,
    /// or cannot read, is left to `rollback()`.
    ///
    /// A store that cannot be read here should not happen (the same container just answered
    /// the write). If it does, the model is left to the bare `rollback()`, which may keep a
    /// changed attribute in memory; that is said, in debug by an assertion, always in the log.
    func restoreSavedValues(from saved: ModelContext, in store: AccountStore) {
        let copy: Self?
        do {
            copy = try Self.savedCopy(of: self, in: saved)
        } catch {
            writeLogger.fault("A failed write could not read the saved values of a changed model; it was only rolled back.")
            assertionFailure("A failed write could not read the saved values of a changed model; it was only rolled back.")
            return
        }
        guard let copy else {
            return
        }
        for property in Self.restoredProperties {
            property.restore(self, copy, store)
        }
    }
}

extension AccountStore {
    /// Runs `body`, a write that changes models and ends with `save()`. When it throws, every
    /// unsaved change is undone (`discardUnsavedChanges()`), also one made before the throw on
    /// a model that was already saved, and the error is thrown.
    ///
    /// Writes may nest. Inside another write, `body` just runs and its error goes to the
    /// outermost write, which discards once for all of them. An inner write's error caught
    /// inside the outer write does not let the outer one go on as if nothing happened: every
    /// later `save()` of it throws, and at its end it discards and throws
    /// `WriteNestingError.innerWriteFailed`.
    @discardableResult
    func write<Result>(_ body: () throws -> Result) throws -> Result {
        guard writeNesting.depth == 0 else {
            writeNesting.depth += 1
            defer { writeNesting.depth -= 1 }
            do {
                return try body()
            } catch {
                writeNesting.innerWriteFailed = true
                throw error
            }
        }
        writeNesting = WriteNesting(depth: 1, innerWriteFailed: false)
        defer { writeNesting = WriteNesting() }
        let result: Result
        do {
            result = try body()
        } catch {
            discardUnsavedChanges()
            throw error
        }
        if writeNesting.innerWriteFailed {
            writeLogger.error("A write went on after an inner write failed; its changes were discarded.")
            discardUnsavedChanges()
            throw WriteNestingError.innerWriteFailed
        }
        return result
    }

    /// Throws while the outermost write goes on after one of its inner writes failed, so
    /// `save()` stores nothing of it.
    func refuseSaveAfterFailedInnerWrite() throws {
        if writeNesting.innerWriteFailed {
            throw WriteNestingError.innerWriteFailed
        }
    }

    /// Undoes every unsaved change of the context: the changed and deleted models take the
    /// values the store holds for them again, then the context rolls back, which drops the
    /// inserted models and the deletes. Afterwards the context has no changes, so the next
    /// save stores nothing of the failed write.
    func discardUnsavedChanges() {
        let touched = context.changedModelsArray + context.deletedModelsArray
        if !touched.isEmpty {
            let saved = ModelContext(container)
            saved.autosaveEnabled = false
            for model in touched {
                if let restorable = model as? any SavedValuesRestorable {
                    restorable.restoreSavedValues(from: saved, in: self)
                }
            }
        }
        context.rollback()
    }

    /// The live model of the bean with this local id, one deleted in the unsaved changes
    /// included, so a restored relationship can point to it again before the rollback brings
    /// it back.
    fileprivate func liveBean(_ localID: UUID) -> StoredBean? {
        if let deleted = context.deletedModelsArray.lazy.compactMap({ model in model as? StoredBean }).first(where: { bean in bean.localID == localID }) {
            return deleted
        }
        return try? bean(localID: localID)
    }

    /// The live model of the shelf entry with this local id, a deleted one included.
    fileprivate func liveShelfEntry(_ localID: UUID) -> StoredShelfEntry? {
        if let deleted = context.deletedModelsArray.lazy.compactMap({ model in model as? StoredShelfEntry }).first(where: { entry in entry.localID == localID }) {
            return deleted
        }
        return try? shelfEntry(localID: localID)
    }

    /// The live model of the brew with this local id, a deleted one included.
    fileprivate func liveBrew(_ localID: UUID) -> StoredBrew? {
        if let deleted = context.deletedModelsArray.lazy.compactMap({ model in model as? StoredBrew }).first(where: { brew in brew.localID == localID }) {
            return deleted
        }
        return try? brew(localID: localID)
    }
}

// MARK: - The models

// The models are found by `localID` (unique, never changed after insert), the operations by
// `sequence` (never changed after insert; the engine finds them by it too).

extension StoredBean: SavedValuesRestorable {
    static func savedCopy(of model: StoredBean, in context: ModelContext) throws -> StoredBean? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredBean>(predicate: #Predicate<StoredBean> { bean in bean.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredBean>] {
        [
            .attribute("serverID", \.serverID),
            .attribute("vocabularyVersion", \.vocabularyVersion),
            .attribute("syncStateRaw", \.syncStateRaw),
            .attribute("syncIssueRaw", \.syncIssueRaw),
            .attribute("barcode", \.barcode),
            .attribute("verified", \.verified),
            .attribute("openFoodFactsMatch", \.openFoodFactsMatch),
            .attribute("openFoodFactsConfirmed", \.openFoodFactsConfirmed),
            .attribute("hasOpenFoodFactsProduct", \.hasOpenFoodFactsProduct),
            .attribute("openFoodFactsName", \.openFoodFactsName),
            .attribute("openFoodFactsBrand", \.openFoodFactsBrand),
            .attribute("openFoodFactsImageID", \.openFoodFactsImageID),
            .attribute("pickedProcessID", \.pickedProcessID),
            .attribute("pickedRoastLevelID", \.pickedRoastLevelID),
            .attribute("pickedOriginID", \.pickedOriginID),
            .attribute("pickedSpeciesID", \.pickedSpeciesID),
            .attribute("pickedVarietyID", \.pickedVarietyID),
            .attribute("operatorProcessID", \.operatorProcessID),
            .attribute("operatorRoastLevelID", \.operatorRoastLevelID),
            .attribute("operatorOriginID", \.operatorOriginID),
            .attribute("operatorSpeciesID", \.operatorSpeciesID),
            .attribute("operatorVarietyID", \.operatorVarietyID),
            // The inverse of `StoredShelfEntry.bean`: an entry inserted by the failed write
            // leaves it, one it moved away or deleted comes back.
            RestoredProperty(name: "shelfEntries", keyPath: \StoredBean.shelfEntries) { live, saved, store in
                let savedEntryIDs = Set(saved.shelfEntries.map(\.localID))
                guard Set(live.shelfEntries.map(\.localID)) != savedEntryIDs else {
                    return
                }
                live.shelfEntries = savedEntryIDs.compactMap { localID in store.liveShelfEntry(localID) }
            },
        ]
    }
}

extension StoredShelfEntry: SavedValuesRestorable {
    static func savedCopy(of model: StoredShelfEntry, in context: ModelContext) throws -> StoredShelfEntry? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredShelfEntry>(predicate: #Predicate<StoredShelfEntry> { entry in entry.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredShelfEntry>] {
        [
            .attribute("serverID", \.serverID),
            .attribute("vocabularyVersion", \.vocabularyVersion),
            .attribute("syncStateRaw", \.syncStateRaw),
            .attribute("syncIssueRaw", \.syncIssueRaw),
            .attribute("createdAt", \.createdAt),
            .attribute("purchaseDateRaw", \.purchaseDateRaw),
            .attribute("roastDateRaw", \.roastDateRaw),
            .attribute("bagSizeID", \.bagSizeID),
            .attribute("priceBandID", \.priceBandID),
            // The bean: a bean change (D14) is put back, which also puts the entry back into
            // the old bean's `shelfEntries` and out of the new one's.
            RestoredProperty(name: "bean", keyPath: \StoredShelfEntry.bean) { live, saved, store in
                let savedBeanID = saved.bean?.localID
                guard live.bean?.localID != savedBeanID else {
                    return
                }
                live.bean = savedBeanID.flatMap { localID in store.liveBean(localID) }
            },
            // The inverse of `StoredBrew.shelfEntry`: a brew inserted by the failed write leaves
            // it, one it moved away or deleted comes back.
            RestoredProperty(name: "brews", keyPath: \StoredShelfEntry.brews) { live, saved, store in
                let savedBrewIDs = Set(saved.brews.map(\.localID))
                guard Set(live.brews.map(\.localID)) != savedBrewIDs else {
                    return
                }
                live.brews = savedBrewIDs.compactMap { localID in store.liveBrew(localID) }
            },
        ]
    }
}

extension StoredBrew: SavedValuesRestorable {
    static func savedCopy(of model: StoredBrew, in context: ModelContext) throws -> StoredBrew? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredBrew>(predicate: #Predicate<StoredBrew> { brew in brew.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredBrew>] {
        [
            .attribute("serverID", \.serverID),
            .attribute("vocabularyVersion", \.vocabularyVersion),
            .attribute("syncStateRaw", \.syncStateRaw),
            .attribute("syncIssueRaw", \.syncIssueRaw),
            .attribute("brewedAtMilliseconds", \.brewedAtMilliseconds),
            .attribute("methodID", \.methodID),
            .attribute("doseDg", \.doseDg),
            .attribute("waterG", \.waterG),
            .attribute("waterTempC", \.waterTempC),
            .attribute("waterTempSpecialID", \.waterTempSpecialID),
            .attribute("brewTimeS", \.brewTimeS),
            .attribute("grindNormalised", \.grindNormalised),
            .attribute("waterTypeID", \.waterTypeID),
            .attribute("milkID", \.milkID),
            .attribute("ratingData", \.ratingData),
            RestoredProperty(name: "shelfEntry", keyPath: \StoredBrew.shelfEntry) { live, saved, store in
                let savedEntryID = saved.shelfEntry?.localID
                guard live.shelfEntry?.localID != savedEntryID else {
                    return
                }
                live.shelfEntry = savedEntryID.flatMap { localID in store.liveShelfEntry(localID) }
            },
        ]
    }
}

extension StoredRecipe: SavedValuesRestorable {
    static func savedCopy(of model: StoredRecipe, in context: ModelContext) throws -> StoredRecipe? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredRecipe>(predicate: #Predicate<StoredRecipe> { recipe in recipe.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredRecipe>] {
        [
            .attribute("serverID", \.serverID),
            .attribute("vocabularyVersion", \.vocabularyVersion),
            .attribute("syncStateRaw", \.syncStateRaw),
            .attribute("syncIssueRaw", \.syncIssueRaw),
            .attribute("createdAt", \.createdAt),
            .attribute("methodID", \.methodID),
            .attribute("doseDg", \.doseDg),
            .attribute("waterG", \.waterG),
            .attribute("waterTempC", \.waterTempC),
            .attribute("waterTempSpecialID", \.waterTempSpecialID),
            .attribute("brewTimeS", \.brewTimeS),
            .attribute("grindNormalised", \.grindNormalised),
            .attribute("waterTypeID", \.waterTypeID),
            .attribute("milkID", \.milkID),
        ]
    }
}

extension StoredProfile: SavedValuesRestorable {
    static func savedCopy(of model: StoredProfile, in context: ModelContext) throws -> StoredProfile? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredProfile>(predicate: #Predicate<StoredProfile> { profile in profile.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredProfile>] {
        [
            .attribute("vocabularyVersion", \.vocabularyVersion),
            .attribute("syncStateRaw", \.syncStateRaw),
            .attribute("syncIssueRaw", \.syncIssueRaw),
            .attribute("localeID", \.localeID),
            .attribute("contributeToAggregates", \.contributeToAggregates),
        ]
    }
}

extension OutboxOperation: SavedValuesRestorable {
    static func savedCopy(of model: OutboxOperation, in context: ModelContext) throws -> OutboxOperation? {
        let sequence = model.sequence
        let localID = model.localID
        var descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.sequence == sequence && operation.localID == localID }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<OutboxOperation>] {
        [
            .attribute("resourceRaw", \.resourceRaw),
            .attribute("actionRaw", \.actionRaw),
            .attribute("createdAt", \.createdAt),
            .attribute("attemptCount", \.attemptCount),
            .attribute("nextAttemptAt", \.nextAttemptAt),
            .attribute("sentWithoutAnswer", \.sentWithoutAnswer),
            .attribute("sentBody", \.sentBody),
            .attribute("parked", \.parked),
            .attribute("parkReasonRaw", \.parkReasonRaw),
        ]
    }
}

extension QueuedLabelPhoto: SavedValuesRestorable {
    static func savedCopy(of model: QueuedLabelPhoto, in context: ModelContext) throws -> QueuedLabelPhoto? {
        let localID = model.localID
        var descriptor = FetchDescriptor<QueuedLabelPhoto>(predicate: #Predicate<QueuedLabelPhoto> { photo in photo.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<QueuedLabelPhoto>] {
        [
            .attribute("beanLocalID", \.beanLocalID),
            .attribute("fileName", \.fileName),
            .attribute("createdAt", \.createdAt),
            .attribute("jobData", \.jobData),
            .attribute("attemptCount", \.attemptCount),
            .attribute("nextAttemptAt", \.nextAttemptAt),
        ]
    }
}
