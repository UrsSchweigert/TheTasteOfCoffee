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
            isRemoved: brew.syncState == .pendingDelete,
            shelfEntryID: brew.shelfEntry?.localID,
            id: brew.localID
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
    /// The methods the picker offers besides "all": those with rated brews, vocabulary order.
    private(set) var availableMethods: [Vocabulary.Method] = []

    /// The method choice (M2-T50): what is kept, resolved against `availableMethods`, so a
    /// kept id that is unknown or has no rated brews any more gives "all methods" without
    /// losing the kept value (the method may come back).
    var choice: StatisticsMethodChoice {
        StatisticsMethodChoice.resolve(requested, offering: availableMethods)
    }

    let store: AccountStore
    private let setting: StatisticsMethodSetting
    /// The kept id or "all", as last picked or read from `setting`.
    private var requested: String?
    /// The brews of the last read, so a new choice needs no second read of the store.
    private var brews: [StatisticsBrew] = []
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
        reloadDelay: Duration = StatisticsModel.defaultReloadDelay,
        setting: StatisticsMethodSetting = .standard
    ) {
        self.store = store
        self.setting = setting
        self.requested = setting.storedValue
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
            brews = StatisticsBrew.values(of: try store.brewsNewestFirst())
            loadFailed = false
            recompute()
        } catch {
            statistics = nil
            availableMethods = []
            loadFailed = true
        }
    }

    /// Picks `choice` (the picker's action): kept as one method id or "all", and the numbers
    /// are made again from the brews already read.
    func select(_ choice: StatisticsMethodChoice) {
        requested = choice.storageValue
        setting.storedValue = choice.storageValue
        recompute()
    }

    /// The statistics of `brews` for the current choice, by `PersonalStatistics.compute` with
    /// a method filter: no second implementation of any number.
    private func recompute() {
        let weekCalendar = calendar ?? PersonalStatistics.isoWeekCalendar(timeZone: TimeZone.current)
        availableMethods = PersonalStatistics.ratedMethods(in: brews)
        statistics = PersonalStatistics.compute(brews, now: now(), calendar: weekCalendar, method: choice.method)
    }
}
