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
/// local store, so it works offline. Read-only on the store. `reload()` reads it again at
/// once; the screen calls it on appearing. After a save of the store the screen calls
/// `scheduleReload()` instead: the sync drain saves once per operation, so saves in quick
/// succession are coalesced into one read after `reloadDelay`.
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
    /// How long `scheduleReload()` waits for more saves before it reads.
    let reloadDelay: Duration
    /// The read `scheduleReload()` is waiting to make, nil when none is pending.
    private var pendingReload: Task<Void, Never>?
    /// Reads of the store so far; the tests count coalesced reloads with it.
    private(set) var reloadCount = 0

    /// The default wait of `scheduleReload()`.
    static let defaultReloadDelay = Duration.milliseconds(250)

    init(
        store: AccountStore,
        now: @escaping () -> Date = { Date() },
        calendar: Calendar? = nil,
        reloadDelay: Duration = StatisticsModel.defaultReloadDelay
    ) {
        self.store = store
        self.now = now
        self.calendar = calendar
        self.reloadDelay = reloadDelay
    }

    /// Reads the store after `reloadDelay`. A call while a read is waiting replaces it, so a
    /// run of saves leads to one read after the last of them.
    func scheduleReload() {
        pendingReload?.cancel()
        let delay = reloadDelay
        pendingReload = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else {
                return
            }
            self?.reload()
        }
    }

    /// Reads the store now, and drops a waiting scheduled read, which would read the same.
    func reload() {
        pendingReload?.cancel()
        pendingReload = nil
        reloadCount += 1
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
