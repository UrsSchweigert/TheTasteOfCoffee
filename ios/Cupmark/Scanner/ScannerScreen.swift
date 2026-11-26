import SwiftUI
import UIKit

/// F1 step 1: scan the barcode on the bag (M2-T13). Shows the VisionKit camera when it can run;
/// otherwise explains why and offers the pick-list entry and a link to Settings. It never
/// offers a way to type a barcode (invariant 1).
///
/// `onScanned` gets the first valid barcode, once (M2-T14 connects the lookup).
/// `onPickListEntry` opens the pick-list entry (`BeanEntryScreen`, M2-T22). The camera stops
/// while that screen covers the scanner.
struct ScannerScreen: View {
    @State private var model: ScannerViewModel
    @State private var source: DataScannerBarcodeSource?
    @Environment(\.openURL) private var openURL
    private let onPickListEntry: @MainActor () -> Void

    init(
        environment: any ScannerEnvironment = LiveScannerEnvironment(),
        onScanned: @escaping @MainActor (CanonicalBarcode) -> Void,
        onPickListEntry: @escaping @MainActor () -> Void
    ) {
        _model = State(initialValue: ScannerViewModel(environment: environment, onScanned: onScanned))
        self.onPickListEntry = onPickListEntry
    }

    var body: some View {
        content
            .navigationTitle(Text(L10n.scannerTitle))
            .navigationBarTitleDisplayMode(.inline)
            .task { await run() }
            .onDisappear {
                // Another screen pushed over the scanner (the pick-list entry, M2-T22) only
                // hides it, so VisionKit would keep the camera running. The cancelled `.task`
                // stops the source as well; `stop()` is idempotent. Coming back starts a new run
                // with a new source.
                source?.stop()
            }
    }

    /// Checks availability, then reads a fresh source until the first valid code. A new source
    /// per run, because a cancelled run (the screen left) finishes the old source's stream.
    private func run() async {
        await model.checkAvailability()
        guard model.state == .scanning else { return }
        let source = DataScannerBarcodeSource()
        self.source = source
        await model.consume(source)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .checking:
            ProgressView()
                .accessibilityLabel(Text(L10n.scannerChecking))
        case .scanning:
            scanning
        case .unavailable(let reason):
            // Scrolls at the largest text sizes instead of cutting off the message (M2-T33).
            FitsOrScrolls {
                ContentUnavailableView {
                    Label {
                        Text(Self.title(for: reason))
                    } icon: {
                        Image(systemName: "camera.fill")
                            .accessibilityHidden(true)
                    }
                } description: {
                    Text(Self.message(for: reason))
                } actions: {
                    pickListButton
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    settingsButton
                }
            }
        case .scanned(let barcode):
            ContentUnavailableView {
                Label {
                    Text(L10n.scannerScannedTitle)
                } icon: {
                    Image(systemName: "checkmark.circle")
                        .accessibilityHidden(true)
                }
            } description: {
                // Digits only, checked by CanonicalBarcode; not translatable text.
                Text(verbatim: barcode.digits)
            }
        }
    }

    private var scanning: some View {
        ZStack(alignment: .bottom) {
            if let source {
                DataScannerView(source: source)
                    .id(ObjectIdentifier(source))
                    .ignoresSafeArea()
                    .accessibilityLabel(Text(L10n.scannerCameraAccessibility))
            }
            VStack(spacing: 12) {
                Text(L10n.scannerHint)
                    .font(.body)
                    .multilineTextAlignment(.center)
                pickListButton
                    .buttonStyle(.bordered)
            }
            .padding()
            .frame(maxWidth: .infinity)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding()
        }
    }

    private var pickListButton: some View {
        Button {
            onPickListEntry()
        } label: {
            Label {
                Text(L10n.scannerPickListEntry)
            } icon: {
                Image(systemName: "list.bullet")
                    .accessibilityHidden(true)
            }
        }
        .accessibilityIdentifier("scanner-pick-list")
    }

    private var settingsButton: some View {
        Button {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            openURL(url)
        } label: {
            Label {
                Text(L10n.scannerOpenSettings)
            } icon: {
                Image(systemName: "gear")
                    .accessibilityHidden(true)
            }
            .minimumTapTarget()
        }
    }

    private static func title(for reason: ScannerUnavailableReason) -> LocalizedStringKey {
        switch reason {
        case .unsupported: L10n.scannerUnsupportedTitle
        case .permissionDenied: L10n.scannerPermissionDeniedTitle
        case .notAvailable: L10n.scannerNotAvailableTitle
        }
    }

    private static func message(for reason: ScannerUnavailableReason) -> LocalizedStringKey {
        switch reason {
        case .unsupported: L10n.scannerUnsupportedMessage
        case .permissionDenied: L10n.scannerPermissionDeniedMessage
        case .notAvailable: L10n.scannerNotAvailableMessage
        }
    }
}
