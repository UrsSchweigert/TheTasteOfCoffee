import SwiftUI
import UIKit

/// The label photos of a saved, unverified bean (M2-T24), as a section of `BeanDetailView`:
/// each photo with its upload state, Retake, Try Again or Remove where they apply, and "Add a
/// Label Photo" while fewer than 3 are there. Camera only, no photo library.
///
/// Taps for another photo: "Add a Label Photo", the shutter, "Use Photo" (3); the upload starts
/// by itself.
struct LabelPhotoUploadSection: View {
    let model: LabelPhotoUploadModel
    let availability: LabelPhotoCameraAvailability

    @State private var isCapturing = false
    /// The photo a capture replaces; nil adds a new one.
    @State private var retakeID: UUID?
    @Environment(\.openURL) private var openURL

    init(model: LabelPhotoUploadModel, availability: LabelPhotoCameraAvailability) {
        self.model = model
        self.availability = availability
    }

    var body: some View {
        if availability != .unavailable || !model.photos.isEmpty {
            Section {
                ForEach(model.photos) { photo in
                    row(photo)
                }
                footerContent
            } header: {
                Text(L10n.labelPhotoUploadsHeader)
                    .secondaryText()
            } footer: {
                Text(L10n.labelPhotoUploadsFooter)
                    .secondaryText()
            }
            .surfaceRow()
            .accessibilityIdentifier("label-photo-uploads")
            .fullScreenCover(isPresented: $isCapturing) {
                LabelPhotoCamera(
                    onCapture: { capture in
                        isCapturing = false
                        let target = retakeID
                        retakeID = nil
                        Task {
                            if let target {
                                await model.retake(target, with: capture)
                            } else {
                                await model.add(capture)
                            }
                        }
                    },
                    onCancel: {
                        isCapturing = false
                        retakeID = nil
                    }
                )
                .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private var footerContent: some View {
        if model.noMorePhotos {
            notice(L10n.labelPhotoNoMorePhotos, systemImage: "checkmark.circle", identifier: "label-photo-no-more")
        } else if model.dailyLimitReached {
            notice(L10n.labelPhotoDailyLimit, systemImage: "clock", identifier: "label-photo-daily-limit")
        } else if model.canAddPhoto {
            switch availability {
            case .available:
                Button {
                    retakeID = nil
                    isCapturing = true
                } label: {
                    Label {
                        Text(model.photos.isEmpty ? L10n.labelPhotoTake : L10n.labelPhotoAddAnother)
                    } icon: {
                        Image(systemName: "camera")
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("label-photo-add")
            case .permissionDenied:
                permissionDenied
            case .unavailable:
                EmptyView()
            }
        }
    }

    private func row(_ photo: LabelPhotoUploadModel.Photo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                thumbnail(photo)
                VStack(alignment: .leading, spacing: 4) {
                    Text(LabelPhotoUploadSection.title(for: photo.status))
                        .font(.headline)
                    if let message = LabelPhotoUploadSection.message(for: photo.status) {
                        Text(message)
                            .font(.footnote)
                            .secondaryText()
                    }
                }
                Spacer(minLength: 0)
                if photo.status == .preparing || photo.status == .uploading {
                    ProgressView()
                        .accessibilityHidden(true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("label-photo-status")
            actions(photo)
        }
    }

    @ViewBuilder
    private func thumbnail(_ photo: LabelPhotoUploadModel.Photo) -> some View {
        if let preview = photo.preview {
            Image(preview, scale: 1, label: Text(L10n.labelPhotoAttachedAccessibility))
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: "photo")
                .font(.title2)
                .frame(width: 56, height: 56)
                .accessibilityLabel(Text(L10n.labelPhotoAttachedAccessibility))
        }
    }

    @ViewBuilder
    private func actions(_ photo: LabelPhotoUploadModel.Photo) -> some View {
        HStack(spacing: 16) {
            if LabelPhotoUploadModel.canRetry(photo.status) {
                Button {
                    model.retry(photo.id)
                } label: {
                    Label {
                        Text(L10n.lookupRetry)
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                            .accessibilityHidden(true)
                    }
                    .minimumTapTarget()
                }
                .accessibilityIdentifier("label-photo-retry")
            }
            if LabelPhotoUploadModel.canRetake(photo.status), availability == .available {
                Button {
                    retakeID = photo.id
                    isCapturing = true
                } label: {
                    Label {
                        Text(L10n.labelPhotoRetake)
                    } icon: {
                        Image(systemName: "camera")
                            .accessibilityHidden(true)
                    }
                    .minimumTapTarget()
                }
                .accessibilityIdentifier("label-photo-retake")
            }
            if LabelPhotoUploadModel.canRemove(photo.status) {
                Button(role: .destructive) {
                    model.remove(photo.id)
                } label: {
                    Label {
                        Text(L10n.labelPhotoRemove)
                    } icon: {
                        Image(systemName: "trash")
                            .accessibilityHidden(true)
                    }
                    .minimumTapTarget()
                }
                .accessibilityIdentifier("label-photo-remove")
            }
        }
        // Several buttons in one list row: borderless, so each takes its own taps, each at
        // least 44 points (M2-T33).
        .buttonStyle(.borderless)
        .font(.subheadline)
    }

    private func notice(_ text: LocalizedStringKey, systemImage: String, identifier: String) -> some View {
        Label {
            Text(text)
                .font(.footnote)
        } icon: {
            Image(systemName: systemImage)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
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

    static func title(for status: LabelPhotoUploadModel.Status) -> LocalizedStringKey {
        switch status {
        case .preparing: L10n.labelPhotoPreparing
        case .encodingFailed: L10n.labelPhotoFailedTitle
        case .uploading: L10n.labelPhotoUploading
        case .uploaded: L10n.labelPhotoUploaded
        case .rejected: L10n.labelPhotoRejectedTitle
        case .notAccepted, .dailyLimitReached: L10n.labelPhotoNotUploaded
        case .signInRequired: L10n.signInAgainTitle
        case .failed: L10n.labelPhotoUploadFailedTitle
        }
    }

    static func message(for status: LabelPhotoUploadModel.Status) -> LocalizedStringKey? {
        switch status {
        case .preparing, .uploading: nil
        case .uploaded: L10n.labelPhotoUploadedMessage
        case .encodingFailed: L10n.labelPhotoFailedMessage
        case .rejected: L10n.labelPhotoRejectedMessage
        case .notAccepted: L10n.labelPhotoNoMorePhotos
        case .dailyLimitReached: L10n.labelPhotoDailyLimit
        case .signInRequired: L10n.labelPhotoSignInMessage
        case .failed: L10n.labelPhotoUploadFailedMessage
        }
    }
}
