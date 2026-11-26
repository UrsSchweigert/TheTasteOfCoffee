import Combine
import SwiftUI

/// Pushes the brew photo gallery (M2-T43). Registered at the stack root with the other routes
/// (`ShelfScreen`).
struct BrewPhotoGalleryRoute: Hashable {}

/// Pushes the viewer of one brew photo. M2-T43 registers a minimal viewer (the photo full size);
/// M2-T43b adds the details, the links back and delete.
struct BrewPhotoRoute: Hashable {
    /// The photo record's `localID`.
    let photoLocalID: UUID
}

/// The brew photo gallery (M2-T43, ADR 0033), opened from the shelf's toolbar: every brew photo
/// of the account, newest first, in an adaptive grid (one column at accessibility text sizes).
/// Two pick-list filters, method and bag, narrow it; no search box and no text field
/// (invariant 1). Photos are read from the device only, so it works offline.
///
/// Taps to the gallery from the shelf: the gallery button (1). To one photo: the cell (2).
/// A method filter: the menu, the method (2 more).
struct BrewPhotoGalleryScreen: View {
    @State private var model: BrewPhotoGalleryModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .body) private var cellMinimum: CGFloat = 104

    init(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: BrewPhotoGalleryModel(store: store, vocabulary: vocabulary, language: language))
    }

    /// Adaptive columns: as many as fit; the minimum grows with the text size, and at an
    /// accessibility size there is one.
    private var columns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.adaptive(minimum: cellMinimum), spacing: 12)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.loadFailed {
                    Text(L10n.shelfStoreErrorTitle)
                        .secondaryText()
                } else if model.hasNoPhotos {
                    emptyState
                } else {
                    filters
                    summary
                    if model.items.isEmpty {
                        Text(L10n.galleryEmptyFiltered)
                            .secondaryText()
                            .accessibilityIdentifier("gallery-empty-filtered")
                    } else {
                        grid
                    }
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .screenBackground()
        .navigationTitle(Text(L10n.galleryTitle))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.reload()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.reload()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }

    // MARK: - Parts

    private var emptyState: some View {
        FitsOrScrolls {
            ContentUnavailableView {
                Label {
                    Text(L10n.galleryEmptyTitle)
                } icon: {
                    Image(systemName: "photo.on.rectangle.angled")
                        .accessibilityHidden(true)
                }
            } description: {
                Text(L10n.galleryEmptyMessage)
            }
        }
        .accessibilityIdentifier("gallery-empty")
    }

    /// The count and the active filter: shown as one line, read as "Brew photos" with the same
    /// text as its value, so the value changes with every filter.
    private var summary: some View {
        Text(verbatim: model.summary)
            .font(.subheadline)
            .accentText()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(L10n.gallerySummaryLabel))
            .accessibilityValue(Text(verbatim: model.summary))
            .accessibilityIdentifier("gallery-count")
    }

    private var filters: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
        return VStack(alignment: .leading, spacing: 8) {
            layout {
                methodMenu
                bagMenu
            }
            if model.hasFilter {
                Button {
                    model.clearFilters()
                } label: {
                    Text(L10n.galleryFilterClear)
                        .minimumTapTarget()
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("gallery-filter-clear")
            }
        }
    }

    private var methodMenu: some View {
        Menu {
            choice(L10n.galleryFilterAnyMethod, isSelected: model.methodFilter == nil, identifier: "gallery-method-any") {
                model.methodFilter = nil
            }
            ForEach(model.methodOptions, id: \.self) { method in
                choice(Text(verbatim: model.label(of: method)), isSelected: model.methodFilter == method, identifier: "gallery-method-option-\(method.rawValue)") {
                    model.methodFilter = method
                }
            }
        } label: {
            filterLabel(title: L10n.galleryFilterMethod, value: model.methodFilterTitle, any: L10n.galleryFilterAnyMethod)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(Text(L10n.galleryFilterMethod))
        .accessibilityValue(model.methodFilterTitle.map { Text(verbatim: $0) } ?? Text(L10n.galleryFilterAnyMethod))
        .accessibilityIdentifier("gallery-method-filter")
    }

    private var bagMenu: some View {
        Menu {
            choice(L10n.galleryFilterAnyBag, isSelected: model.bagFilter == nil, identifier: "gallery-bag-any") {
                model.bagFilter = nil
            }
            ForEach(model.bags) { bag in
                choice(Text(verbatim: bag.title), isSelected: model.bagFilter == bag.id, identifier: "gallery-bag-option") {
                    model.bagFilter = bag.id
                }
            }
        } label: {
            filterLabel(title: L10n.galleryFilterBag, value: model.bagFilterTitle, any: L10n.galleryFilterAnyBag)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(Text(L10n.galleryFilterBag))
        .accessibilityValue(model.bagFilterTitle.map { Text(verbatim: $0) } ?? Text(L10n.galleryFilterAnyBag))
        .accessibilityIdentifier("gallery-bag-filter")
    }

    private func choice(_ title: LocalizedStringKey, isSelected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        choice(Text(title), isSelected: isSelected, identifier: identifier, action: action)
    }

    /// One entry of a filter menu: a checkmark on the chosen one, which VoiceOver reads as
    /// selected.
    private func choice(_ title: Text, isSelected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if isSelected {
                Label {
                    title
                } icon: {
                    Image(systemName: "checkmark")
                        .accessibilityHidden(true)
                }
            } else {
                title
            }
        }
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier(identifier)
    }

    /// The menu's face: the filter's name and its choice.
    private func filterLabel(title: LocalizedStringKey, value: String?, any: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .secondaryText()
            HStack(spacing: 4) {
                if let value {
                    Text(verbatim: value)
                } else {
                    Text(any)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .accessibilityHidden(true)
            }
            .font(.subheadline)
            .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .minimumTapTarget()
    }

    private var grid: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(model.items) { item in
                // A value link: the viewer is made only when it opens (registered at the root).
                NavigationLink(value: BrewPhotoRoute(photoLocalID: item.id)) {
                    BrewPhotoGalleryCell(url: item.fileURL)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: item.accessibilityLabel))
                .accessibilityIdentifier("gallery-photo")
            }
        }
    }
}

/// One square thumbnail of the grid. Its pixel size follows the cell's width and the display's
/// scale; a plain frame shows while it loads or when the file is missing.
private struct BrewPhotoGalleryCell: View {
    let url: URL?

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                GeometryReader { proxy in
                    BrewPhotoGalleryThumbnail(url: url, side: proxy.size.width)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
    }
}

/// The thumbnail of `url`, made off the main actor (`BrewPhotoThumbnails`) at `side` points
/// times the display scale, and tried again when the app becomes active.
private struct BrewPhotoGalleryThumbnail: View {
    let url: URL?
    let side: CGFloat
    @State private var thumbnail: BrewPhotoThumbnails.Thumbnail?
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase

    private struct LoadKey: Hashable {
        let url: URL?
        let pixels: Int
        let isActive: Bool
    }

    var body: some View {
        ZStack {
            if let thumbnail {
                Image(decorative: thumbnail.image, scale: 1)
                    .resizable()
                    .scaledToFill()
            } else {
                Theme.formBackground
                Image(systemName: "photo")
                    .secondaryText()
                    .accessibilityHidden(true)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        .task(id: LoadKey(url: url, pixels: pixels, isActive: scenePhase == .active)) {
            guard let url, pixels > 1 else {
                thumbnail = nil
                return
            }
            thumbnail = await BrewPhotoThumbnails.loadWithRetry(url, maxPixelSize: pixels)
        }
    }

    /// Rounded up to a multiple of 16, so a small change of the width does not load again.
    private var pixels: Int {
        let exact = Int((side * displayScale).rounded(.up))
        return exact <= 0 ? 0 : (exact + 15) / 16 * 16
    }
}

/// The minimal viewer of M2-T43: one photo, as large as the screen, with its label for
/// VoiceOver. M2-T43b replaces the body with the details, the links and delete; the route and
/// its registration stay.
struct BrewPhotoViewerScreen: View {
    @State private var model: BrewPhotoGalleryModel
    let photoID: UUID
    @State private var image: BrewPhotoThumbnails.Thumbnail?
    @Environment(\.scenePhase) private var scenePhase

    /// The longest side of the picture shown, in pixels: larger than any iPhone screen.
    private static let pixels = 2048

    init(store: AccountStore, photo photoID: UUID, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.photoID = photoID
        _model = State(initialValue: BrewPhotoGalleryModel(store: store, vocabulary: vocabulary, language: language))
    }

    var body: some View {
        ScrollView {
            if let item = model.item(id: photoID) {
                VStack(spacing: 12) {
                    if let image {
                        Image(decorative: image.image, scale: 1)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(Text(verbatim: item.accessibilityLabel))
                            .accessibilityAddTraits(.isImage)
                            .accessibilityIdentifier("gallery-viewer-photo")
                    } else if item.fileURL == nil {
                        Text(L10n.brewPhotosFileMissing)
                            .secondaryText()
                    } else {
                        ProgressView()
                            .accessibilityHidden(true)
                    }
                }
                .padding()
                .task(id: item.fileURL) {
                    guard let url = item.fileURL else {
                        image = nil
                        return
                    }
                    image = await BrewPhotoThumbnails.loadWithRetry(url, maxPixelSize: BrewPhotoViewerScreen.pixels)
                }
            } else {
                Text(L10n.galleryViewerNotFound)
                    .secondaryText()
                    .padding()
                    .accessibilityIdentifier("gallery-viewer-not-found")
            }
        }
        .screenBackground()
        .navigationTitle(Text(L10n.galleryTitle))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.reload()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.reload()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }
}
