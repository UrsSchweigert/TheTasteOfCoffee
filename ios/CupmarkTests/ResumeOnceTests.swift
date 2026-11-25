import XCTest
@testable import Cupmark

/// `ResumeOnce`, the guard that keeps the web sign-in from resuming its continuation twice
/// (when `start()` returns false and the completion handler also fires).
final class ResumeOnceTests: XCTestCase {
    func testOnlyTheFirstResumeCounts() async throws {
        let calls = ResumeCalls()
        let url = try XCTUnwrap(URL(string: "cupmark://auth?code=a&state=b"))
        let value: URL = try await withCheckedThrowingContinuation { continuation in
            let once = ResumeOnce(continuation)
            calls.record(once.resume(.success(url)))
            calls.record(once.resume(.failure(AuthError.couldNotStart)))
            calls.record(once.resume(.success(url)))
        }
        XCTAssertEqual(value, url)
        XCTAssertEqual(calls.results, [true, false, false])
    }

    func testAFirstFailureWins() async {
        do {
            let _: URL = try await withCheckedThrowingContinuation { continuation in
                let once = ResumeOnce(continuation)
                once.resume(.failure(AuthError.couldNotStart))
                once.resume(.failure(AuthError.cancelled))
            }
            XCTFail("expected couldNotStart")
        } catch {
            XCTAssertEqual(error as? AuthError, .couldNotStart)
        }
    }
}

private final class ResumeCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Bool] = []

    var results: [Bool] {
        lock.withLock { recorded }
    }

    func record(_ result: Bool) {
        lock.withLock { recorded.append(result) }
    }
}
