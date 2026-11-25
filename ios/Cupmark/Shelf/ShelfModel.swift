import Foundation
import Observation

/// What the shelf shows for a bean: its Open Food Facts name and brand, or else its
/// attributes (the operator's value first, then the user's picks).
///
/// Name and brand are untrusted text from Open Food Facts (ADR 0005): views show them only
/// with `Text(verbatim:)`, never as a localisation key or Markdown, and never send or log them.
struct ShelfBeanSummary: Equatable, Sendable {
    let name: String?
    let brand: String?
    let attributes: [BeanAttributeRow]

    init(name: String?, brand: String?, attributes: [BeanAttributeRow]) {
        self.name = ShelfBeanSummary.shown(name)
        self.brand = ShelfBeanSummary.shown(brand)
        self.attributes = attributes
    }

    init(_ bean: StoredBean?) {
        self.init(
            name: bean?.openFoodFactsName,
            brand: bean?.openFoodFactsBrand,
            attributes: bean.map { bean in
                BeanAttributeRow.rows(operatorAttributes: bean.operatorAttributes, pickedAttributes: bean.pickedAttributes)
            } ?? []
        )
    }

    /// Whether the bean has Open Food Facts text to show; otherwise its attributes are shown.
    var hasOpenFoodFactsText: Bool {
        name != nil || brand != nil
    }

    /// Text that is empty or only white space is treated as missing.
    private static func shown(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return text
    }
}

/// One row of the shelf, read from a stored entry.
struct ShelfRow: Identifiable, Equatable, Sendable {
    /// The entry's local id.
    let id: UUID
    let bean: ShelfBeanSummary
    let purchaseDate: API.CalendarDate?
    let roastDate: API.CalendarDate?
    /// From the roast date to today, in the device calendar.
    let daysSinceRoast: Int?
    /// The brews on the device that reference the entry, not those removed on the device.
    let brewCount: Int
    let issue: SyncIssue?

    init(_ entry: StoredShelfEntry, now: Date, calendar: Calendar) {
        id = entry.localID
        bean = ShelfBeanSummary(entry.bean)
        purchaseDate = entry.purchaseDate
        roastDate = entry.roastDate
        daysSinceRoast = entry.daysSinceRoast(on: now, calendar: calendar)
        brewCount = entry.liveBrewCount
        issue = entry.syncIssue
    }
}

/// The shelf list (M2-T18, docs/04 F1 step 5): every shelf entry in the local store, latest
/// purchase first, so it works offline. `reload()` reads the store again; the screen calls it
/// after every save of the store (`AccountStore.didSaveNotification`), by its own writes, the
/// sync engine or the pull.
@MainActor
@Observable
final class ShelfModel {
    private(set) var rows: [ShelfRow] = []
    /// How many items have a sync issue (`AccountStore.syncIssues()`).
    private(set) var issueCount = 0
    /// True when the last read of the store failed.
    private(set) var loadFailed = false

    let store: AccountStore
    private let now: () -> Date
    private let calendar: Calendar

    init(store: AccountStore, now: @escaping () -> Date = { Date() }, calendar: Calendar = .current) {
        self.store = store
        self.now = now
        self.calendar = calendar
    }

    func reload() {
        do {
            let today = now()
            rows = try store.shelfEntries().map { entry in ShelfRow(entry, now: today, calendar: calendar) }
            issueCount = try store.syncIssues().count
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}
