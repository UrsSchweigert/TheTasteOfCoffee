import Foundation
import Observation

/// Logging a brew of a shelf entry (M2-T19, docs/04 F2).
///
/// - The screen edits `draft`, never a stored model. `save()` creates the brew and its outbox
///   operation through `AccountStore.addBrew` in one save, so it works offline and the sync
///   engine, which shares the context, never sends half of it (ADR 0025). The request names
///   the shelf entry by the server id it has when the operation is sent.
/// - `brewed_at` is the device's clock at the moment of the save.
/// - The method starts as the one of the entry's latest brew, so a repeat brew needs no pick.
///   A stepper that is not set yet starts at the latest brew's value of that field (same
///   method first, then any), or the middle of its vocabulary range.
/// - A repeat (M2-T27, `BrewStart`) starts with every parameter of the last brew or of a
///   recipe and the timer ready, so it can be saved with no further input. Saving can also
///   keep the parameters as a recipe (`keepsAsRecipe`): a new one, or, for a form started from
///   a recipe, that recipe replaced. The recipe is written in the same save as the brew.
@MainActor
@Observable
final class BrewFormModel {
    enum Failure: Equatable, Sendable {
        /// The shelf entry is gone (removed here, or on another device and pulled).
        case notFound
        /// The local store could not save; nothing was changed.
        case saveFailed
        /// The recipe or brew the form was to start from is gone; the form starts empty.
        /// Saving is still possible.
        case startNotFound
    }

    /// How many of the latest brews on the device are read for the steppers' start values.
    static let recentBrewLimit = 50

    let shelfEntryLocalID: UUID
    var draft: BrewDraft
    private(set) var bean: ShelfBeanSummary
    private(set) var roastDate: API.CalendarDate?
    private(set) var failure: Failure?
    /// The local id of the brew once it was saved; the form then saves nothing more.
    private(set) var savedBrewID: UUID?
    /// What the draft was copied from: the requested start, or `.blank` when that is gone.
    let startedFrom: BrewStart
    /// Whether the form was started from a recipe this build may replace; `keepsAsRecipe`
    /// then replaces it instead of saving a new one.
    let replacesStartedRecipe: Bool
    /// Whether saving also keeps the brew's parameters as a recipe (M2-T27). Off by default.
    var keepsAsRecipe = false
    /// The local id of the recipe kept with the saved brew, if any.
    private(set) var savedRecipeID: UUID?

    let store: AccountStore
    /// The brew timer (M2-T21); stopping it fills `draft.brewTimeS`.
    let timer: BrewTimerModel
    private let now: () -> Date
    private let calendar: Calendar
    /// The latest brews on the device, newest first.
    private let recentBrews: [BrewDraft]
    /// Adds the brew to the entry and saves (`AccountStore.addBrew`). Tests replace it to make
    /// the write fail.
    private let addBrew: (AccountStore, StoredBrew, StoredShelfEntry) throws -> Void

    init(
        shelfEntry localID: UUID,
        store: AccountStore,
        now: @escaping () -> Date = { Date() },
        calendar: Calendar = .current,
        start: BrewStart = .blank,
        timer: BrewTimerModel? = nil,
        addBrew: @escaping (AccountStore, StoredBrew, StoredShelfEntry) throws -> Void = { store, brew, entry in
            try store.addBrew(brew, shelfEntry: entry)
        }
    ) {
        shelfEntryLocalID = localID
        self.store = store
        self.now = now
        self.calendar = calendar
        self.timer = timer ?? BrewTimerModel()
        self.addBrew = addBrew
        let brews = (try? store.brewsNewestFirst()) ?? []
        recentBrews = brews.prefix(BrewFormModel.recentBrewLimit).map { brew in BrewDraft(brew) }
        let entry = try? store.shelfEntry(localID: localID)
        if let entry, entry.syncState != .pendingDelete {
            bean = ShelfBeanSummary(entry.bean)
            roastDate = entry.roastDate
            let copy = BrewFormModel.startingDraft(start, entry: entry, store: store)
            draft = copy?.draft ?? BrewDraft(method: entry.liveBrewsNewestFirst.first?.method)
            startedFrom = copy == nil ? .blank : start
            replacesStartedRecipe = copy?.replaceable ?? false
            failure = copy == nil && start != .blank ? .startNotFound : nil
        } else {
            bean = ShelfBeanSummary(nil)
            roastDate = nil
            draft = BrewDraft()
            startedFrom = .blank
            replacesStartedRecipe = false
            failure = .notFound
        }
    }

    /// The draft a repeat starts from, with whether it is a recipe this build may replace;
    /// nil for a blank start or a start that is gone.
    private static func startingDraft(
        _ start: BrewStart,
        entry: StoredShelfEntry,
        store: AccountStore
    ) -> (draft: BrewDraft, replaceable: Bool)? {
        switch start {
        case .blank:
            return nil
        case .lastBrew:
            guard let brew = try? store.lastBrewToRepeat(for: entry) else {
                return nil
            }
            return (BrewDraft(brew), false)
        case .recipe(let recipeID):
            guard let recipe = try? store.liveRecipe(localID: recipeID) else {
                return nil
            }
            return (BrewDraft(recipe), recipe.isReplaceable)
        }
    }

    /// Whether `save()` would write: a method is picked, the entry exists, and the brew was
    /// not saved yet.
    var canSave: Bool {
        draft.isComplete && failure != .notFound && savedBrewID == nil
    }

    // MARK: - Steppers

    /// The value a stepper that is not set starts at: the latest brew's value of `field` with
    /// the draft's method, else of any brew, else nil (the draft then takes the middle of the
    /// range).
    func seed(for field: BrewNumberField) -> Double? {
        if let method = draft.method,
           let sameMethod = recentBrews.first(where: { brew in brew.method == method && brew.value(of: field) != nil }) {
            return sameMethod.value(of: field)
        }
        return recentBrews.first { brew in brew.value(of: field) != nil }?.value(of: field)
    }

    func increment(_ field: BrewNumberField) {
        draft.step(field, by: 1, seed: seed(for: field))
    }

    func decrement(_ field: BrewNumberField) {
        draft.step(field, by: -1, seed: seed(for: field))
    }

    func clear(_ field: BrewNumberField) {
        draft.setValue(nil, of: field)
    }

    /// The text of `field`'s stepper, nil while it is not set.
    func valueText(of field: BrewNumberField, locale: Locale = .current) -> String? {
        draft.value(of: field).map { value in BrewFormat.value(value, of: field, locale: locale) }
    }

    var temperatureChoice: BrewDraft.TemperatureChoice {
        get { draft.temperatureChoice }
        set { draft.chooseTemperature(newValue, seed: seed(for: .temperature)) }
    }

    // MARK: - Derived values, shown as values change

    /// The ratio text (`1:16.2`), nil until dose and water are set.
    func ratioText(locale: Locale = .current) -> String? {
        draft.ratio.map { ratio in BrewFormat.ratio(ratio, locale: locale) }
    }

    /// Grams of water per gram of coffee, for VoiceOver, nil until dose and water are set.
    func ratioNumberText(locale: Locale = .current) -> String? {
        draft.ratio.map { ratio in BrewFormat.number(ratio, fractionDigits: 1, locale: locale) }
    }

    /// Days from the entry's roast date to today, the day the brew is recorded.
    var daysSinceRoast: Int? {
        BrewDerivedValues.daysSinceRoast(roastDate: roastDate, brewedAt: now(), calendar: calendar)
    }

    // MARK: - Brew timer (M2-T21)

    /// Starts the brew timer. The brew time already set stays until the timer is stopped.
    func startTimer() {
        timer.start()
    }

    /// Stops the brew timer and sets `brew_time_s` to the time it ran, clamped to its
    /// vocabulary range.
    func stopTimer(locale: Locale = .current) {
        guard let seconds = timer.stop(locale: locale) else {
            return
        }
        draft.setBrewTime(seconds: seconds)
    }

    /// Resets the brew timer and clears `brew_time_s`, so the readout and the saved value
    /// never disagree.
    func resetTimer() {
        timer.reset()
        draft.setBrewTime(nil)
    }

    // MARK: - Writes

    /// Saves the brew on the entry, with `brewed_at` now, and queues its create. Returns the
    /// brew's local id, nil when nothing was written (`failure` says why).
    @discardableResult
    func save() -> UUID? {
        guard canSave else {
            return nil
        }
        if timer.isRunning {
            // A running timer is stopped by the save, so its time is not lost.
            stopTimer()
        }
        guard let parameters = draft.parameters else {
            return nil
        }
        do {
            guard let entry = try store.shelfEntry(localID: shelfEntryLocalID), entry.syncState != .pendingDelete else {
                failure = .notFound
                return nil
            }
            guard let brewedAt = API.Timestamp(now()) else {
                throw LocalStoreError.invalidDate
            }
            let brew = StoredBrew(
                vocabularyVersion: Vocabulary.version,
                brewedAtMilliseconds: brewedAt.millisecondsSince1970,
                methodID: parameters.method.rawValue
            )
            brew.setParameters(parameters)
            // A failed write puts the entry's saved fields back (`AccountStore.write`), so
            // nothing half-made stays in the shared context for the engine to save. The recipe,
            // if kept, is staged first and saved in the brew's one save.
            let recipeID = try store.write { () throws -> UUID? in
                var recipe: StoredRecipe?
                if keepsAsRecipe {
                    recipe = try stageRecipe(parameters)
                }
                try addBrew(store, brew, entry)
                return recipe?.localID
            }
            failure = nil
            savedRecipeID = recipeID
            savedBrewID = brew.localID
            return brew.localID
        } catch {
            failure = .saveFailed
            return nil
        }
    }

    /// Stages the recipe kept with the brew: the started recipe replaced, if it may be and is
    /// still there, else a new recipe (or the one with the same parameters).
    private func stageRecipe(_ parameters: API.BrewParameters) throws -> StoredRecipe {
        if replacesStartedRecipe, case .recipe(let recipeID) = startedFrom, let recipe = try store.liveRecipe(localID: recipeID) {
            _ = try store.stageRecipeReplacement(recipe, with: parameters)
            return recipe
        }
        return try store.stageNewRecipe(parameters, createdAt: now())
    }

    /// Reads the entry again (a pull may have removed it or changed its roast date).
    func refresh() {
        guard savedBrewID == nil else {
            return
        }
        guard let entry = try? store.shelfEntry(localID: shelfEntryLocalID), entry.syncState != .pendingDelete else {
            failure = .notFound
            return
        }
        bean = ShelfBeanSummary(entry.bean)
        roastDate = entry.roastDate
        if failure == .notFound {
            failure = nil
        }
    }
}
