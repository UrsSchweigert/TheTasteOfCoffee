import Foundation

/// When a retryable failure is sent again (M2-T16, ADR 0025): exponential backoff with
/// "equal jitter". After attempt `n` the wait is `d / 2 + jitter * d / 2`, where
/// `d = min(maximum, base * 2^(n - 1))` and `jitter` is in `0...1`. So the first retry waits
/// 1 to 2 s, the next 2 to 4 s, and no wait is longer than `maximum`. The jitter spreads the
/// retries of many phones that went offline together.
struct SyncBackoff: Equatable, Sendable {
    var base: TimeInterval = 2
    var maximum: TimeInterval = 300

    /// The wait after `attempt` failed sends (1 or more). `jitter` is clamped to `0...1`.
    func delay(afterAttempt attempt: Int, jitter: Double) -> TimeInterval {
        let exponent = Double(max(0, min(attempt - 1, 30)))
        let full = min(maximum, base * pow(2, exponent))
        let spread = min(1, max(0, jitter.isFinite ? jitter : 1))
        return full / 2 + spread * full / 2
    }
}
