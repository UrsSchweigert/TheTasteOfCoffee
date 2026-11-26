import Foundation
import Observation

extension StatisticsBrew {
    /// The plain values of a stored brew. Reads only; changes nothing.
    init(_ brew: StoredBrew, bean: StatisticsBean?) {
        self.init(
            brewedAt: brew.brewedAt,
            method: brew.method,
            bean: bean,
            rating: brew.rating,
            isRemoved: brew.syncState == .pendingDelete
        )
    }

    /// The plain values of `brews`, each bean's summary made once.
    static func values(of brews: [StoredBrew]) -> [StatisticsBrew] {
        var beans: [UUID: StatisticsBean] = [:]
        return brews.map { brew in
            var bean: StatisticsBean?
            if let stored = brew.shelfEntry?.bean {
                if let known = beans[stored.localID] {
                    bean = known
                } else {
                    let made = StatisticsBean(id: stored.localID, summary: ShelfBeanSummary(stored))
                    beans[stored.localID] = made
                    bean = made
                }
            }
            return StatisticsBrew(brew, bean: bean)
        }
    }
}

/// The statistics screen's state (M2-T28, ADR 0027): the account's own brews read from the
/// local store, so it works offline. Read-only on the store. `reload()` reads it again; the
/// screen calls it on appearing and after every save of the store.
@MainActor
@Observable
final class StatisticsModel {
    /// Nil before the first read and after a failed one.
    private(set) var statistics: PersonalStatistics?
    /// True when the last read of the store failed.
    private(set) var loadFailed = false

    let store: AccountStore
    private let now: () -> Date
    /// Nil in the app: an ISO week calendar in the device's current time zone, made at each
    /// read, so a time zone change takes effect.
    private let calendar: Calendar?

    init(store: AccountStore, now: @escaping () -> Date = { Date() }, calendar: Calendar? = nil) {
        self.store = store
        self.now = now
        self.calendar = calendar
    }

    func reload() {
        do {
            let brews = StatisticsBrew.values(of: try store.brewsNewestFirst())
            let weekCalendar = calendar ?? PersonalStatistics.isoWeekCalendar(timeZone: TimeZone.current)
            statistics = PersonalStatistics.compute(brews, now: now(), calendar: weekCalendar)
            loadFailed = false
        } catch {
            statistics = nil
            loadFailed = true
        }
    }
}
