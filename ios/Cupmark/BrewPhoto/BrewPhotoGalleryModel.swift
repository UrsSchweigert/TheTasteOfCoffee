import Foundation
import Observation

/// One photo in the gallery (M2-T43): the photo, the brew and the bag it belongs to, and the
/// VoiceOver label built from method, bag and date.
struct BrewPhotoGalleryItem: Identifiable, Equatable, Sendable {
    /// The photo record's `localID`.
    let id: UUID
    let brewLocalID: UUID
    let createdAt: Date
    /// Nil for a method the bundled vocabulary does not know.
    let method: Vocabulary.Method?
    /// The brew's shelf entry, nil when it has none.
    let shelfEntryID: UUID?
    /// The JPEG; nil when the file is missing (the record stays so it can be deleted).
    let fileURL: URL?
    /// "Espresso, Ethiopia washed bag, 12 Nov 2026", in the device language.
    let accessibilityLabel: String
}

/// One bag in the bag filter's pick list.
struct BrewPhotoGalleryBag: Identifiable, Equatable, Sendable {
    /// The shelf entry's `localID`.
    let id: UUID
    /// The bean and the purchase date: "Ethiopia washed, bought 12 Nov 2026".
    let title: String
}

/// The brew photo gallery (M2-T43, ADR 0033): every brew photo of the account's store, newest
/// first, filtered by method and by bag. Both filters are pick lists (invariant 1): nothing is
/// typed.
///
/// - Only this store's photos are read (`AccountStore.allBrewPhotos()`: one store per account).
/// - A photo whose brew is gone or removed on the device (`pendingDelete`) is not shown.
/// - A filter that no longer exists after a reload (the bag was removed) is cleared.
/// - The texts come from the String Catalog and the vocabulary labels (`BrewPhotoTexts`), with
///   the formatters of `locale` and `calendar`; tests pin a language by passing its `.lproj`
///   bundle.
///
/// `reload()` reads the store again; the screen calls it when it appears and after every save
/// of the store (`AccountStore.didSaveNotification`, the sync engine's too), so it does a fixed
/// number of reads whatever the number of photos: the photos, the brews, the bags and the
/// photo folder's listing, once each.
@MainActor
@Observable
final class BrewPhotoGalleryModel {
    let store: AccountStore
    private let vocabulary: VocabularyStore
    private let language: VocabularyLanguage
    private let locale: Locale
    private let calendar: Calendar
    private let bundle: Bundle
    /// Joins the filter phrase; made once, since `filterDescription` is read by every redraw.
    /// (The texts of a reload are made anew each time, so none of them goes stale.)
    @ObservationIgnored private let joiner: BrewPhotoTexts

    /// Every photo that can be shown, newest first, before filtering.
    private(set) var allItems: [BrewPhotoGalleryItem] = []
    /// The user's bags, in shelf order (latest purchase first).
    private(set) var bags: [BrewPhotoGalleryBag] = []
    /// True when the last read of the store failed.
    private(set) var loadFailed = false

    /// The method filter; nil shows every method.
    var methodFilter: Vocabulary.Method?
    /// The bag filter (a shelf entry's `localID`); nil shows every bag.
    var bagFilter: UUID?

    init(
        store: AccountStore,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        locale: Locale = .current,
        calendar: Calendar = .current,
        bundle: Bundle = .main
    ) {
        self.store = store
        self.vocabulary = vocabulary
        self.language = language
        self.locale = locale
        self.calendar = calendar
        self.bundle = bundle
        joiner = BrewPhotoTexts(vocabulary: vocabulary, language: language, locale: locale, calendar: calendar, bundle: bundle)
    }

    // MARK: - State

    /// The photos that pass the filters, newest first.
    var items: [BrewPhotoGalleryItem] {
        allItems.filter { item in
            (methodFilter == nil || item.method == methodFilter)
                && (bagFilter == nil || item.shelfEntryID == bagFilter)
        }
    }

    var count: Int { items.count }
    var hasFilter: Bool { methodFilter != nil || bagFilter != nil }
    /// The account has no photo at all (not the same as no photo passing the filters).
    var hasNoPhotos: Bool { allItems.isEmpty }

    /// The methods the pick list offers: every method of the vocabulary, in its order.
    var methodOptions: [Vocabulary.Method] { Vocabulary.Method.allCases }

    func label(of method: Vocabulary.Method) -> String {
        VocabularyLabels.label(for: method, in: vocabulary, language: language)
    }

    /// The chosen method's label, nil without a method filter.
    var methodFilterTitle: String? { methodFilter.map(label(of:)) }

    /// The chosen bag's title, nil without a bag filter (or one that is gone).
    var bagFilterTitle: String? {
        guard let bagFilter else {
            return nil
        }
        return bags.first { $0.id == bagFilter }?.title
    }

    /// The active filters as one phrase, nil without any: "Espresso, Ethiopia washed, bought 12
    /// Nov 2026".
    var filterDescription: String? {
        let parts = [methodFilterTitle, bagFilterTitle].compactMap { $0 }
        return parts.isEmpty ? nil : joiner.join(parts)
    }

    /// The count as shown, with the active filter: "Photos: 3" or "Photos: 2, filter:
    /// Espresso".
    var summary: String {
        let number = count.formatted(.number.locale(locale))
        guard let description = filterDescription else {
            return L10n.galleryCount(number, bundle: bundle)
        }
        return L10n.galleryCountFiltered(number, filter: description, bundle: bundle)
    }

    /// What VoiceOver reads as the count's value, after its label "Brew photos": the number and
    /// the active filter, "3" or "2, filter: Espresso". The label already says what is counted.
    var spokenValue: String {
        let number = count.formatted(.number.locale(locale))
        guard let description = filterDescription else {
            return number
        }
        return L10n.galleryCountValueFiltered(number, filter: description, bundle: bundle)
    }

    func item(id: UUID) -> BrewPhotoGalleryItem? {
        allItems.first { $0.id == id }
    }

    /// Shows every photo again.
    func clearFilters() {
        methodFilter = nil
        bagFilter = nil
    }

    // MARK: - Reading

    func reload() {
        do {
            let texts = makeTexts()
            let entries = try store.shelfEntries()
            bags = entries.map { entry in
                BrewPhotoGalleryBag(id: entry.localID, title: texts.bagTitle(of: entry))
            }
            if let bagFilter, !bags.contains(where: { $0.id == bagFilter }) {
                self.bagFilter = nil
            }
            allItems = try readItems(texts)
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    private func makeTexts() -> BrewPhotoTexts {
        BrewPhotoTexts(vocabulary: vocabulary, language: language, locale: locale, calendar: calendar, bundle: bundle)
    }

    /// One fetch of the photos, one of the brews and one listing of the photo folder, whatever
    /// the number of photos.
    private func readItems(_ texts: BrewPhotoTexts) throws -> [BrewPhotoGalleryItem] {
        let photos = try store.allBrewPhotos()
        guard !photos.isEmpty else {
            return []
        }
        let brews = try store.brewsByLocalID()
        let files = store.brewPhotoFiles
        // A file is looked up in the folder's listing, not through `brewPhotoFileURL(of:)`, which
        // logs a missing file: this runs after every save of the store.
        let present = Set(files?.entryNames() ?? [])
        var items: [BrewPhotoGalleryItem] = []
        for photo in photos {
            // The record of a brew that is gone stays until the next sweep; it is not shown.
            guard let brew = brews[photo.brewLocalID], brew.syncState != .pendingDelete else {
                continue
            }
            let name = photo.fileName
            let url = present.contains(name) ? files?.url(of: name) : nil
            let method = brew.method
            let bag = brew.shelfEntry
            items.append(BrewPhotoGalleryItem(
                id: photo.localID,
                brewLocalID: brew.localID,
                createdAt: photo.createdAt,
                method: method,
                shelfEntryID: bag?.localID,
                fileURL: url,
                accessibilityLabel: texts.photoLabel(method: method, bag: bag, date: photo.createdAt)
            ))
        }
        return items
    }
}
