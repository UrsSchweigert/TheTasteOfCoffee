import Foundation
import Observation
import UIKit

/// The brew timer's state (M2-T21, docs/04 Input model "Timer", F2 brew time): nothing more
/// than the instant it was started, read from a monotonic clock.
///
/// The elapsed time is always `now - start`, computed when it is read, never counted up by
/// ticks. So the timer keeps counting while the app is in the background or the phone is
/// locked: nothing has to run meanwhile. `ContinuousClock` keeps advancing while the device
/// sleeps and does not jump when the user or the network changes the wall clock.
struct BrewTimer: Equatable, Sendable {
    /// When the running timer was started; nil while it is not running.
    private(set) var startedAt: ContinuousClock.Instant?

    var isRunning: Bool {
        startedAt != nil
    }

    /// Starts the timer at `instant`. A running timer keeps its start; returns whether it
    /// started.
    @discardableResult
    mutating func start(at instant: ContinuousClock.Instant) -> Bool {
        guard startedAt == nil else {
            return false
        }
        startedAt = instant
        return true
    }

    /// Stops the timer at `instant` and returns the time it ran, nil if it was not running.
    mutating func stop(at instant: ContinuousClock.Instant) -> Duration? {
        guard startedAt != nil else {
            return nil
        }
        let elapsed = self.elapsed(at: instant)
        startedAt = nil
        return elapsed
    }

    /// Stops the timer without a result.
    mutating func reset() {
        startedAt = nil
    }

    /// The time since the start, zero while the timer is not running (and never negative).
    func elapsed(at instant: ContinuousClock.Instant) -> Duration {
        guard let startedAt else {
            return .zero
        }
        let elapsed = startedAt.duration(to: instant)
        return elapsed > .zero ? elapsed : .zero
    }
}

extension Duration {
    /// The duration in seconds, with its fraction.
    var secondsWithFraction: Double {
        let parts = components
        return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
    }

    /// Whole seconds, rounded down (the readout never shows a second that has not passed).
    var wholeSeconds: Int {
        Int(clamping: components.seconds)
    }
}

extension BrewDraft {
    /// The vocabulary range of `brew_time_s` (brew.ranges.brew_time_s): the only place the
    /// brew timer reads its bounds.
    static var brewTimeRange: VocabularyRange {
        Vocabulary.Ranges.brewTimeS
    }

    /// `brew_time_s` for a timed brew: the whole seconds of `elapsed`, moved into the
    /// vocabulary range and onto its step. A stop within the first second is the minimum; a
    /// timer left running past the maximum is the maximum.
    static func brewTimeS(for elapsed: Duration) -> API.BrewTimeS? {
        brewTimeRange
            .snapped(Double(elapsed.wholeSeconds))
            .flatMap { seconds in API.scaledInteger(seconds, scale: 1) }
    }

    /// Sets `brew_time_s` from a timed brew (whole seconds, clamped), or clears it for nil.
    mutating func setBrewTime(_ elapsed: Duration?) {
        setBrewTime(seconds: elapsed.flatMap { duration in BrewDraft.brewTimeS(for: duration) })
    }
}

/// The brew timer of the brew form (M2-T21): start, stop and reset, with VoiceOver
/// announcements of start, stop and reset.
///
/// The clock is injected; the app uses `ContinuousClock.now`. The model holds no tick and no
/// task: a view that shows the running time redraws on its own schedule (`TimelineView`) and
/// reads `elapsed()` each time.
@MainActor
@Observable
final class BrewTimerModel {
    private(set) var timer = BrewTimer()

    private let now: @MainActor () -> ContinuousClock.Instant
    private let announce: @MainActor (String) -> Void

    init(
        now: @escaping @MainActor () -> ContinuousClock.Instant = { ContinuousClock.now },
        announce: @escaping @MainActor (String) -> Void = { message in BrewTimerModel.postAnnouncement(message) }
    ) {
        self.now = now
        self.announce = announce
    }

    var isRunning: Bool {
        timer.isRunning
    }

    /// The running time now, zero while the timer is not running.
    func elapsed() -> Duration {
        timer.elapsed(at: now())
    }

    /// Starts the timer, if it is not running, and announces it.
    func start() {
        guard timer.start(at: now()) else {
            return
        }
        announce(L10n.brewTimerAnnounceStarted)
    }

    /// Stops a running timer and returns `brew_time_s` for it, clamped to its vocabulary
    /// range, nil if the timer was not running. Announces the stop with the brew time.
    func stop(locale: Locale = .current) -> API.BrewTimeS? {
        guard let elapsed = timer.stop(at: now()), let seconds = BrewDraft.brewTimeS(for: elapsed) else {
            return nil
        }
        announce(L10n.brewTimerAnnounceStopped(time: BrewTimerFormat.spoken(seconds, locale: locale)))
        return seconds
    }

    /// Stops the timer without a result and announces the reset.
    func reset() {
        timer.reset()
        announce(L10n.brewTimerAnnounceReset)
    }

    /// Posts `message` to VoiceOver, queued after what VoiceOver is saying (the label of the
    /// button that was just tapped), so it is not cut off.
    static func postAnnouncement(_ message: String) {
        let queued = NSAttributedString(string: message, attributes: [.accessibilitySpeechQueueAnnouncement: true])
        UIAccessibility.post(notification: .announcement, argument: queued)
    }
}

/// How the brew timer writes a time: the device locale's digits and separators, and the
/// locale's unit words for VoiceOver, so no unit text is written here.
enum BrewTimerFormat {
    private static let secondsPerHour = 3_600

    /// The readout: minutes and seconds (`2:30`), with hours from one hour on (`1:02:03`).
    static func readout(_ seconds: Int, locale: Locale = .current) -> String {
        let pattern: Duration.TimeFormatStyle.Pattern = seconds >= secondsPerHour ? .hourMinuteSecond : .minuteSecond
        let style = Duration.TimeFormatStyle(pattern: pattern).locale(locale)
        return style.format(.seconds(max(seconds, 0)))
    }

    /// What VoiceOver reads: the time in words (`2 minutes, 30 seconds`).
    static func spoken(_ seconds: Int, locale: Locale = .current) -> String {
        let style = Duration.UnitsFormatStyle(allowedUnits: [.hours, .minutes, .seconds], width: .wide).locale(locale)
        return style.format(.seconds(max(seconds, 0)))
    }
}
