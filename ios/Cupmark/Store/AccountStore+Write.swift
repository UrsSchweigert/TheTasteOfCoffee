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
        case .relationshipsNotSettled: return "A failed write's restore passes (attributes and relationships) did not settle after the rollback."
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

    /// `savedCopy` of each of `models`, in their order. A default runs one fetch per model;
    /// the busy types run one fetch for all (M2-T37).
    static func savedCopies(of models: [Self], in context: ModelContext) throws -> [Self?]

    /// The saved values of the models of `models` that are of this type, by live model. A
    /// requirement, so `capturePendingSave` can call it on a model's dynamic type.
    static func captureSavedValues(of models: [any PersistentModel], from saved: ModelContext) throws -> [ObjectIdentifier: SavedValuesCapture]

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

/// The saved value of one property, taken from a saved copy at one moment, and what compares
/// and sets it on the live model later. It holds the value itself (and, for a relationship, the
/// saved targets), so a later read of the store cannot change it (ADR 0025 Addendum M2-T37).
struct SavedValue<Model: PersistentModel> {
    /// Whether the live model holds the captured value: an attribute by `==`, a to-one by the
    /// target's local id, a to-many as the exact saved set, each target once.
    let holds: (Model) -> Bool
    /// Sets the live model's property to the captured value where it differs, and says
    /// whether it had to. Idempotent, so it may run before and after the rollback.
    let restore: (Model, AccountStore) -> RestoreOutcome
}

/// One stored property that a failed write puts back.
struct RestoredProperty<Model: PersistentModel> {
    /// The property's name in the schema.
    let name: String
    /// The property that `restore` sets. The schema test checks that no key path is listed
    /// twice (SwiftData does not make the schema's key paths public).
    let keyPath: PartialKeyPath<Model>
    let kind: RestoredPropertyKind
    /// Reads the saved copy's value now, and gives what compares and sets it later.
    let capture: (Model) -> SavedValue<Model>

    /// Whether the live model (first) holds the saved copy's value (second). Reads only.
    func holdsSavedValue(_ live: Model, _ saved: Model) -> Bool {
        capture(saved).holds(live)
    }

    /// Sets the property of the live model (first) to the saved copy's value (second), and
    /// says whether it had to.
    func restore(_ live: Model, _ saved: Model, _ store: AccountStore) -> RestoreOutcome {
        capture(saved).restore(live, store)
    }

    /// An attribute. It is compared with the saved value first (every stored attribute type is
    /// `Equatable`; one that is not does not compile here) and set only when it differs, so
    /// the outcome says whether anything changed (M2-T37).
    static func attribute<Value: Equatable>(_ name: String, _ keyPath: ReferenceWritableKeyPath<Model, Value>) -> RestoredProperty {
        RestoredProperty(name: name, keyPath: keyPath, kind: .attribute) { saved in
            let value = saved[keyPath: keyPath]
            return SavedValue(
                holds: { live in live[keyPath: keyPath] == value },
                restore: { live, _ in
                    guard live[keyPath: keyPath] != value else {
                        return .unchanged
                    }
                    live[keyPath: keyPath] = value
                    return .changed
                }
            )
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
        RestoredProperty(name: name, keyPath: keyPath, kind: .toOne) { saved in
            let savedTarget = saved[keyPath: keyPath]
            let savedID = savedTarget?[keyPath: id]
            return SavedValue(
                holds: { live in live[keyPath: keyPath]?[keyPath: id] == savedID },
                restore: { live, store in
                    if live[keyPath: keyPath]?[keyPath: id] == savedID {
                        return .unchanged
                    }
                    guard let savedTarget else {
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
        RestoredProperty(name: name, keyPath: keyPath, kind: .toMany) { saved in
            let savedTargets = saved[keyPath: keyPath]
            let savedIDs = Set(savedTargets.map { target in target[keyPath: id] })
            var seen = Set<UUID>()
            let uniqueTargets = savedTargets.filter { target in seen.insert(target[keyPath: id]).inserted }
            let holds: (Model) -> Bool = { live in
                let liveIDs = live[keyPath: keyPath].map { target in target[keyPath: id] }
                return liveIDs.count == savedIDs.count && Set(liveIDs) == savedIDs
            }
            return SavedValue(
                holds: holds,
                restore: { live, store in
                    if holds(live) {
                        return .unchanged
                    }
                    var targets: [Target] = []
                    for savedTarget in uniqueTargets {
                        guard let target = resolve(store, savedTarget) else {
                            return .unresolved
                        }
                        targets.append(target)
                    }
                    live[keyPath: keyPath] = targets
                    return .changed
                }
            )
        }
    }
}

/// What `discardUnsavedChanges()` still does, after the rollback, for one model the store has.
struct SavedValuesRestore {
    /// Puts the properties of one kind back again and says what that did.
    let restoreAgain: (RestoredPropertyKind) -> Set<RestoreOutcome>
    /// Whether the fetch the app uses (by `localID`, operations by `sequence`) finds the model
    /// in the live context: true or false, nil when the fetch failed.
    let isFoundAgain: () -> Bool?
}

/// The saved values of one live model, captured at one moment: before a `ModelContext.save()`
/// (`AccountStore.save()`), or at the discard when no earlier capture is held.
struct SavedValuesCapture {
    /// The live model the values are for.
    let model: any PersistentModel
    /// The model's type, for `DiscardReport` (no ids, no values).
    let typeName: String
    /// Sets the properties of one kind to the captured values and says what that did.
    let restore: (RestoredPropertyKind, AccountStore) -> Set<RestoreOutcome>
    /// The names of the properties whose live value differs from the captured one.
    let differing: () -> [String]
    /// Whether the app's fetch finds the model in the live context; nil when the fetch fails.
    let isFoundAgain: (AccountStore) -> Bool?
    /// The context the saved copy was read through. Kept with the capture, so a saved
    /// relationship target can still be read when it is resolved.
    let source: ModelContext
}

/// What one discard saw and did. Read by tests (`AccountStore.lastDiscardReport`) so that a
/// failure says why; never logged, and it holds no ids and no values (ADR 0025 Addendum
/// M2-T37).
struct DiscardReport: CustomStringConvertible {
    /// Where the saved values of a model came from.
    enum Source: String {
        case capturedBeforeTheSave = "captured before a failed save"
        case readAtTheDiscard = "read at the discard"
        case notOnDisk = "not on disk"
        case unreadable = "unreadable"
    }

    struct Entry {
        let typeName: String
        let source: Source
        /// The properties that differed from the saved values when the discard began.
        let differingBefore: [String]
        /// The properties that still differ when it ends.
        var differingAfter: [String]
    }

    /// What the context listed when the discard began.
    var changedModels = 0
    var deletedModels = 0
    /// The captures of failed saves the store held when the discard began.
    var heldCaptures = 0
    var entries: [Entry] = []
    var repair: AccountStore.RelationshipRepair?

    var description: String {
        let models = entries.map { entry in
            "\(entry.typeName) (\(entry.source.rawValue)): differed \(entry.differingBefore), still differs \(entry.differingAfter)"
        }
        let repairText = repair.map { repair in "\(repair)" } ?? "none"
        return "changed \(changedModels), deleted \(deletedModels), captures held \(heldCaptures), repair \(repairText); "
            + models.joined(separator: "; ")
    }
}

/// The models one `save()` hands to `ModelContext.save()`, and the saved values captured for
/// them just before.
struct PendingSave {
    var models = Set<ObjectIdentifier>()
    var captures: [ObjectIdentifier: SavedValuesCapture] = [:]
}

extension SavedValuesRestorable {
    /// One `savedCopy` per model. The models the Puller saves by the hundred override it with
    /// one fetch per call (`savedCopies` below in this file).
    static func savedCopies(of models: [Self], in context: ModelContext) throws -> [Self?] {
        try models.map { model in try savedCopy(of: model, in: context) }
    }

    /// The saved values of every model of `models` that is of this type and that the store
    /// has, read through `saved` with one `savedCopies` call, by live model.
    static func captureSavedValues(of models: [any PersistentModel], from saved: ModelContext) throws -> [ObjectIdentifier: SavedValuesCapture] {
        let typed = models.compactMap { model in model as? Self }
        let copies = try savedCopies(of: typed, in: saved)
        var captures: [ObjectIdentifier: SavedValuesCapture] = [:]
        for (model, copy) in zip(typed, copies) {
            if let copy {
                captures[ObjectIdentifier(model)] = model.captureSavedValues(copy: copy, source: saved)
            }
        }
        return captures
    }

    /// The saved values of this model, read now through `saved` (a fresh context on the
    /// store's container), nil when the store does not have it. Throws when it cannot be read.
    func captureSavedValues(from saved: ModelContext) throws -> SavedValuesCapture? {
        guard let copy = try Self.savedCopy(of: self, in: saved) else {
            return nil
        }
        return captureSavedValues(copy: copy, source: saved)
    }

    /// The saved values of this model as `copy` (read through `source`) holds them.
    func captureSavedValues(copy: Self, source saved: ModelContext) -> SavedValuesCapture {
        let values = Self.restoredProperties.map { property in
            (name: property.name, kind: property.kind, value: property.capture(copy))
        }
        return SavedValuesCapture(
            model: self,
            typeName: String(describing: Self.self),
            restore: { kind, store in
                var outcomes = Set<RestoreOutcome>()
                for entry in values where entry.kind == kind {
                    outcomes.insert(entry.value.restore(self, store))
                }
                return outcomes
            },
            differing: {
                values.filter { entry in !entry.value.holds(self) }.map { entry in entry.name }
            },
            isFoundAgain: { store in
                // The same fetch as `savedCopy`, through the live context: what the screens
                // and the engine do when they read the model again by its key.
                do {
                    return try Self.savedCopy(of: self, in: store.context) != nil
                } catch {
                    return nil
                }
            },
            source: saved
        )
    }

    /// The names of the restored properties whose value differs from the store's, read
    /// through `saved` (a fresh context on the store's container); nil when the store does not
    /// have the model. Changes nothing. The tests use it to check that what a discard leaves
    /// as a change of the context equals the disk.
    func propertiesDifferingFromSaved(in saved: ModelContext) throws -> [String]? {
        try captureSavedValues(from: saved)?.differing()
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
            writeLogger.fault("A failed write's restore passes (attributes and relationships) did not settle after the rollback.")
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

    // MARK: Captures around a save (M2-T37)

    /// Called by `save()` right before `ModelContext.save()`: lists the changed and deleted
    /// models and reads their saved values through a fresh context, while the store still
    /// answers with what is on disk. A model with a capture held from an earlier failed save
    /// keeps that one (nothing of it was saved since, so it is still the disk's).
    ///
    /// Why (ADR 0025 Addendum M2-T37): after a `ModelContext.save()` that failed in the store,
    /// a discard that read the saved values only then left an outbox operation's
    /// `attemptCount` and `sentWithoutAnswer` at the failed write's values, also with the
    /// attributes checked again after the rollback and with the models listed before the save.
    /// What a fresh context answers once such a save failed is therefore not trusted.
    ///
    /// The pending changes are processed first, so the models the save writes on the side
    /// are listed and captured too: the inverse of a relationship set (a bean's
    /// `shelfEntries` when an entry's `bean` is set) and the models the delete rules change
    /// (nullify). The cost on the success path is one fresh context and one fetch per model
    /// type of the save (`savedCopies`), linear in the number of models.
    func capturePendingSave() -> PendingSave {
        context.processPendingChanges()
        let pending = context.changedModelsArray + context.deletedModelsArray
        guard !pending.isEmpty else {
            return PendingSave()
        }
        let saved = ModelContext(container)
        saved.autosaveEnabled = false
        var result = PendingSave()
        var groups: [ObjectIdentifier: (type: any SavedValuesRestorable.Type, models: [any PersistentModel])] = [:]
        for model in pending {
            let key = ObjectIdentifier(model)
            result.models.insert(key)
            guard failedSaveCaptures[key] == nil, let restorable = model as? any SavedValuesRestorable else {
                continue
            }
            let modelType = type(of: restorable)
            groups[ObjectIdentifier(modelType), default: (modelType, [])].models.append(model)
        }
        for group in groups.values {
            do {
                result.captures.merge(try group.type.captureSavedValues(of: group.models, from: saved)) { first, _ in first }
            } catch {
                // If the save fails, the discard reads these models after the failure, which
                // may give the failed write's values (see above).
                writeLogger.error("A save could not capture the saved values of its models; a failure would read them afterwards.")
            }
        }
        return result
    }

    /// Called by `save()` after `ModelContext.save()`. A failure keeps the save's captures for
    /// every later discard, also one called without anything listed (the engine's `catch`,
    /// `write`'s end), until those models are saved.
    ///
    /// A success writes the models of the save, so their held captures go. It also drops
    /// every other held capture that no longer matches: one of a model that was deleted, or
    /// whose values differ from the live model. Right after a successful save the live models
    /// are what is on disk, so such a capture is stale (a row the save changed on the side,
    /// for example a bean that got a second entry), and restoring it later would undo a
    /// confirmed write. A held capture equal to the live model is the disk's and stays.
    func finishSave(_ pending: PendingSave, succeeded: Bool) {
        guard succeeded else {
            failedSaveCaptures.merge(pending.captures) { held, _ in held }
            return
        }
        for key in pending.models {
            failedSaveCaptures[key] = nil
        }
        guard !failedSaveCaptures.isEmpty else {
            return
        }
        failedSaveCaptures = failedSaveCaptures.filter { _, capture in
            !capture.model.isDeleted && capture.model.modelContext != nil && capture.differing().isEmpty
        }
    }

    // MARK: The discard

    /// Undoes every unsaved change of the context: the changed and deleted models take the
    /// values the store holds for them again, then the context rolls back, which drops the
    /// inserted models and the deletes, and then every property is checked against the saved
    /// values once more and set where it differs.
    ///
    /// Which saved values (M2-T37, ADR 0025 Addendum M2-T37): for a model that a failed
    /// `ModelContext.save()` handed to the store, the values captured right before that save
    /// (`capturePendingSave`); for any other, the values read now through a fresh context, as
    /// before. The models are the context's changed and deleted ones plus every model with a
    /// held capture, so a discard called without a list still finds a model the context no
    /// longer lists after a failed save.
    ///
    /// Why the second pass (M2-T36, ADR 0025 Addendum M2-T36): when `ModelContext.save()` itself
    /// fails, the save has already applied the delete rules (nullify) to the deleted models,
    /// and a rollback of two deleted models that point to each other (a shelf entry and the
    /// pending bean it leaves) brought them back with the entry's `bean` nil and the entry twice
    /// in the bean's `shelfEntries`. So what the rollback leaves is not trusted: each restore is
    /// idempotent (it compares with the saved value and assigns the exact saved targets, never
    /// appends), the to-one relationships are set first and the to-many ones after, and the
    /// pass repeats until nothing changes. A property set again here holds the store's value,
    /// so a later save stores nothing of the failed write.
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
    func discardUnsavedChanges() {
        _ = discardUnsavedChangesReporting()
    }

    /// `discardUnsavedChanges()`, returning what it saw and did (also kept as
    /// `lastDiscardReport`). Behaves exactly the same; the report is for tests.
    @discardableResult
    func discardUnsavedChangesReporting() -> DiscardReport {
        // The brew photo records deleted in the discarded changes come back, so their files
        // stay (M2-T42, ADR 0033).
        brewPhotoFilesToRemove.removeAll()
        let changed = context.changedModelsArray
        let deleted = context.deletedModelsArray
        var report = DiscardReport(changedModels: changed.count, deletedModels: deleted.count, heldCaptures: failedSaveCaptures.count)
        var seen = Set<ObjectIdentifier>()
        let touched = (changed + deleted + failedSaveCaptures.values.map { capture in capture.model }).filter { model in
            seen.insert(ObjectIdentifier(model)).inserted
        }
        guard !touched.isEmpty else {
            context.rollback()
            lastDiscardReport = report
            return report
        }
        let saved = ModelContext(container)
        saved.autosaveEnabled = false
        var captures: [SavedValuesCapture] = []
        // For each capture, the index of its entry in the report.
        var entryIndices: [Int] = []
        for model in touched {
            if let held = failedSaveCaptures[ObjectIdentifier(model)] {
                entryIndices.append(report.entries.count)
                report.entries.append(DiscardReport.Entry(typeName: held.typeName, source: .capturedBeforeTheSave, differingBefore: held.differing(), differingAfter: []))
                captures.append(held)
                continue
            }
            guard let restorable = model as? any SavedValuesRestorable else {
                continue
            }
            let typeName = String(describing: type(of: model))
            do {
                if let capture = try restorable.captureSavedValues(from: saved) {
                    entryIndices.append(report.entries.count)
                    report.entries.append(DiscardReport.Entry(typeName: typeName, source: .readAtTheDiscard, differingBefore: capture.differing(), differingAfter: []))
                    captures.append(capture)
                } else {
                    report.entries.append(DiscardReport.Entry(typeName: typeName, source: .notOnDisk, differingBefore: [], differingAfter: []))
                }
            } catch {
                // The model is left to the bare rollback, which may keep a changed attribute.
                reportDiscardFault(.savedValuesUnreadable)
                report.entries.append(DiscardReport.Entry(typeName: typeName, source: .unreadable, differingBefore: [], differingAfter: []))
            }
        }
        // Attributes first, then the to-one relationships (their inverses follow), then the
        // to-many ones, which then only change what the to-one ones left wrong.
        for kind in [RestoredPropertyKind.attribute, .toOne, .toMany] {
            for capture in captures {
                _ = capture.restore(kind, self)
            }
        }
        context.rollback()
        let restores = captures.map { capture in
            SavedValuesRestore(
                restoreAgain: { kind in capture.restore(kind, self) },
                isFoundAgain: { capture.isFoundAgain(self) }
            )
        }
        // The copies read at the discard came through `saved`, which must live until the end.
        report.repair = withExtendedLifetime(saved) {
            repairAfterRollback(restores)
        }
        for (capture, index) in zip(captures, entryIndices) {
            report.entries[index].differingAfter = capture.differing()
        }
        lastDiscardReport = report
        return report
    }

    /// What the passes after a rollback ended with.
    struct RelationshipRepair: Equatable {
        /// The last pass changed nothing.
        var settled = false
        /// Some pass set a property (an attribute or a relationship).
        var repaired = false
        /// The last pass found a saved target it could not resolve.
        var unresolved = false
    }

    /// The part of `discardUnsavedChanges()` after the rollback: the passes over every
    /// property, then the fetch of every restored model. Separate so that a test can run it on
    /// restores that never settle or never resolve, which a real store cannot be made to do on
    /// purpose.
    @discardableResult
    func repairAfterRollback(_ restores: [SavedValuesRestore]) -> RelationshipRepair {
        var repair = RelationshipRepair()
        for _ in 0..<AccountStore.relationshipPasses where !repair.settled {
            var outcomes = Set<RestoreOutcome>()
            // Attributes too: what the rollback leaves is not trusted (see above).
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

    /// How often the properties are checked after a rollback before giving up: one pass that
    /// sets them, one that finds them right, and one more in case a set changed an inverse.
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

/// The fetched copies in the order of `models`, matched by `key` (unique, so at most one each).
private func matched<Model: PersistentModel>(_ models: [Model], _ found: [Model], key: KeyPath<Model, UUID>) -> [Model?] {
    var byKey: [UUID: Model] = [:]
    for copy in found where byKey[copy[keyPath: key]] == nil {
        byKey[copy[keyPath: key]] = copy
    }
    return models.map { model in byKey[model[keyPath: key]] }
}

// The models are found by `localID` (unique, never changed after insert), the operations by
// `sequence` (never changed after insert; the engine finds them by it too).

extension StoredBean: SavedValuesRestorable {
    static func savedCopy(of model: StoredBean, in context: ModelContext) throws -> StoredBean? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredBean>(predicate: #Predicate<StoredBean> { bean in bean.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static func savedCopies(of models: [StoredBean], in context: ModelContext) throws -> [StoredBean?] {
        let ids = models.map(\.localID)
        let found = try context.fetch(FetchDescriptor<StoredBean>(predicate: #Predicate<StoredBean> { bean in ids.contains(bean.localID) }))
        return matched(models, found, key: \.localID)
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

    static func savedCopies(of models: [StoredShelfEntry], in context: ModelContext) throws -> [StoredShelfEntry?] {
        let ids = models.map(\.localID)
        let found = try context.fetch(FetchDescriptor<StoredShelfEntry>(predicate: #Predicate<StoredShelfEntry> { entry in ids.contains(entry.localID) }))
        return matched(models, found, key: \.localID)
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

    static func savedCopies(of models: [StoredBrew], in context: ModelContext) throws -> [StoredBrew?] {
        let ids = models.map(\.localID)
        let found = try context.fetch(FetchDescriptor<StoredBrew>(predicate: #Predicate<StoredBrew> { brew in ids.contains(brew.localID) }))
        return matched(models, found, key: \.localID)
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

    static func savedCopies(of models: [StoredRecipe], in context: ModelContext) throws -> [StoredRecipe?] {
        let ids = models.map(\.localID)
        let found = try context.fetch(FetchDescriptor<StoredRecipe>(predicate: #Predicate<StoredRecipe> { recipe in ids.contains(recipe.localID) }))
        return matched(models, found, key: \.localID)
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

    /// One fetch by sequence; an operation matches only with its local id too, as in
    /// `savedCopy`.
    static func savedCopies(of models: [OutboxOperation], in context: ModelContext) throws -> [OutboxOperation?] {
        let sequences = models.map(\.sequence)
        let found = try context.fetch(FetchDescriptor<OutboxOperation>(predicate: #Predicate<OutboxOperation> { operation in sequences.contains(operation.sequence) }))
        let bySequence = Dictionary(grouping: found) { operation in operation.sequence }
        return models.map { model in
            bySequence[model.sequence]?.first { operation in operation.localID == model.localID }
        }
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

extension StoredBrewPhoto: SavedValuesRestorable {
    static func savedCopy(of model: StoredBrewPhoto, in context: ModelContext) throws -> StoredBrewPhoto? {
        let localID = model.localID
        var descriptor = FetchDescriptor<StoredBrewPhoto>(predicate: #Predicate<StoredBrewPhoto> { photo in photo.localID == localID })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    static var restoredProperties: [RestoredProperty<StoredBrewPhoto>] {
        [
            .attribute("brewLocalID", \.brewLocalID),
            .attribute("fileName", \.fileName),
            .attribute("createdAt", \.createdAt),
        ]
    }
}
