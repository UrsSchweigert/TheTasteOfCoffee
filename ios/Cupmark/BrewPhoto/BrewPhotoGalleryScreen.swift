import Combine
import SwiftUI

/// Pushes the brew photo gallery (M2-T43). Registered at the stack root with the other routes
/// (`ShelfScreen`).
struct BrewPhotoGalleryRoute: Hashable {}

/// Pushes the viewer of one brew photo (`BrewPhotoViewerScreen`, M2-T43b). Registered at the
/// stack root with the gallery's route (`ShelfScreen`).
struct BrewPhotoRoute: Hashable {
    /// The photo record's `localID`.
    let photoLocalID: UUID
}

/// The brew photo gallery (M2-T43, ADR 0033), opened from the shelf's toolbar: every brew photo
/// of the account, newest first, in an adaptive grid (one column at accessibility text sizes).
/// Two pick-list filters, method and bag, narrow it; no search box and no text field
/// (invariant 1). Photos are read from the device only, so it works offline.
///
/// The filter menus are the system's: the menu and the checkmark on the chosen entry are drawn
/// by the system, not in the accent colour.
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

    /// The count and the active filter: shown as one line ("Photos: 3"), read as "Brew photos"
    /// with only the number and the filter as its value ("3"), so the value changes with every
    /// filter and VoiceOver does not say "photos" twice.
    private var summary: some View {
        Text(verbatim: model.summary)
            .font(.subheadline)
            .accentText()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(L10n.gallerySummaryLabel))
            .accessibilityValue(Text(verbatim: model.spokenValue))
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
            filterLabel(title: L10n.galleryFilterMethod, value: model.methodFilterTitle, anyTitle: L10n.galleryFilterAnyMethod)
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
            filterLabel(title: L10n.galleryFilterBag, value: model.bagFilterTitle, anyTitle: L10n.galleryFilterAnyBag)
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
    private func filterLabel(title: LocalizedStringKey, value: String?, anyTitle: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .secondaryText()
            HStack(spacing: 4) {
                if let value {
                    Text(verbatim: value)
                } else {
                    Text(anyTitle)
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
    @State private var loaded: BrewPhotoThumbnails.Loaded?
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase

    private struct LoadKey: Hashable {
        let url: URL?
        let pixels: Int
        let isActive: Bool
    }

    var body: some View {
        ZStack {
            if let loaded, loaded.url == url {
                Image(decorative: loaded.thumbnail.image, scale: 1)
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
            // Before the cell has a width nothing is read. A failed load keeps the image already
            // shown, and one that is shown is not read again when the app becomes active.
            guard pixels > 1 else {
                return
            }
            loaded = await BrewPhotoThumbnails.updated(loaded, for: url, maxPixelSize: pixels)
        }
    }

    /// Rounded up to a multiple of 16, so a small change of the width does not load again.
    private var pixels: Int {
        let exact = Int((side * displayScale).rounded(.up))
        return exact <= 0 ? 0 : (exact + 15) / 16 * 16
    }
}
