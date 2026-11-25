import Foundation
import Observation

/// What a barcode source reports: a raw payload, or that the camera stopped being usable.
enum BarcodeSourceEvent: Sendable, Equatable {
    case payload(String)
    case unavailable
}

/// Something that reports scanned barcode payloads: the VisionKit scanner on a device
/// (`DataScannerBarcodeSource`), a fake in tests.
@MainActor
protocol BarcodeSource: AnyObject {
    /// The reports, in order. Iterated once.
    var events: AsyncStream<BarcodeSourceEvent> { get }
    /// Stops scanning: after the first valid code, when the camera becomes unavailable, and
    /// when the screen's run is cancelled or the screen disappears. May be called more than
    /// once; calls after the first do nothing.
    func stop()
}

/// Why the camera scan cannot be offered. Every case offers the pick-list entry and Settings.
enum ScannerUnavailableReason: Sendable, Equatable {
    /// The device cannot scan at all (no camera, an older chip, the simulator).
    case unsupported
    /// Camera access was denied or is restricted.
    case permissionDenied
    /// Supported and permitted, but not usable now (for example the camera is in use).
    case notAvailable
}

enum ScannerAvailability: Sendable, Equatable {
    case available
    case unavailable(ScannerUnavailableReason)
}

/// Answers whether the camera scan can run. `LiveScannerEnvironment` asks VisionKit and
/// AVFoundation; tests use a fake.
@MainActor
protocol ScannerEnvironment {
    /// May ask for camera permission once, if it was never asked.
    func availability() async -> ScannerAvailability
}

/// The scanner screen's logic, without VisionKit: checks availability, then consumes a
/// `BarcodeSource`, ignores every invalid payload, and reports the first valid barcode once.
@MainActor
@Observable
final class ScannerViewModel {
    enum State: Equatable {
        case checking
        case scanning
        case unavailable(ScannerUnavailableReason)
        case scanned(CanonicalBarcode)
    }

    private(set) var state: State = .checking

    private let environment: any ScannerEnvironment
    private let onScanned: @MainActor (CanonicalBarcode) -> Void
    @ObservationIgnored private var session = BarcodeScanSession()

    /// `onScanned` is called at most once per model, with the first valid barcode.
    init(environment: any ScannerEnvironment, onScanned: @escaping @MainActor (CanonicalBarcode) -> Void) {
        self.environment = environment
        self.onScanned = onScanned
    }

    /// Moves from `checking` to `scanning` or `unavailable`. Does nothing in any other state.
    func checkAvailability() async {
        guard state == .checking else { return }
        let availability = await environment.availability()
        guard state == .checking else { return }
        switch availability {
        case .available:
            state = .scanning
        case .unavailable(let reason):
            state = .unavailable(reason)
        }
    }

    /// Reads `source` until the first valid barcode, then stops the source and reports the
    /// barcode. Returns when that happens, when the source becomes unavailable, when its
    /// stream ends, or when the calling task is cancelled.
    ///
    /// A cancelled run stops the source too (M2-T22): the screen's `.task` is cancelled when
    /// another screen, such as the pick-list entry, is pushed over the scanner, and the camera
    /// must not keep running off screen. A stream that simply ends is not stopped again.
    func consume(_ source: any BarcodeSource) async {
        guard state == .scanning else { return }
        defer {
            // Cancelling the task ends the `for await` below with no event, so this is the
            // only place that sees the cancellation. `stop()` is idempotent on the device
            // source, and the screen's `.onDisappear` may call it as well.
            if Task.isCancelled, state == .scanning {
                source.stop()
            }
        }
        for await event in source.events {
            switch event {
            case .payload(let payload):
                guard let barcode = session.accept(payload) else { continue }
                state = .scanned(barcode)
                source.stop()
                onScanned(barcode)
                return
            case .unavailable:
                state = .unavailable(.notAvailable)
                source.stop()
                return
            }
        }
    }
}
