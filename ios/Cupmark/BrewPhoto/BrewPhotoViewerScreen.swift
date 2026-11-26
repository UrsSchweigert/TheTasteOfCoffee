import Combine
import SwiftUI

/// The brew photo viewer (M2-T43b, ADR 0033), pushed from the gallery by `BrewPhotoRoute`: the
/// photo as large as the screen, the brew's key details, links to the brew, its bag and a
/// recipe, and delete. Registered at the stack root with the other routes (`ShelfScreen`).
///
/// - A list, so everything scrolls and the details wrap at the largest text size. Nothing
///   depends on a drag or a pinch: every action is a button or a link (invariant 1: nothing is
///   typed either).
/// - VoiceOver reads the photo with the label of its cell in the gallery (method, bag and date).
///   Each detail is one element, "Dose, 18.0 g"; each link and the delete button has a label and
///   a hint.
/// - Links go through value routes registered at the stack root: the brew
///   (`BrewRatingRoute`, its rating screen with the photos section), its bag (`ShelfEntryRoute`,
///   not shown for a brew without one) and the saved recipe with the brew's values
///   (`BrewRecipeRoute`, not shown without a match).
/// - Delete asks first (buttons only), deletes the file and the record, and goes back to the
///   gallery, which reads the store again. The brew is not touched.
///
/// Taps from the shelf: the gallery button, the photo (2). To the brew, bag or recipe: one more.
/// Delete: the button and the confirmation (2).
struct BrewPhotoViewerScreen: View {
    @State private var model: BrewPhotoViewerModel
    @State private var loaded: BrewPhotoThumbnails.Loaded?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    /// The longest side of the picture shown, in pixels: larger than any iPhone screen.
    private static let pixels = 2048

    init(store: AccountStore, photo photoID: UUID, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: BrewPhotoViewerModel(store: store, photo: photoID, vocabulary: vocabulary, language: language))
    }

    var body: some View {
        List {
            if let content = model.content {
                photoSection(content)
                detailsSection(content)
                linksSection(content)
                deleteSection
            } else if model.loadFailed {
                Text(L10n.shelfStoreErrorTitle)
                    .secondaryText()
                    .surfaceRow()
            } else if model.isGone {
                Text(L10n.galleryViewerNotFound)
                    .secondaryText()
                    .surfaceRow()
                    .accessibilityIdentifier("gallery-viewer-not-found")
            }
        }
        .listBackground()
        .navigationTitle(Text(L10n.viewerTitle))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(L10n.brewPhotosDeleteTitle, isPresented: $model.isConfirmingDelete, titleVisibility: .visible) {
            Button(role: .destructive) {
                model.confirmDelete()
            } label: {
                Text(L10n.brewPhotosDeleteConfirm)
            }
            .accessibilityIdentifier("viewer-delete-confirm")
        } message: {
            Text(L10n.brewPhotosDeleteMessage)
        }
        .onAppear {
            model.reload()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.reload()
            }
        }
        .onChange(of: model.isDeleted) { _, deleted in
            if deleted {
                dismiss()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }

    // MARK: - Parts

    private func photoSection(_ content: BrewPhotoViewerContent) -> some View {
        Section {
            ZStack {
                if let loaded, loaded.url == content.fileURL {
                    Image(decorative: loaded.thumbnail.image, scale: 1)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                } else if content.fileURL == nil {
                    Text(L10n.brewPhotosFileMissing)
                        .secondaryText()
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: content.accessibilityLabel))
            .accessibilityAddTraits(.isImage)
            .accessibilityIdentifier("gallery-viewer-photo")
            .task(id: content.fileURL) {
                loaded = await BrewPhotoThumbnails.updated(loaded, for: content.fileURL, maxPixelSize: BrewPhotoViewerScreen.pixels)
            }
        }
        .surfaceRow()
    }

    private func detailsSection(_ content: BrewPhotoViewerContent) -> some View {
        Section {
            ForEach(content.details) { detail in
                BrewPhotoViewerDetailRow(detail: detail)
            }
        } header: {
            Text(L10n.viewerDetailsHeader)
                .secondaryText()
        }
        .surfaceRow()
    }

    private func linksSection(_ content: BrewPhotoViewerContent) -> some View {
        Section {
            NavigationLink(value: BrewRatingRoute(brewLocalID: content.brewLocalID)) {
                Text(L10n.viewerLinkBrew)
                    .minimumTapTarget()
            }
            .accessibilityHint(Text(L10n.viewerLinkBrewHint))
            .accessibilityIdentifier("viewer-link-brew")
            if let shelfEntryID = content.shelfEntryID {
                NavigationLink(value: ShelfEntryRoute(localID: shelfEntryID)) {
                    Text(L10n.viewerLinkBag)
                        .minimumTapTarget()
                }
                .accessibilityHint(Text(L10n.viewerLinkBagHint))
                .accessibilityIdentifier("viewer-link-bag")
            }
            if let recipeID = content.recipeID {
                NavigationLink(value: BrewRecipeRoute(recipeLocalID: recipeID, shelfEntryLocalID: content.shelfEntryID)) {
                    Text(L10n.viewerLinkRecipe)
                        .minimumTapTarget()
                }
                .accessibilityHint(Text(L10n.viewerLinkRecipeHint))
                .accessibilityIdentifier("viewer-link-recipe")
            }
        } header: {
            Text(L10n.viewerLinksHeader)
                .secondaryText()
        } footer: {
            Text(L10n.viewerLinksFooter)
                .secondaryText()
        }
        .surfaceRow()
    }

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) {
                model.requestDelete()
            } label: {
                Label {
                    Text(L10n.brewPhotosDeleteShort)
                } icon: {
                    Image(systemName: "trash")
                        .accessibilityHidden(true)
                }
                .minimumTapTarget()
            }
            .accessibilityLabel(Text(L10n.viewerDeleteLabel))
            .accessibilityIdentifier("viewer-delete")
            if model.deleteFailed {
                Label {
                    Text(L10n.viewerDeleteFailed)
                        .font(.footnote)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(Theme.errorText)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("viewer-delete-failed")
            }
        }
        .surfaceRow()
    }
}

/// One key detail: its name and its value, side by side, one under the other at accessibility
/// text sizes. VoiceOver reads it as one element, "Dose, 18.0 g" (a score as "Overall, 7.5 of
/// 10").
private struct BrewPhotoViewerDetailRow: View {
    let detail: BrewPhotoViewerDetail
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            Text(verbatim: detail.title)
                .secondaryText()
            if !dynamicTypeSize.isAccessibilitySize {
                Spacer(minLength: 0)
            }
            Text(verbatim: detail.value)
                .monospacedDigit()
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: detail.title))
        .accessibilityValue(Text(verbatim: detail.spokenValue))
        .accessibilityIdentifier("viewer-detail-\(detail.field.rawValue)")
    }
}
