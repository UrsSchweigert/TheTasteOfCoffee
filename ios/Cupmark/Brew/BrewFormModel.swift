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
@MainActor
@Observable
final class BrewFormModel {
    enum Failure: Equatable, Sendable {
        /// The shelf entry is gone (removed here, or on another device and pulled).
        case notFound
        /// The local store could not save; nothing was changed.
        case saveFailed
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

    let store: AccountStore
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
        addBrew: @escaping (AccountStore, StoredBrew, StoredShelfEntry) throws -> Void = { store, brew, entry in
            try store.addBrew(brew, shelfEntry: entry)
        }
    ) {
        shelfEntryLocalID = localID
        self.store = store
        self.now = now
        self.calendar = calendar
        self.addBrew = addBrew
        let brews = (try? store.brewsNewestFirst()) ?? []
        recentBrews = brews.prefix(BrewFormModel.recentBrewLimit).map { brew in BrewDraft(brew) }
        let entry = try? store.shelfEntry(localID: localID)
        if let entry, entry.syncState != .pendingDelete {
            bean = ShelfBeanSummary(entry.bean)
            roastDate = entry.roastDate
            draft = BrewDraft(method: entry.liveBrewsNewestFirst.first?.method)
            failure = nil
        } else {
            bean = ShelfBeanSummary(nil)
            roastDate = nil
            draft = BrewDraft()
            failure = .notFound
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

    // MARK: - Writes

    /// Saves the brew on the entry, with `brewed_at` now, and queues its create. Returns the
    /// brew's local id, nil when nothing was written (`failure` says why).
    @discardableResult
    func save() -> UUID? {
        guard canSave, let parameters = draft.parameters else {
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
            try addBrew(store, brew, entry)
            failure = nil
            savedBrewID = brew.localID
            return brew.localID
        } catch {
            // Nothing half-made stays in the shared context for the engine to save.
            store.context.rollback()
            failure = .saveFailed
            return nil
        }
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
