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

/// What a restored property is. Relationships are checked again after the rollback.
enum RestoredPropertyKind {
    case attribute
    /// A to-one relationship (a shelf entry's bean, a brew's shelf entry).
    case toOne
    /// A to-many relationship, the inverse of a to-one.
    case toMany
}

/// What putting one property back did.
enum RestoreOutcome: Hashable {
    /// It already held the saved value.
    case unchanged
    /// It was set to the saved value.
    case changed
    /// The saved value names a model the live context could not give (not found, or the read
    /// failed). The property is left as it is, never set to nil in its place.
    case unresolved
}

/// One stored property that a failed write puts back.
struct RestoredProperty<Model: PersistentModel> {
    /// The property's name in the schema.
    let name: String
    /// The property that `restore` sets. The schema test checks that no key path is listed
    /// twice (SwiftData does not make the schema's key paths public).
    let keyPath: PartialKeyPath<Model>
    let kind: RestoredPropertyKind
    /// Sets the property of the live model (first) to the saved copy's value (second), and
    /// says whether it had to. Setting it again once it holds the saved value changes nothing
    /// (idempotent), so it may run before and after the rollback.
    let restore: (Model, Model, AccountStore) -> RestoreOutcome

    /// An attribute: the saved value is set as it is.
    static func attribute<Value>(_ name: String, _ keyPath: ReferenceWritableKeyPath<Model, Value>) -> RestoredProperty {
        RestoredProperty(name: name, keyPath: keyPath, kind: .attribute) { live, saved, _ in
            live[keyPath: keyPath] = saved[keyPath: keyPath]
            return .changed
        }
    }

    /// A to-one relationship, compared by the target's local id. The saved target is resolved
    /// in the live context (`resolve`, given the saved copy's target). When it cannot be, the
    /// relationship is left as it is (`unresolved`): a saved target is never replaced by nil.
    static func toOne<Target: PersistentModel>(
        _ name: String,
        _ keyPath: ReferenceWritableKeyPath<Model, Target?>,
        id: KeyPath<Target, UUID>,
        resolve: @escaping (AccountStore, Target) -> Target?
    ) -> RestoredProperty {
        RestoredProperty(name: name, keyPath: keyPath, kind: .toOne) { live, saved, store in
            let current = live[keyPath: keyPath]
            guard let savedTarget = saved[keyPath: keyPath] else {
                guard current != nil else {
                    return .unchanged
                }
                live[keyPath: keyPath] = nil
                return .changed
            }
            if let current, current[keyPath: id] == savedTarget[keyPath: id] {
                return .unchanged
            }
            guard let target = resolve(store, savedTarget) else {
                return .unresolved
            }
            live[keyPath: keyPath] = target
            return .changed
        }
    }

    /// A to-many relationship. It holds the saved targets exactly once each, or it is set to
    /// them: never appended to, so a target the live list holds twice (seen after a failed
    /// `ModelContext.save()`, ADR 0025 Addendum M2-T36) is listed once again. If any saved
    /// target cannot be resolved, the list is left as it is (`unresolved`), not cut short.
    static func toMany<Target: PersistentModel>(
        _ name: String,
        _ keyPath: ReferenceWritableKeyPath<Model, [Target]>,
        id: KeyPath<Target, UUID>,
        resolve: @escaping (AccountStore, Target) -> Target?
    ) -> RestoredProperty {
        RestoredProperty(name: name, keyPath: keyPath, kind: .toMany) { live, saved, store in
            let savedTargets = saved[keyPath: keyPath]
            let savedIDs = Set(savedTargets.map { target in target[keyPath: id] })
            let liveIDs = live[keyPath: keyPath].map { target in target[keyPath: id] }
            guard liveIDs.count != savedIDs.count || Set(liveIDs) != savedIDs else {
                return .unchanged
            }
            var targets: [Target] = []
            var seen = Set<UUID>()
            for savedTarget in savedTargets where seen.insert(savedTarget[keyPath: id]).inserted {
                guard let target = resolve(store, savedTarget) else {
                    return .unresolved
                }
                targets.append(target)
            }
            live[keyPath: keyPath] = targets
            return .changed
        }
    }
}

/// What `discardUnsavedChanges()` still does, after the rollback, for one model the store has.
struct SavedValuesRestore {
    /// Puts the relationships of one kind back again and says what that did.
    let restoreAgain: (RestoredPropertyKind) -> Set<RestoreOutcome>
    /// Whether the fetch the app uses (by `localID`, operations by `sequence`) finds the model
    /// in the live context: true or false, nil when the fetch failed.
    let isFoundAgain: () -> Bool?
}

extension SavedValuesRestorable {
    /// Puts the values the store holds back on this model. A model the store does not have,
    /// or cannot read, is left to `rollback()`.
    ///
    /// A store that cannot be read here should not happen (the same container just answered
    /// the write). If it does, the model is left to the bare `rollback()`, which may keep a
    /// changed attribute in memory; that is said, in debug by an assertion, always in the log.
    ///
    /// Returns what is still done for the model after the rollback, nil when the store does
    /// not have it (nothing to put back).
    func restoreSavedValues(from saved: ModelContext, in store: AccountStore) -> SavedValuesRestore? {
        let copy: Self?
        do {
            copy = try Self.savedCopy(of: self, in: saved)
        } catch {
            writeLogger.fault("A failed write could not read the saved values of a changed model; it was only rolled back.")
            assertionFailure("A failed write could not read the saved values of a changed model; it was only rolled back.")
            return nil
        }
        guard let copy else {
            return nil
        }
        // Attributes first, then the to-one relationships (their inverses follow), then the
        // to-many ones, which then only change what the to-one ones left wrong.
        for kind in [RestoredPropertyKind.attribute, .toOne, .toMany] {
            for property in Self.restoredProperties where property.kind == kind {
                _ = property.restore(self, copy, store)
            }
        }
        return SavedValuesRestore(
            restoreAgain: { kind in
                var outcomes = Set<RestoreOutcome>()
                for property in Self.restoredProperties where property.kind == kind {
                    outcomes.insert(property.restore(self, copy, store))
                }
                return outcomes
            },
            isFoundAgain: {
                // The same fetch as `savedCopy`, through the live context: what the screens
                // and the engine do when they read the model again by its key.
                do {
                    return try Self.savedCopy(of: self, in: store.context) != nil
                } catch {
                    return nil
                }
            }
        )
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
    /// inserted models and the deletes, and then the relationships are checked against the
    /// store once more and set where they differ.
    ///
    /// Why the second pass (M2-T36, ADR 0025 Addendum M2-T36): when `ModelContext.save()` itself
    /// fails, the save has already applied the delete rules (nullify) to the deleted models,
    /// and a rollback of two deleted models that point to each other (a shelf entry and the
    /// pending bean it leaves) brought them back with the entry's `bean` nil and the entry twice
    /// in the bean's `shelfEntries`. So what the rollback leaves is not trusted: each restore is
    /// idempotent (it compares with the saved value and assigns the exact saved targets, never
    /// appends), the to-one relationships are set first and the to-many ones after, and the
    /// pass repeats until nothing changes. A relationship set again here holds the store's
    /// value, so a later save stores nothing of the failed write.
    ///
    /// Why the pending changes are processed and every model is fetched again (ADR 0025
    /// Addendum M2-T36): after a real failed save and that repair, the first fetch of the
    /// pending bean by its `localID` found nothing, although the store has it, the held
    /// instances were right and the same fetch a moment later found it. So the context is not
    /// handed back until its pending changes are processed and every model the store has is
    /// found again by the fetch the app uses (a model the first round misses is fetched a
    /// second time, after that round, before the miss counts).
    func discardUnsavedChanges() {
        let touched = context.changedModelsArray + context.deletedModelsArray
        guard !touched.isEmpty else {
            context.rollback()
            return
        }
        let saved = ModelContext(container)
        saved.autosaveEnabled = false
        var restores: [SavedValuesRestore] = []
        for model in touched {
            if let restorable = model as? any SavedValuesRestorable,
               let restore = restorable.restoreSavedValues(from: saved, in: self) {
                restores.append(restore)
            }
        }
        context.rollback()
        // The saved copies are read through `saved`, which must live until the last pass.
        withExtendedLifetime(saved) {
            var settled = false
            var repaired = false
            var unresolved = false
            for _ in 0..<AccountStore.relationshipPasses where !settled {
                var outcomes = Set<RestoreOutcome>()
                for kind in [RestoredPropertyKind.toOne, .toMany] {
                    for restore in restores {
                        outcomes.formUnion(restore.restoreAgain(kind))
                    }
                }
                // Inverses and the context's own bookkeeping follow the sets now, not at the
                // next fetch, so the next pass and the checks below see the settled state.
                context.processPendingChanges()
                let changed = outcomes.contains(.changed)
                unresolved = outcomes.contains(.unresolved)
                repaired = repaired || changed
                settled = !changed
            }
            if !settled || unresolved {
                // A relationship differs from the store and could not be set: the next save
                // might store it. Should not happen; said loudly in debug, always in the log.
                writeLogger.fault("A failed write could not put every relationship back after the rollback.")
                assertionFailure("A failed write could not put every relationship back after the rollback.")
            } else if repaired {
                writeLogger.notice("A failed write put relationships back after the rollback.")
            }
            confirmFoundAgain(restores)
        }
    }

    /// Fetches every restored model again through the live context. The models the first
    /// round misses are fetched again after it (the CI log suggests a later fetch finds them; the cause is not known)
    /// a model still missed, or a fetch that fails, would hide a model the store has
    /// from the screens and the engine. Should not happen; said loudly in debug, always in
    /// the log.
    private func confirmFoundAgain(_ restores: [SavedValuesRestore]) {
        let missed = restores.filter { restore in restore.isFoundAgain() != true }
        guard !missed.isEmpty else {
            return
        }
        context.processPendingChanges()
        let stillMissed = missed.filter { restore in restore.isFoundAgain() != true }
        guard stillMissed.isEmpty else {
            writeLogger.fault("A failed write left a saved model that a fetch does not find.")
            assertionFailure("A failed write left a saved model that a fetch does not find.")
            return
        }
        writeLogger.notice("A failed write's saved models were found on a second fetch.")
    }

    /// How often the relationships are checked after a rollback before giving up: one pass
    /// that sets them, one that finds them right, and one more in case a set changed an inverse.
    private static let relationshipPasses = 3

    /// The live model that `saved` (a model of the fresh context on the store) is, so a
    /// restored relationship can point to it: first one deleted in the unsaved changes (before
    /// the rollback brings it back), then one the context has registered under the same
    /// identifier, then a fetch by local id. A failed fetch is not taken for "gone": it is
    /// logged and answers nil, which the restore treats as `unresolved` and leaves the
    /// relationship as it is.
    fileprivate func liveModel<Target: PersistentModel>(
        matching saved: Target,
        id: KeyPath<Target, UUID>,
        fetch: (UUID) throws -> Target?
    ) -> Target? {
        let localID = saved[keyPath: id]
        let deleted = context.deletedModelsArray.lazy
            .compactMap { model in model as? Target }
            .first { model in model[keyPath: id] == localID }
        if let deleted {
            return deleted
        }
        if let registered: Target = context.registeredModel(for: saved.persistentModelID), registered[keyPath: id] == localID {
            return registered
        }
        do {
            return try fetch(localID)
        } catch {
            writeLogger.fault("A failed write could not read a related model; the relationship was left as it is.")
            return nil
        }
    }

    fileprivate func liveBean(_ saved: StoredBean) -> StoredBean? {
        liveModel(matching: saved, id: \StoredBean.localID) { localID in try bean(localID: localID) }
    }

    fileprivate func liveShelfEntry(_ saved: StoredShelfEntry) -> StoredShelfEntry? {
        liveModel(matching: saved, id: \StoredShelfEntry.localID) { localID in try shelfEntry(localID: localID) }
    }

    fileprivate func liveBrew(_ saved: StoredBrew) -> StoredBrew? {
        liveModel(matching: saved, id: \StoredBrew.localID) { localID in try brew(localID: localID) }
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
            .toMany("shelfEntries", \.shelfEntries, id: \StoredShelfEntry.localID) { store, saved in store.liveShelfEntry(saved) },
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
            .toOne("bean", \.bean, id: \StoredBean.localID) { store, saved in store.liveBean(saved) },
            // The inverse of `StoredBrew.shelfEntry`: a brew inserted by the failed write leaves
            // it, one it moved away or deleted comes back.
            .toMany("brews", \.brews, id: \StoredBrew.localID) { store, saved in store.liveBrew(saved) },
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
            .toOne("shelfEntry", \.shelfEntry, id: \StoredShelfEntry.localID) { store, saved in store.liveShelfEntry(saved) },
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
