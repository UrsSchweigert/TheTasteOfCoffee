import XCTest
@testable import Cupmark

/// The brew timer (M2-T21, docs/04 Input model "Timer", F2 brew time). Every test uses an
/// injected clock: time passes by moving the clock, with no tick in between, which is exactly
/// what the app sees after a spell in the background or with the phone locked. The range of
/// `brew_time_s` comes from `Vocabulary.Ranges`, never from a number typed here.
@MainActor
final class BrewTimerTests: XCTestCase {
    /// A clock that moves only when the test moves it.
    @MainActor
    private final class ManualClock {
        private let origin = ContinuousClock.now
        private var offset = Duration.zero

        var now: ContinuousClock.Instant {
            origin.advanced(by: offset)
        }

        func advance(by duration: Duration) {
            offset += duration
        }
    }

    /// The VoiceOver announcements the timer posted.
    @MainActor
    private final class Announcements {
        var messages: [String] = []
    }

    private var appBundle: Bundle { Bundle(for: AppBundleToken.self) }
    private var range: VocabularyRange { BrewDraft.brewTimeRange }

    private func timer(_ clock: ManualClock, _ announcements: Announcements = Announcements()) -> BrewTimerModel {
        BrewTimerModel(now: { clock.now }, announce: { message in announcements.messages.append(message) })
    }

    private func formModel(_ store: AccountStore, entry: StoredShelfEntry, timer: BrewTimerModel) throws -> BrewFormModel {
        let now = try StoreFixtures.timestamp("2026-11-25T08:30:00.123Z").date
        return BrewFormModel(
            shelfEntry: entry.localID,
            store: store,
            now: { now },
            calendar: try StoreFixtures.calendar("Europe/Berlin"),
            timer: timer
        )
    }

    /// A whole number of seconds inside the range, `offset` steps above its minimum.
    private func secondsInRange(_ offset: Int) throws -> Int {
        let value = range.minimum + Double(offset) * range.multipleOf
        XCTAssertTrue(range.contains(value), "the vocabulary range of brew_time_s holds \(value)")
        return try XCTUnwrap(Int(exactly: value))
    }

    // MARK: - Measured from the start instant

    func testThirtySecondsInTheBackgroundCountAsThirtySeconds() throws {
        let clock = ManualClock()
        let model = timer(clock)
        model.start()
        XCTAssertTrue(model.isRunning)
        XCTAssertEqual(model.elapsed(), .zero)

        // The app is in the background or the phone locked: nothing runs, the clock moves on.
        clock.advance(by: .seconds(30))

        XCTAssertEqual(model.elapsed(), .seconds(30), "the readout shows 30 s on return")
        XCTAssertEqual(model.elapsed().wholeSeconds, 30)
        XCTAssertEqual(model.stop(), 30, "and Stop records 30 s")
        XCTAssertFalse(model.isRunning)
    }

    func testTheElapsedTimeIsReadFromTheStartInstantEachTime() {
        let clock = ManualClock()
        let model = timer(clock)
        model.start()
        clock.advance(by: .seconds(5))
        XCTAssertEqual(model.elapsed().wholeSeconds, 5)
        clock.advance(by: .milliseconds(25_900))
        XCTAssertEqual(model.elapsed().wholeSeconds, 30, "30.9 s shows as 30 s: a second is shown once it has passed")
        XCTAssertEqual(model.elapsed().secondsWithFraction, 30.9, accuracy: 0.000_001)
    }

    func testStartingARunningTimerKeepsItsStart() {
        let clock = ManualClock()
        let announcements = Announcements()
        let model = timer(clock, announcements)
        model.start()
        clock.advance(by: .seconds(10))
        model.start()
        clock.advance(by: .seconds(5))
        XCTAssertEqual(model.elapsed(), .seconds(15))
        XCTAssertEqual(announcements.messages.count, 1, "a second start announces nothing")
    }

    func testANotRunningTimerHasNoTimeAndStopReturnsNothing() {
        let clock = ManualClock()
        let model = timer(clock)
        clock.advance(by: .seconds(30))
        XCTAssertEqual(model.elapsed(), .zero)
        XCTAssertNil(model.stop())
    }

    // MARK: - Stop fills brew_time_s, clamped to its vocabulary range

    func testTheRangeIsTheBundledOne() throws {
        let store = try VocabularyStore.load(from: appBundle)
        XCTAssertEqual(BrewDraft.brewTimeRange, Vocabulary.Ranges.brewTimeS)
        XCTAssertEqual(store.ranges["brew.ranges.brew_time_s"], BrewDraft.brewTimeRange)
    }

    func testStopFillsBrewTimeS() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let clock = ManualClock()
        let model = try formModel(store, entry: entry, timer: timer(clock))
        XCTAssertNil(model.draft.brewTimeS)

        model.startTimer()
        clock.advance(by: .seconds(try secondsInRange(149)))
        model.stopTimer()

        XCTAssertEqual(model.draft.brewTimeS, try secondsInRange(149))
        XCTAssertFalse(model.timer.isRunning)
    }

    func testAStopWithinTheFirstSecondIsTheMinimum() throws {
        let clock = ManualClock()
        let model = timer(clock)
        model.start()
        clock.advance(by: .milliseconds(300))
        XCTAssertEqual(model.stop(), try XCTUnwrap(Int(exactly: range.minimum)))
    }

    func testATimerLeftRunningPastTheMaximumIsTheMaximum() throws {
        let clock = ManualClock()
        let model = timer(clock)
        model.start()
        let maximum = try XCTUnwrap(Int(exactly: range.maximum))
        clock.advance(by: .seconds(maximum) + .seconds(3_600))
        XCTAssertEqual(model.stop(), maximum)
    }

    func testTheClampKeepsEveryValueInTheRangeAndOnItsStep() throws {
        let maximum = try XCTUnwrap(Int(exactly: range.maximum))
        for seconds in [0, 1, 29, 30, 150, maximum - 1, maximum, maximum + 1, maximum * 2] {
            let value = try XCTUnwrap(BrewDraft.brewTimeS(for: .seconds(seconds)), "\(seconds) s")
            XCTAssertTrue(range.contains(Double(value)), "\(seconds) s is \(value), within the range")
        }
        XCTAssertEqual(BrewDraft.brewTimeS(for: .milliseconds(29_999)), try secondsInRange(28), "whole seconds, rounded down")
    }

    func testSettingTheBrewTimeClampsItAndNilClearsIt() throws {
        let maximum = try XCTUnwrap(Int(exactly: range.maximum))
        let minimum = try XCTUnwrap(Int(exactly: range.minimum))
        var draft = BrewDraft(method: try StoreFixtures.first(Vocabulary.Method.self))
        draft.setBrewTime(seconds: try secondsInRange(29))
        XCTAssertEqual(draft.brewTimeS, try secondsInRange(29), "a value in the range is kept")
        draft.setBrewTime(seconds: maximum + 1)
        XCTAssertEqual(draft.brewTimeS, maximum)
        draft.setBrewTime(seconds: minimum - 1)
        XCTAssertEqual(draft.brewTimeS, minimum)
        draft.setBrewTime(seconds: nil)
        XCTAssertNil(draft.brewTimeS)
        draft.setBrewTime(.seconds(30))
        XCTAssertEqual(draft.brewTimeS, 30)
        draft.setBrewTime(nil)
        XCTAssertNil(draft.brewTimeS)
    }

    func testTheTimedBrewIsSavedAndASaveStopsARunningTimer() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let clock = ManualClock()
        let model = try formModel(store, entry: entry, timer: timer(clock))
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)

        model.startTimer()
        clock.advance(by: .seconds(try secondsInRange(44)))
        let localID = try XCTUnwrap(model.save(), "Save while the timer runs")

        XCTAssertFalse(model.timer.isRunning, "the save stopped the timer")
        let brew = try XCTUnwrap(try store.brew(localID: localID))
        XCTAssertEqual(brew.brewTimeS, try secondsInRange(44))
        XCTAssertEqual(try brew.apiInput().parameters.brewTimeS, try secondsInRange(44))
        let data = try JSONEncoder().encode(try brew.apiInput().parameters)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["brew_time_s"] as? Int, try secondsInRange(44))
    }

    // MARK: - Reset and clearing

    func testResetWhileRunningStopsWithoutAValue() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let clock = ManualClock()
        let model = try formModel(store, entry: entry, timer: timer(clock))

        model.startTimer()
        clock.advance(by: .seconds(10))
        model.resetTimer()

        XCTAssertFalse(model.timer.isRunning)
        XCTAssertEqual(model.timer.elapsed(), .zero)
        XCTAssertNil(model.draft.brewTimeS)
        model.stopTimer()
        XCTAssertNil(model.draft.brewTimeS, "a reset timer has nothing to stop")
    }

    func testResetClearsTheBrewTime() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let clock = ManualClock()
        let model = try formModel(store, entry: entry, timer: timer(clock))
        model.draft.method = try StoreFixtures.first(Vocabulary.Method.self)

        model.startTimer()
        clock.advance(by: .seconds(30))
        model.stopTimer()
        XCTAssertEqual(model.draft.brewTimeS, 30)

        model.resetTimer()
        XCTAssertNil(model.draft.brewTimeS)
        let data = try JSONEncoder().encode(try XCTUnwrap(model.draft.parameters))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["brew_time_s"], "a cleared brew time is not sent")

        // A new timing after the reset starts from zero.
        model.startTimer()
        clock.advance(by: .seconds(try secondsInRange(19)))
        model.stopTimer()
        XCTAssertEqual(model.draft.brewTimeS, try secondsInRange(19))
    }

    func testANewTimingReplacesTheBrewTimeOnlyWhenItStops() throws {
        let store = try AccountStore.inMemory()
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        let clock = ManualClock()
        let model = try formModel(store, entry: entry, timer: timer(clock))
        model.startTimer()
        clock.advance(by: .seconds(30))
        model.stopTimer()

        model.startTimer()
        clock.advance(by: .seconds(5))
        XCTAssertEqual(model.draft.brewTimeS, 30, "the brew time stays until the new timing stops")
        model.stopTimer()
        XCTAssertEqual(model.draft.brewTimeS, try secondsInRange(4))
    }

    // MARK: - VoiceOver and the readout

    func testStartStopAndResetAreAnnounced() {
        let clock = ManualClock()
        let announcements = Announcements()
        let model = timer(clock, announcements)
        let english = Locale(identifier: "en_US")

        model.start()
        clock.advance(by: .seconds(150))
        _ = model.stop(locale: english)
        model.reset()

        XCTAssertEqual(announcements.messages.count, 3)
        XCTAssertEqual(announcements.messages.first, L10n.brewTimerAnnounceStarted)
        XCTAssertEqual(
            announcements.messages.dropFirst().first,
            L10n.brewTimerAnnounceStopped(time: BrewTimerFormat.spoken(150, locale: english)),
            "the stop is announced with the brew time"
        )
        let stopped = announcements.messages.dropFirst().first ?? ""
        XCTAssertTrue(stopped.contains(BrewTimerFormat.spoken(150, locale: english)), "the format places the time: \(stopped)")
        XCTAssertFalse(stopped.contains("%@"), stopped)
        XCTAssertEqual(announcements.messages.last, L10n.brewTimerAnnounceReset)
        for (message, key) in zip(announcements.messages, ["brew.timer.announce.started", "brew.timer.announce.stopped_with_time", "brew.timer.announce.reset"]) {
            XCTAssertFalse(message.isEmpty)
            XCTAssertFalse(message.hasPrefix(key), "\(key) resolves to catalog text")
        }
    }

    func testTheReadoutShowsMinutesAndSecondsAndHoursFromOneHour() {
        let english = Locale(identifier: "en_US")
        XCTAssertEqual(BrewTimerFormat.readout(0, locale: english), "0:00")
        XCTAssertEqual(BrewTimerFormat.readout(30, locale: english), "0:30")
        XCTAssertEqual(BrewTimerFormat.readout(150, locale: english), "2:30")
        XCTAssertEqual(BrewTimerFormat.readout(3_723, locale: english), "1:02:03")
        XCTAssertEqual(BrewTimerFormat.readout(150, locale: Locale(identifier: "de_DE")), "2:30")
    }

    func testVoiceOverReadsTheTimeInWords() {
        let english = BrewTimerFormat.spoken(150, locale: Locale(identifier: "en_US"))
        XCTAssertTrue(english.contains("2"), english)
        XCTAssertTrue(english.contains("30"), english)
        XCTAssertTrue(english.localizedCaseInsensitiveContains("minute"), english)
        let german = BrewTimerFormat.spoken(150, locale: Locale(identifier: "de_DE"))
        XCTAssertTrue(german.localizedCaseInsensitiveContains("Minute"), german)
        XCTAssertNotEqual(english, german)
    }
}
