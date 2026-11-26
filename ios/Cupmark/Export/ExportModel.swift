import Foundation
import Observation

/// The part of the API the export needs. `APIClient` is the live one.
protocol ExportSource: Sendable {
    /// `GET /export`: the CSV bytes as received.
    func exportData() async throws -> Data
}

extension APIClient: ExportSource {}

/// What the export needs of the outbox (M2-T30): to send what it can, and to say whether
/// changes are still waiting afterwards.
struct ExportOutbox {
    /// Sends the outbox now. `SyncEngine.drain()` in the app.
    var drain: @MainActor () async -> SyncEngine.DrainResult
    /// The number of operations still in the outbox, parked ones included; they are not on
    /// the server, so they are not in the file. Throws when the store cannot be read.
    var pendingChanges: @MainActor () throws -> Int

    @MainActor
    static func live(engine: SyncEngine, store: AccountStore) -> ExportOutbox {
        ExportOutbox(
            drain: { await engine.drain() },
            pendingChanges: { try store.outboxOperations().count }
        )
    }
}

/// Settings, then Export (M2-T30, ADR 0017, docs/05 Security, Export):
///
/// 1. tries to send the outbox (`ExportOutbox.drain`); changes that are still waiting are not
///    on the server, so the screen says they are not in the file;
/// 2. calls `GET /export`;
/// 3. writes the bytes unchanged to a temporary `cupmark-export-<YYYY-MM-DD>.csv`
///    (`ExportFileStore`) and offers it, which the screen does with `ShareLink`;
/// 4. deletes the file when the user is done (`discardFile()`, also when the screen goes away,
///    and the next `export()` clears whatever an earlier run left).
///
/// Nothing is typed, and nothing but the one request is sent. The request carries no user id.
@MainActor
@Observable
final class ExportModel {
    /// Why an export did not produce a file. Each has its own localised message.
    enum Failure: Equatable, Sendable {
        /// No network (a transport failure).
        case offline
        /// A 500: the export is over the size limit of 5 MiB (docs/05), which has no
        /// asynchronous version yet.
        case tooLarge
        /// A 401 after the token refresh: the user has to sign in again.
        case signInRequired
        /// A 429.
        case tooManyRequests
        /// Any other 5xx, a 503, or an answer the app cannot use: try again later.
        case unavailable
        /// The file could not be written.
        case fileNotWritten
    }

    /// A file the user can share.
    struct ReadyFile: Equatable, Sendable {
        let url: URL
        /// True when changes were still waiting in the outbox after the drain, or the outbox
        /// could not be read: they are not in the file.
        let hasPendingChanges: Bool
    }

    enum State: Equatable, Sendable {
        case idle
        /// Sending the outbox and loading the file.
        case preparing
        case ready(ReadyFile)
        case failed(Failure)
    }

    private(set) var state: State = .idle

    private let source: any ExportSource
    private let outbox: ExportOutbox
    private let files: ExportFileStore
    private let now: @Sendable () -> Date
    private let calendar: Calendar
    private let sleep: @Sendable (TimeInterval) async throws -> Void

    /// How often a drain that finds another drain running is asked again, a second apart.
    static let busyRetries = 5

    init(
        source: any ExportSource,
        outbox: ExportOutbox,
        files: ExportFileStore = ExportFileStore(),
        now: @escaping @Sendable () -> Date = { Date() },
        calendar: Calendar = .current,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in try await Task.sleep(for: .seconds(seconds)) }
    ) {
        self.source = source
        self.outbox = outbox
        self.files = files
        self.now = now
        self.calendar = calendar
        self.sleep = sleep
    }

    var isPreparing: Bool { state == .preparing }

    /// Runs the three steps. Ignored while one is running. A file from an earlier run is
    /// deleted first.
    func export() async {
        guard state != .preparing else {
            return
        }
        discardFile()
        // Also a file an ended app left behind. Not done in `init`: SwiftUI may build a model
        // more than once, and that must never delete a file that is being shared.
        files.removeAll()
        state = .preparing
        await drainOutbox()
        let data: Data
        do {
            data = try await source.exportData()
        } catch is CancellationError {
            state = .idle
            return
        } catch let error as APIError {
            state = .failed(ExportModel.failure(for: error))
            return
        } catch {
            state = .failed(.unavailable)
            return
        }
        guard !Task.isCancelled else {
            state = .idle
            return
        }
        let pending = ((try? outbox.pendingChanges()) ?? 1) > 0
        do {
            let url = try files.write(data, on: now(), calendar: calendar)
            state = .ready(ReadyFile(url: url, hasPendingChanges: pending))
        } catch {
            state = .failed(.fileNotWritten)
        }
    }

    /// Deletes the temporary file, if there is one, and goes back to the start. Called when
    /// the user is done and when the screen goes away.
    func discardFile() {
        if case .ready(let file) = state {
            files.remove(file.url)
        }
        if state != .preparing {
            state = .idle
        }
    }

    /// Sends the outbox once, and again after a second while another drain is running (the
    /// sync engine's own loop). A backing-off, stopped or sign-in-required engine is not
    /// waited for: what is left is reported as pending.
    private func drainOutbox() async {
        for attempt in 0...ExportModel.busyRetries {
            guard await outbox.drain() == .busy, attempt < ExportModel.busyRetries else {
                return
            }
            do {
                try await sleep(1)
            } catch {
                return
            }
        }
    }

    /// The message for a failed `GET /export`.
    static func failure(for error: APIError) -> Failure {
        switch error {
        case .transport:
            return .offline
        case .server(status: 500):
            return .tooLarge
        case .unauthorized:
            return .signInRequired
        case .tooManyRequests:
            return .tooManyRequests
        case .serviceUnavailable, .server, .badRequest, .notFound, .conflict, .unexpectedStatus,
             .undecodable, .invalidResponse, .invalidRequest:
            return .unavailable
        }
    }
}
