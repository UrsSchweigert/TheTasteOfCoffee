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
//
// What a discard cannot put back (M2-T37): every such case is a `DiscardFault`, logged with a
// fixed message and passed to `AccountStore.onDiscardFault` (an `assertionFailure` in the app,
// a recorder in tests). A fault that may leave a value the store does not have in the context
// (an unreadable saved copy, a relationship that is unresolved or does not settle) also makes
// the store refuse every later save, until a new `AccountStore` reads the file again.

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

/// What a failed write's discard (`discardUnsavedChanges()`) could not do. None of these
/// should happen; each is logged with a fixed message and passed to
/// `AccountStore.onDiscardFault` (an `assertionFailure` in the app, ADR 0025 Addendum M2-T37).
enum DiscardFault: Hashable, CaseIterable {
    /// The saved values of a changed model could not be read: it was only rolled back, which
    /// may keep a changed attribute in memory.
    case savedValuesUnreadable
    /// The passes after the rollback (attributes and relationships) still changed something
    /// in their last pass.
    case relationshipsNotSettled
    /// A saved relationship target could not be found in the live context: the relationship
    /// was left as the failed save left it (for example nil, set by a delete rule).
    case relationshipUnresolved
    /// A model the store has was not found again by the app's fetch after the discard.
    case savedModelNotFound

    /// Whether the context may still hold, as a change or in memory, a value the store does
    /// not have. Then the store refuses every later save until it is opened again.
    var leavesUnsavedState: Bool {
        switch self {
        case .savedValuesUnreadable, .relationshipsNotSettled, .relationshipUnresolved: return true
        case .savedModelNotFound: return false
        }
    }

    /// The fixed text of the debug assertion (no ids, no values).
    var assertionMessage: String {
        switch self {
        case .savedValuesUnreadable: return "A failed write could not read the saved values of a changed model; it was only rolled back."
        case .relationshipsNotSettled: return "A failed write's relationship passes did not settle after the rollback."
        case .relationshipUnresolved: return "A failed write could not resolve a saved relationship target after the rollback."
        case .savedModelNotFound: return "A failed write left a saved model that a fetch does not find."
        }
    }
}

/// Thrown by `save()` once a discard left the context with values the store does not have.
enum DiscardError: Error, Equatable {
    /// The store must be opened again (the app's next start, or the next sign-in) before it
    /// saves anything: the next save could otherwise store what the failed write left.
    case storeNeedsReopening
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
    /// Whether the live model (first) holds the saved copy's value (second). Reads only: an
    /// attribute by `==`, a to-one by the target's local id, a to-many as the exact saved set,
    /// each target once. `restore` answers `unchanged` exactly when this is true.
    let holdsSavedValue: (Model, Model) -> Bool
    /// Sets the property of the live model (first) to the saved copy's value (second), and
    /// says whether it had to. Setting it again once it holds the saved value changes nothing
    /// (idempotent), so it may run before and after the rollback.
    let restore: (Model, Model, AccountStore) -> RestoreOutcome

    /// An attribute. It is compared with the saved value first (every stored attribute type is
    /// `Equatable`; one that is not does not compile here) and set only when it differs, so
    /// the outcome says whether anything changed (M2-T37).
    static func attribute<Value: Equatable>(_ name: String, _ keyPath: ReferenceWritableKeyPath<Model, Value>) -> RestoredProperty {
        RestoredProperty(
            name: name,
            keyPath: keyPath,
            kind: .attribute,
            holdsSavedValue: { live, saved in live[keyPath: keyPath] == saved[keyPath: keyPath] },
            restore: { live, saved, _ in
                let value = saved[keyPath: keyPath]
                guard live[keyPath: keyPath] != value else {
                    return .unchanged
                }
                live[keyPath: keyPath] = value
                return .changed
            }
        )
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
        let holdsSavedValue: (Model, Model) -> Bool = { live, saved in
            live[keyPath: keyPath]?[keyPath: id] == saved[keyPath: keyPath]?[keyPath: id]
        }
        return RestoredProperty(
            name: name,
            keyPath: keyPath,
            kind: .toOne,
            holdsSavedValue: holdsSavedValue,
            restore: { live, saved, store in
                if holdsSavedValue(live, saved) {
                    return .unchanged
                }
                guard let savedTarget = saved[keyPath: keyPath] else {
                    live[keyPath: keyPath] = nil
                    return .changed
                }
                guard let target = resolve(store, savedTarget) else {
                    return .unresolved
                }
                live[keyPath: keyPath] = target
                return .changed
            }
        )
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
        let holdsSavedValue: (Model, Model) -> Bool = { live, saved in
            let savedIDs = Set(saved[keyPath: keyPath].map { target in target[keyPath: id] })
            let liveIDs = live[keyPath: keyPath].map { target in target[keyPath: id] }
            return liveIDs.count == savedIDs.count && Set(liveIDs) == savedIDs
        }
        return RestoredProperty(
            name: name,
            keyPath: keyPath,
            kind: .toMany,
            holdsSavedValue: holdsSavedValue,
            restore: { live, saved, store in
                if holdsSavedValue(live, saved) {
                    return .unchanged
                }
                return RestoredProperty.restoreToMany(live, saved, store, keyPath: keyPath, id: id, resolve: resolve)
            }
        )
    }

    /// Sets a to-many relationship that differs from the saved one to the saved targets.
    private static func restoreToMany<Target: PersistentModel>(
        _ live: Model,
        _ saved: Model,
        _ store: AccountStore,
        keyPath: ReferenceWritableKeyPath<Model, [Target]>,
        id: KeyPath<Target, UUID>,
        resolve: (AccountStore, Target) -> Target?
    ) -> RestoreOutcome {
        var targets: [Target] = []
        var seen = Set<UUID>()
        for savedTarget in saved[keyPath: keyPath] where seen.insert(savedTarget[keyPath: id]).inserted {
            guard let target = resolve(store, savedTarget) else {
                return .unresolved
            }
            targets.append(target)
        }
        live[keyPath: keyPath] = targets
        return .changed
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
    /// changed attribute in memory; that is reported (`DiscardFault.savedValuesUnreadable`),
    /// and the store refuses later saves until it is opened again.
    ///
    /// Returns what is still done for the model after the rollback, nil when the store does
    /// not have it (nothing to put back).
    func restoreSavedValues(from saved: ModelContext, in store: AccountStore) -> SavedValuesRestore? {
        let copy: Self?
        do {
            copy = try Self.savedCopy(of: self, in: saved)
        } catch {
            store.reportDiscardFault(.savedValuesUnreadable)
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

    /// The names of the restored properties whose value differs from the store's, read
    /// through `saved` (a fresh context on the store's container); nil when the store does not
    /// have the model. Changes nothing. The tests use it to check that what a discard leaves
    /// as a change of the context equals the disk.
    func propertiesDifferingFromSaved(in saved: ModelContext) throws -> [String]? {
        guard let copy = try Self.savedCopy(of: self, in: saved) else {
            return nil
        }
        return Self.restoredProperties
            .filter { property in !property.holdsSavedValue(self, copy) }
            .map(\.name)
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

    /// Throws once a discard left the context with values the store does not have
    /// (`DiscardFault.leavesUnsavedState`), so `save()` stores none of them. Only a new
    /// `AccountStore` on the file (the app's next start, the next sign-in) saves again: its
    /// context reads everything from the disk (ADR 0025 Addendum M2-T37).
    func refuseSaveWhileNeedsReopening() throws {
        if needsReopening {
            throw DiscardError.storeNeedsReopening
        }
    }

    /// Logs `fault` with its fixed message, makes the store refuse later saves when the fault
    /// may leave unsaved state behind, then calls `onDiscardFault` (an `assertionFailure` in
    /// the app; a test records it instead).
    func reportDiscardFault(_ fault: DiscardFault) {
        switch fault {
        case .savedValuesUnreadable:
            writeLogger.fault("A failed write could not read the saved values of a changed model; it was only rolled back.")
        case .relationshipsNotSettled:
            writeLogger.fault("A failed write's relationship passes did not settle after the rollback.")
        case .relationshipUnresolved:
            writeLogger.fault("A failed write could not resolve a saved relationship target after the rollback.")
        case .savedModelNotFound:
            writeLogger.fault("A failed write left a saved model that a fetch does not find.")
        }
        if fault.leavesUnsavedState {
            if !needsReopening {
                writeLogger.fault("The store refuses every save until it is opened again.")
            }
            needsReopening = true
        }
        onDiscardFault(fault)
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
    ///
    /// What could not be put back is reported (`reportDiscardFault`); a relationship left as
    /// the failed save set it makes the store refuse later saves (ADR 0025 Addendum M2-T37).
    ///
    /// Why attributes are checked after the rollback too, and `pending` (M2-T37): after a real
    /// failed `ModelContext.save()` of an attribute change (the engine's `markSending` on a
    /// store that refuses the write), the discard left `attemptCount` and `sentWithoutAnswer`
    /// at the failed write's values. Attributes were only put back before the rollback, and the
    /// changed models were only read from the context after the failed save had processed the
    /// changes. Which of the two SwiftData steps lost the value (the rollback reverting to the
    /// processed values, or the context no longer listing the model) was not observable from
    /// Linux; checking every kind of property after the rollback, on the models listed before
    /// the save as well, covers both. `pending` is what `save()` listed before it called
    /// `ModelContext.save()`.
    func discardUnsavedChanges(alsoChecking pending: [any PersistentModel] = []) {
        var seen = Set<ObjectIdentifier>()
        let touched = (pending + context.changedModelsArray + context.deletedModelsArray).filter { model in
            seen.insert(ObjectIdentifier(model)).inserted
        }
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
            _ = repairAfterRollback(restores)
        }
    }

    /// What the relationship passes after a rollback ended with.
    struct RelationshipRepair: Equatable {
        /// The last pass changed nothing.
        var settled = false
        /// Some pass set a property (an attribute or a relationship).
        var repaired = false
        /// The last pass found a saved target it could not resolve.
        var unresolved = false
    }

    /// The part of `discardUnsavedChanges()` after the rollback: the relationship passes, then
    /// the fetch of every restored model. Separate so that a test can run it on restores that
    /// never settle or never resolve, which a real store cannot be made to do on purpose.
    @discardableResult
    func repairAfterRollback(_ restores: [SavedValuesRestore]) -> RelationshipRepair {
        var repair = RelationshipRepair()
        for _ in 0..<AccountStore.relationshipPasses where !repair.settled {
            var outcomes = Set<RestoreOutcome>()
            // Attributes too: after a failed save in the store, the rollback does not leave
            // them at the values put back before it (see `discardUnsavedChanges`).
            for kind in [RestoredPropertyKind.attribute, .toOne, .toMany] {
                for restore in restores {
                    outcomes.formUnion(restore.restoreAgain(kind))
                }
            }
            // Inverses and the context's own bookkeeping follow the sets now, not at the
            // next fetch, so the next pass and the checks below see the settled state.
            context.processPendingChanges()
            let changed = outcomes.contains(.changed)
            repair.unresolved = outcomes.contains(.unresolved)
            repair.repaired = repair.repaired || changed
            repair.settled = !changed
        }
        // A relationship that differs from the store and could not be set would be stored by
        // the next save, so these reports make the store refuse saves.
        if repair.unresolved {
            reportDiscardFault(.relationshipUnresolved)
        }
        if !repair.settled {
            reportDiscardFault(.relationshipsNotSettled)
        }
        if repair.repaired, repair.settled, !repair.unresolved {
            writeLogger.notice("A failed write put saved values back after the rollback.")
        }
        confirmFoundAgain(restores)
        return repair
    }

    /// Fetches every restored model again through the live context. The models the first
    /// round misses are fetched again after it (the CI log showed that a later fetch finds
    /// them; the cause is not known). A model still missed, or a fetch that fails, would hide
    /// a model the store has from the screens and the engine: that is reported
    /// (`DiscardFault.savedModelNotFound`).
    private func confirmFoundAgain(_ restores: [SavedValuesRestore]) {
        let missed = restores.filter { restore in restore.isFoundAgain() != true }
        guard !missed.isEmpty else {
            return
        }
        context.processPendingChanges()
        let stillMissed = missed.filter { restore in restore.isFoundAgain() != true }
        guard stillMissed.isEmpty else {
            reportDiscardFault(.savedModelNotFound)
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
            .attribute("grinderID", \.grinderID),
            .attribute("grindSetting", \.grindSetting),
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
            .attribute("grinderID", \.grinderID),
            .attribute("grindSetting", \.grindSetting),
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
