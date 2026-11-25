import Foundation
import Observation

/// A bean the user can put a shelf entry on, for the bean choice.
struct ShelfBeanChoice: Identifiable, Equatable, Sendable {
    /// The bean's local id.
    let id: UUID
    let summary: ShelfBeanSummary
}

/// Adding a shelf entry after a bean was found, confirmed or created (F1 step 5), and editing
/// or removing one (M2-T18).
///
/// - The screen edits `draft` and `beanLocalID`, never a stored model. `save()` and `delete()`
///   write through `AccountStore` in one step, so the change and its outbox operation are
///   saved together and the sync engine, which shares the context, never sends half of it
///   (ADR 0025). The outbox sends it when the device is online.
/// - While brews on the device reference the entry (`brewCount` > 0, brews removed on the
///   device not counted), its bean cannot change (D14) and it cannot be removed (ADR 0012):
///   `canChangeBean` and `canDelete` are false and `lockReason` says why. `save()` and
///   `delete()` check again against the store, so a brew added meanwhile is respected.
@MainActor
@Observable
final class ShelfEntryEditorModel {
    enum Mode: Equatable, Sendable {
        /// A new entry for a catalogue bean the API returned.
        case add(API.Bean)
        /// The stored entry with this local id.
        case edit(UUID)
    }

    /// Why the bean change and the removal are disabled.
    enum Lock: Equatable, Sendable {
        /// Brews reference the entry (D14, ADR 0012).
        case hasBrews
    }

    enum Failure: Equatable, Sendable {
        /// The entry is gone (removed here, or on another device and pulled).
        case notFound
        /// Brews reference the entry now, so the bean change or the removal was refused.
        case hasBrews
        /// The local store could not save; nothing was changed.
        case saveFailed
    }

    let mode: Mode
    var draft: ShelfEntryDraft
    /// The chosen bean's local id when editing; nil when adding (the bean is the mode's).
    var beanLocalID: UUID?
    private(set) var bean: ShelfBeanSummary
    private(set) var brewCount = 0
    private(set) var issue: SyncIssue?
    private(set) var failure: Failure?

    let store: AccountStore
    private let now: () -> Date
    private let calendar: Calendar
    private var savedDraft: ShelfEntryDraft
    private var savedBeanLocalID: UUID?

    init(mode: Mode, store: AccountStore, now: @escaping () -> Date = { Date() }, calendar: Calendar = .current) {
        self.mode = mode
        self.store = store
        self.now = now
        self.calendar = calendar
        let draft: ShelfEntryDraft
        switch mode {
        case .add(let apiBean):
            draft = ShelfEntryDraft.new(today: now(), calendar: calendar)
            bean = ShelfBeanSummary(
                name: apiBean.openFoodFacts?.name,
                brand: apiBean.openFoodFacts?.brand,
                attributes: apiBean.attributeRows
            )
        case .edit(let localID):
            let entry = try? store.shelfEntry(localID: localID)
            if let entry, entry.syncState != .pendingDelete {
                draft = ShelfEntryDraft(entry)
                bean = ShelfBeanSummary(entry.bean)
                beanLocalID = entry.bean?.localID
                brewCount = entry.liveBrewCount
                issue = entry.syncIssue
            } else {
                draft = ShelfEntryDraft(purchaseDate: nil)
                bean = ShelfBeanSummary(nil)
                failure = .notFound
            }
        }
        self.draft = draft
        savedDraft = draft
        savedBeanLocalID = beanLocalID
    }

    var isAdding: Bool {
        if case .add = mode {
            return true
        }
        return false
    }

    /// Why the bean change and the removal are disabled, nil when they are not.
    var lockReason: Lock? {
        brewCount > 0 ? .hasBrews : nil
    }

    /// Whether another bean can be chosen: only for a stored entry without brews (D14).
    var canChangeBean: Bool {
        !isAdding && failure != .notFound && lockReason == nil
    }

    /// Whether the entry can be removed: only a stored entry without brews (ADR 0012).
    var canDelete: Bool {
        !isAdding && failure != .notFound && lockReason == nil
    }

    var hasChanges: Bool {
        draft != savedDraft || beanLocalID != savedBeanLocalID
    }

    /// Whether `save()` would write: a new entry with a purchase date, or a change to a
    /// stored entry that still exists.
    var canSave: Bool {
        guard draft.isComplete, failure != .notFound else {
            return false
        }
        return isAdding || hasChanges
    }

    // MARK: - Dates for the pickers

    /// The purchase date as a picker value; today while it is not set.
    var purchaseDateValue: Date {
        draft.purchaseDate.flatMap { day in ShelfDates.date(of: day, calendar: calendar) } ?? now()
    }

    func setPurchaseDate(_ date: Date) {
        if let day = ShelfDates.day(of: date, calendar: calendar) {
            draft.purchaseDate = day
        }
    }

    var hasRoastDate: Bool {
        draft.roastDate != nil
    }

    func setHasRoastDate(_ hasRoastDate: Bool) {
        draft.setHasRoastDate(hasRoastDate, today: now(), calendar: calendar)
    }

    /// The roast date as a picker value; the purchase date while it is not set.
    var roastDateValue: Date {
        draft.roastDate.flatMap { day in ShelfDates.date(of: day, calendar: calendar) } ?? purchaseDateValue
    }

    func setRoastDate(_ date: Date) {
        if let day = ShelfDates.day(of: date, calendar: calendar) {
            draft.roastDate = day
        }
    }

    /// The latest day a picker offers: today.
    var latestDate: Date {
        now()
    }

    /// Days from the draft's roast date to today, as the shelf will show it.
    var daysSinceRoast: Int? {
        BrewDerivedValues.daysSinceRoast(roastDate: draft.roastDate, brewedAt: now(), calendar: calendar)
    }

    // MARK: - Bean choice

    /// Every bean on the device, for the bean change.
    func beanChoices() -> [ShelfBeanChoice] {
        ((try? store.beans()) ?? []).map { bean in ShelfBeanChoice(id: bean.localID, summary: ShelfBeanSummary(bean)) }
    }

    /// Picks another bean. Ignored while the bean cannot change.
    func chooseBean(_ choice: ShelfBeanChoice) {
        guard canChangeBean else {
            return
        }
        beanLocalID = choice.id
        bean = choice.summary
    }

    // MARK: - Writes

    /// Saves the draft: a new entry for the mode's bean, or the change to the stored entry.
    /// Returns the entry's local id, nil when nothing was written (`failure` says why).
    @discardableResult
    func save() -> UUID? {
        guard canSave else {
            return nil
        }
        do {
            let localID: UUID
            switch mode {
            case .add(let apiBean):
                localID = try add(apiBean)
            case .edit(let entryID):
                guard let saved = try update(entryID) else {
                    return nil
                }
                localID = saved
            }
            failure = nil
            savedDraft = draft
            savedBeanLocalID = beanLocalID
            return localID
        } catch {
            // Nothing half-made stays in the shared context for the engine to save.
            store.context.rollback()
            failure = .saveFailed
            return nil
        }
    }

    /// Removes the stored entry (`AccountStore.markDeleted`). False when nothing was removed.
    @discardableResult
    func delete() -> Bool {
        guard case .edit(let entryID) = mode, canDelete else {
            return false
        }
        do {
            guard let entry = try store.shelfEntry(localID: entryID), entry.syncState != .pendingDelete else {
                failure = .notFound
                return false
            }
            brewCount = entry.liveBrewCount
            guard brewCount == 0 else {
                failure = .hasBrews
                return false
            }
            try store.markDeleted(entry)
            return true
        } catch LocalStoreError.shelfEntryHasBrews {
            failure = .hasBrews
            return false
        } catch {
            store.context.rollback()
            failure = .saveFailed
            return false
        }
    }

    /// Reads the brew count and the flag again (a pull or the engine may have changed them).
    func refresh() {
        guard case .edit(let entryID) = mode else {
            return
        }
        guard let entry = try? store.shelfEntry(localID: entryID), entry.syncState != .pendingDelete else {
            failure = .notFound
            return
        }
        brewCount = entry.liveBrewCount
        issue = entry.syncIssue
    }

    private func add(_ apiBean: API.Bean) throws -> UUID {
        guard let purchaseDate = draft.purchaseDate else {
            throw LocalStoreError.invalidDate
        }
        let bean = try store.catalogueBean(apiBean)
        let entry = StoredShelfEntry(purchaseDate: purchaseDate)
        draft.apply(to: entry)
        try store.addShelfEntry(entry, bean: bean)
        return entry.localID
    }

    /// Nil, with `failure` set, when the entry is gone or the bean change is refused.
    private func update(_ entryID: UUID) throws -> UUID? {
        guard let entry = try store.shelfEntry(localID: entryID), entry.syncState != .pendingDelete else {
            failure = .notFound
            return nil
        }
        brewCount = entry.liveBrewCount
        if beanLocalID != entry.bean?.localID {
            guard brewCount == 0 else {
                failure = .hasBrews
                return nil
            }
            guard let beanLocalID, let chosen = try store.bean(localID: beanLocalID) else {
                failure = .notFound
                return nil
            }
            entry.bean = chosen
        }
        draft.apply(to: entry)
        try store.markUpdated(entry)
        return entry.localID
    }
}
