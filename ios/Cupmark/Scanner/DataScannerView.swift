import AVFoundation
import SwiftUI
import Vision
import VisionKit

/// The symbologies the camera reads: EAN-13 only. VisionKit (like Vision) has no UPC-A
/// symbology: a UPC-A code is an EAN-13 whose first digit is 0, and VisionKit reports it under
/// `.ean13` as 13 digits with that leading 0. So `.ean13` reads both EAN-13 and UPC-A, and
/// `CanonicalBarcode` still accepts a 12-digit payload in case an OS version reports UPC-A
/// without the 0. EAN-8 and UPC-E are left out: the contract's `Barcode` is 12 or 13 digits.
@MainActor
enum ScannerSymbologies {
    static var recognized: Set<DataScannerViewController.RecognizedDataType> {
        [.barcode(symbologies: [VNBarcodeSymbology.ean13])]
    }
}

/// Asks VisionKit whether the device can scan (`isSupported`: false on the simulator and on
/// devices without the hardware) and whether it can scan now (`isAvailable`: false while camera
/// access is denied or restricted). Asks for camera access once if it was never asked.
@MainActor
struct LiveScannerEnvironment: ScannerEnvironment {
    func availability() async -> ScannerAvailability {
        guard DataScannerViewController.isSupported else { return .unavailable(.unsupported) }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                return .unavailable(.permissionDenied)
            }
        case .denied, .restricted:
            return .unavailable(.permissionDenied)
        @unknown default:
            return .unavailable(.notAvailable)
        }
        return DataScannerViewController.isAvailable ? .available : .unavailable(.notAvailable)
    }
}

/// The device's barcode source: `DataScannerView` forwards VisionKit's recognised barcodes
/// here, and `stop()` stops the camera. Reports raw payloads; `ScannerViewModel` checks them.
@MainActor
final class DataScannerBarcodeSource: BarcodeSource {
    let events: AsyncStream<BarcodeSourceEvent>
    private let continuation: AsyncStream<BarcodeSourceEvent>.Continuation
    private weak var scanner: DataScannerViewController?
    private(set) var isStopped = false

    init() {
        let (stream, continuation) = AsyncStream.makeStream(of: BarcodeSourceEvent.self)
        events = stream
        self.continuation = continuation
    }

    func attach(_ scanner: DataScannerViewController) {
        self.scanner = scanner
    }

    func report(_ event: BarcodeSourceEvent) {
        guard !isStopped else { return }
        continuation.yield(event)
    }

    func stop() {
        guard !isStopped else { return }
        isStopped = true
        scanner?.stopScanning()
        continuation.finish()
    }
}

/// VisionKit's `DataScannerViewController` for SwiftUI. Device only: show it only after
/// `LiveScannerEnvironment` answered `.available`.
struct DataScannerView: UIViewControllerRepresentable {
    let source: DataScannerBarcodeSource

    func makeCoordinator() -> Coordinator {
        Coordinator(source: source)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: ScannerSymbologies.recognized,
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        source.attach(scanner)
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !source.isStopped, !scanner.isScanning else { return }
        do {
            try scanner.startScanning()
        } catch {
            source.report(.unavailable)
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        coordinator.source.stop()
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let source: DataScannerBarcodeSource

        init(source: DataScannerBarcodeSource) {
            self.source = source
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue else { continue }
                source.report(.payload(payload))
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            source.report(.unavailable)
        }
    }
}
