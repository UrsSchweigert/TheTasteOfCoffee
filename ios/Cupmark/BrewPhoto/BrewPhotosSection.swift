import Combine
import PhotosUI
import SwiftUI
import UIKit

/// The "Photos" section of a saved brew (M2-T42b, ADR 0033), in the rating screen of the brew:
/// small thumbnails, a delete button on each, and two ways to add one, both optional:
///
/// - the camera (`LabelPhotoCamera`, hidden without a camera; with access denied a Settings
///   link instead);
/// - the system photo picker (`PhotosPicker`, which runs out of process and needs no photo
///   library permission and no Info.plist key).
///
/// No captions, no text field. At 6 photos both add controls are disabled and the section says
/// why. Deleting asks first. Everything is a form row, so the section scrolls at every text size.
///
/// Taps to add a photo from the camera: "Take a Photo", the shutter, "Use Photo" (3). From the
/// library: "Choose from Library", the photo (2).
struct BrewPhotosSection: View {
    /// Owned by the screen, which also applies `brewPhotoPresentations(_:)` to its form: the
    /// camera and the confirmation are presented from one place, not from every row.
    let model: BrewPhotosModel
    @State private var pickedItem: PhotosPickerItem?
    @Environment(\.openURL) private var openURL
#if DEBUG
    @Environment(\.uiTestBrewPhotoPicker) private var uiTestPicker
#endif

    init(model: BrewPhotosModel) {
        self.model = model
    }

    var body: some View {
        if model.isOffered {
            Section {
                content
            } header: {
                Text(L10n.brewPhotosHeader)
                    .secondaryText()
            } footer: {
                Text(L10n.brewPhotosFooter)
                    .secondaryText()
            }
            .surfaceRow()
        }
    }

    @ViewBuilder
    private var content: some View {
        summary
        if model.items.isEmpty {
            Text(L10n.brewPhotosEmpty)
                .secondaryText()
                .accessibilityIdentifier("brew-photos-empty")
        }
        ForEach(model.items) { item in
            BrewPhotoRow(item: item, position: model.position(of: item), count: model.count) {
                model.requestDelete(item)
            }
        }
        addControls
        if model.isFull {
            Label {
                Text(verbatim: L10n.brewPhotosLimitReached(model.limit.formatted()))
            } icon: {
                Image(systemName: "info.circle")
                    .accessibilityHidden(true)
            }
            .font(.footnote)
            .secondaryText()
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("brew-photos-limit")
        }
        if model.isAdding {
            HStack(spacing: 12) {
                ProgressView()
                    .accessibilityHidden(true)
                Text(L10n.brewPhotosAdding)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("brew-photos-adding")
        }
        if let failure = model.failure {
            Label {
                Text(BrewPhotosSection.message(for: failure))
                    .font(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .accessibilityHidden(true)
            }
            .foregroundStyle(Theme.errorText)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("brew-photos-error")
        }
    }

    /// "2 of 6 photos", read as "Brew photos, 2 of 6".
    private var summary: some View {
        Text(verbatim: L10n.brewPhotosCount(model.count.formatted(), of: model.limit.formatted()))
            .accentText()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: L10n.brewPhotosSummary(model.count.formatted(), of: model.limit.formatted())))
            .accessibilityIdentifier("brew-photos-summary")
    }

    @ViewBuilder
    private var addControls: some View {
        if model.cameraAvailability == .available {
            Button {
                model.isCapturing = true
            } label: {
                Label {
                    Text(L10n.brewPhotosTake)
                } icon: {
                    Image(systemName: "camera")
                        .accessibilityHidden(true)
                }
            }
            .disabled(!model.canAdd)
            .accessibilityHint(addHint)
            .accessibilityIdentifier("brew-photo-take")
        } else if model.cameraAvailability == .permissionDenied {
            VStack(alignment: .leading, spacing: 8) {
                Text(L10n.brewPhotosPermissionDenied)
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
                .accessibilityIdentifier("brew-photo-settings")
            }
        }
        picker
    }

    /// The system picker. A Debug UI-test launch swaps it for a button that adds the fixture
    /// photo, since the out-of-process picker cannot be driven by the harness.
    @ViewBuilder
    private var picker: some View {
#if DEBUG
        if let uiTestPicker {
            Button {
                Task {
                    await model.addPicked { uiTestPicker.data() }
                }
            } label: {
                pickLabel
            }
            .disabled(!model.canAdd)
            .accessibilityHint(addHint)
            .accessibilityIdentifier("brew-photo-pick")
        } else {
            systemPicker
        }
#else
        systemPicker
#endif
    }

    private var systemPicker: some View {
        PhotosPicker(selection: $pickedItem, matching: .images) {
            pickLabel
        }
        .disabled(!model.canAdd)
        .accessibilityHint(addHint)
        .accessibilityIdentifier("brew-photo-pick")
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            Task {
                await model.addPicked { try await item.loadTransferable(type: Data.self) }
            }
        }
    }

    private var pickLabel: some View {
        Label {
            Text(L10n.brewPhotosPick)
        } icon: {
            Image(systemName: "photo.on.rectangle")
                .accessibilityHidden(true)
        }
    }

    /// Says why an add control is dimmed.
    private var addHint: Text {
        Text(verbatim: model.isFull ? L10n.brewPhotosLimitReached(model.limit.formatted()) : String())
    }

    static func message(for failure: BrewPhotosModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .unreadable: L10n.brewPhotosFailedUnreadable
        case .tooLarge: L10n.brewPhotosFailedTooLarge
        case .limitReached: L10n.brewPhotosFailedLimit
        case .brewNotFound: L10n.brewPhotosFailedBrewNotFound
        case .saveFailed: L10n.brewPhotosFailedSave
        }
    }
}

extension View {
    /// The presentations of the photos section, applied once to the screen's form: the camera,
    /// the delete confirmation, and the refresh when the screen appears and after every save of
    /// the store (a pull may have removed the brew).
    func brewPhotoPresentations(_ model: BrewPhotosModel) -> some View {
        modifier(BrewPhotoPresentations(model: model))
    }
}

private struct BrewPhotoPresentations: ViewModifier {
    @Bindable var model: BrewPhotosModel

    func body(content: Content) -> some View {
        content
            .onAppear {
                model.refresh()
            }
            .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
                model.refresh()
            }
            .fullScreenCover(isPresented: $model.isCapturing) {
                LabelPhotoCamera(
                    onCapture: { capture in
                        model.isCapturing = false
                        Task {
                            await model.add(capture)
                        }
                    },
                    onCancel: {
                        model.isCapturing = false
                    }
                )
                .ignoresSafeArea()
            }
            .confirmationDialog(L10n.brewPhotosDeleteTitle, isPresented: $model.isConfirmingDelete, titleVisibility: .visible) {
                Button(role: .destructive) {
                    model.confirmDelete()
                } label: {
                    Text(L10n.brewPhotosDeleteConfirm)
                }
                .accessibilityIdentifier("brew-photo-delete-confirm")
            } message: {
                Text(L10n.brewPhotosDeleteMessage)
            }
    }
}

/// One photo: its thumbnail and date, read as "Photo 2 of 3" with the date as the value, and a
/// delete button of at least 44 points. At accessibility text sizes the button moves under the
/// date.
private struct BrewPhotoRow: View {
    let item: BrewPhotosModel.Item
    let position: Int
    let count: Int
    let onDelete: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 64

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            HStack(spacing: 12) {
                BrewPhotoThumbnailView(url: item.fileURL, side: side)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.createdAt, format: DisplayDate.dayAndTime)
                        .font(.subheadline)
                    if item.fileURL == nil {
                        Text(L10n.brewPhotosFileMissing)
                            .font(.footnote)
                            .secondaryText()
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: L10n.brewPhotosItem(position.formatted(), of: count.formatted())))
            .accessibilityValue(Text(item.createdAt, format: DisplayDate.dayAndTime))
            .accessibilityIdentifier("brew-photo-thumbnail")
            if !dynamicTypeSize.isAccessibilitySize {
                Spacer(minLength: 0)
            }
            Button(role: .destructive) {
                onDelete()
            } label: {
                Label {
                    Text(L10n.brewPhotosDeleteShort)
                } icon: {
                    Image(systemName: "trash")
                        .accessibilityHidden(true)
                }
                .minimumTapTarget()
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(verbatim: L10n.brewPhotosDelete(position.formatted(), of: count.formatted())))
            .accessibilityIdentifier("brew-photo-delete")
        }
        .padding(.vertical, 2)
    }
}

/// A thumbnail made off the main actor (`BrewPhotoThumbnails`), a plain placeholder while it
/// loads or when the file is missing. Decorative: the row names the photo.
private struct BrewPhotoThumbnailView: View {
    let url: URL?
    let side: CGFloat
    @State private var thumbnail: BrewPhotoThumbnails.Thumbnail?

    var body: some View {
        Group {
            if let thumbnail {
                Image(decorative: thumbnail.image, scale: 1)
                    .resizable()
                    .scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Theme.surface)
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)
        .task(id: url) {
            guard let url else {
                thumbnail = nil
                return
            }
            thumbnail = await BrewPhotoThumbnails.load(url)
        }
    }
}
