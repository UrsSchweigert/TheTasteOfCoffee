import SwiftUI
import UIKit

/// The label photo step of the bean entry form (M2-T23, F1 step 4): photograph the label with
/// the camera, see the result, retake or remove it. Hidden when the device has no camera;
/// with camera access denied it offers Settings. Camera only, no photo library.
///
/// Taps for the optional photo: "Photograph the Label", the shutter, "Use Photo" (3).
struct LabelPhotoSection: View {
    let draft: LabelPhotoDraft
    let availability: LabelPhotoCameraAvailability

    @State private var isCapturing = false
    @Environment(\.openURL) private var openURL

    init(draft: LabelPhotoDraft, availability: LabelPhotoCameraAvailability) {
        self.draft = draft
        self.availability = availability
    }

    var body: some View {
        if availability != .unavailable {
            Section {
                content
            } header: {
                Text(L10n.labelPhotoHeader)
                    .secondaryText()
            } footer: {
                Text(L10n.labelPhotoFooter)
                    .secondaryText()
            }
            .surfaceRow()
            .fullScreenCover(isPresented: $isCapturing) {
                LabelPhotoCamera(
                    onCapture: { capture in
                        isCapturing = false
                        Task {
                            await draft.attach(capture)
                        }
                    },
                    onCancel: {
                        isCapturing = false
                    }
                )
                .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch draft.state {
        case .empty:
            if availability == .permissionDenied {
                permissionDenied
            } else {
                captureButton(L10n.labelPhotoTake, identifier: "label-photo-take")
            }
        case .preparing:
            HStack(spacing: 12) {
                ProgressView()
                    .accessibilityHidden(true)
                Text(L10n.labelPhotoPreparing)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("label-photo-preparing")
        case .attached(let prepared):
            preview(prepared)
            if availability == .available {
                captureButton(L10n.labelPhotoRetake, identifier: "label-photo-retake")
            }
            Button(role: .destructive) {
                draft.remove()
            } label: {
                Label {
                    Text(L10n.labelPhotoRemove)
                } icon: {
                    Image(systemName: "trash")
                        .accessibilityHidden(true)
                }
            }
            .accessibilityIdentifier("label-photo-remove")
        case .failed:
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.labelPhotoFailedTitle)
                        .font(.headline)
                    Text(L10n.labelPhotoFailedMessage)
                        .font(.footnote)
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("label-photo-error")
            if availability == .available {
                captureButton(L10n.labelPhotoRetake, identifier: "label-photo-retake")
            } else {
                permissionDenied
            }
        }
    }

    @ViewBuilder
    private func preview(_ prepared: PreparedLabelPhoto) -> some View {
        if let preview = prepared.preview {
            Image(preview, scale: 1, label: Text(L10n.labelPhotoAttachedAccessibility))
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("label-photo-preview")
        } else {
            Label {
                Text(L10n.labelPhotoAttachedAccessibility)
            } icon: {
                Image(systemName: "photo")
                    .accessibilityHidden(true)
            }
            .accessibilityIdentifier("label-photo-preview")
        }
    }

    private func captureButton(_ title: LocalizedStringKey, identifier: String) -> some View {
        Button {
            isCapturing = true
        } label: {
            Label {
                Text(title)
            } icon: {
                Image(systemName: "camera")
                    .accessibilityHidden(true)
            }
        }
        .accessibilityIdentifier(identifier)
    }

    private var permissionDenied: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.labelPhotoPermissionDenied)
                .font(.footnote)
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
            }
            .accessibilityIdentifier("label-photo-settings")
        }
    }
}
