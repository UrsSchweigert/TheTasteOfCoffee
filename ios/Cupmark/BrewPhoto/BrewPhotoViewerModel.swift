import Foundation
import Observation

/// One line of the brew's key details in the viewer: what it is, the text shown and the text
/// VoiceOver reads.
struct BrewPhotoViewerDetail: Identifiable, Equatable, Sendable {
    enum Field: String, Sendable {
        case method, dose, ratio, temperature, grind, score
    }

    let field: Field
    /// The vocabulary's or the catalogue's name of the value: "Method", "Dose", "Overall".
    let title: String
    /// "18.5 g", "1:16.2", "94°C", "7.5".
    let value: String
    /// Like `value`, but for a score "7.5 of 10".
    let spokenValue: String

    var id: Field { field }
}

/// Everything the viewer shows of one photo, read from the store.
struct BrewPhotoViewerContent: Equatable, Sendable {
    /// The photo record's `localID`.
    let photoID: UUID
    let createdAt: Date
    /// The JPEG; nil when the file is missing (the record stays so it can be deleted).
    let fileURL: URL?
    /// The same label as the photo's cell in the gallery.
    let accessibilityLabel: String
    /// The brew's local id: the link to its rating screen.
    let brewLocalID: UUID
    /// The brew's bag; nil (no link) when the brew has none or the bag was removed.
    let shelfEntryID: UUID?
    /// The saved recipe whose parameters equal the brew's; nil (no link) when there is none.
    let recipeID: UUID?
    /// Method, dose, ratio, temperature, grind and the overall score, those that are set.
    let details: [BrewPhotoViewerDetail]
}

/// The brew photo viewer (M2-T43b, ADR 0033): one photo, the brew's key details, links to the
/// brew, its bag and a recipe, and delete after a confirmation.
///
/// - The brew's details come from the stored brew, in `locale` (`BrewFormat`, `RatingFormat`):
///   method, dose, ratio, temperature, grind and the overall score when it is rated. A value the
///   brew has not set is left out.
/// - Links: the brew (always), its bag (not when the brew has none), and a recipe. A brew does
///   not store which recipe it came from, so the recipe link is the saved recipe whose parameters
///   equal the brew's (`AccountStore.recipe(matching:)`, with the parameters conformed to the
///   method rules first, as a recipe saved from the brew is, and as they are, in case the recipe
///   was saved without that). Without a match there is no link and no "create recipe" here.
/// - Delete is two steps like in the brew's photo section: `requestDelete`, then
///   `confirmDelete`, which deletes the record and the file (`AccountStore.deleteBrewPhoto`) and
///   sets `isDeleted`, on which the screen goes back to the gallery. The brew is not touched. A
///   photo that is already gone counts as deleted.
/// - Nothing is typed (invariant 1) and nothing is sent.
///
/// `reload()` reads the store again; the screen calls it when it appears and after every save of
/// the store.
@MainActor
@Observable
final class BrewPhotoViewerModel {
    let store: AccountStore
    let photoID: UUID
    private let vocabulary: VocabularyStore
    private let language: VocabularyLanguage
    private let locale: Locale
    private let calendar: Calendar
    private let bundle: Bundle

    /// The photo; nil until the first read and when the photo, or its brew, is gone.
    private(set) var content: BrewPhotoViewerContent?
    /// The store has been read at least once, so "gone" can be told from "not read yet".
    private(set) var hasLoaded = false
    /// True when the last read of the store failed.
    private(set) var loadFailed = false
    /// The photo was deleted here (or was already gone when the user confirmed).
    private(set) var isDeleted = false
    /// The last delete could not be saved; nothing was changed.
    private(set) var deleteFailed = false
    /// Whether the delete confirmation is up. Setting it to false cancels.
    var isConfirmingDelete = false

    init(
        store: AccountStore,
        photo photoID: UUID,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        locale: Locale = .current,
        calendar: Calendar = .current,
        bundle: Bundle = .main
    ) {
        self.store = store
        self.photoID = photoID
        self.vocabulary = vocabulary
        self.language = language
        self.locale = locale
        self.calendar = calendar
        self.bundle = bundle
    }

    /// The photo is not there (not read yet is not "gone").
    var isGone: Bool { hasLoaded && !loadFailed && content == nil }

    // MARK: - Reading

    func reload() {
        do {
            content = try readContent()
            loadFailed = false
        } catch {
            loadFailed = true
        }
        hasLoaded = true
    }

    private func readContent() throws -> BrewPhotoViewerContent? {
        guard let photo = try store.brewPhoto(localID: photoID),
              let brew = try store.brew(localID: photo.brewLocalID),
              brew.syncState != .pendingDelete else {
            return nil
        }
        let texts = BrewPhotoTexts(vocabulary: vocabulary, language: language, locale: locale, calendar: calendar, bundle: bundle)
        let name = photo.fileName
        let files = store.brewPhotoFiles
        // Not `brewPhotoFileURL(of:)`, which logs a missing file on every read.
        let url = files.flatMap { $0.fileExists(name) ? $0.url(of: name) : nil }
        var bag: StoredShelfEntry?
        if let entry = brew.shelfEntry, entry.syncState != .pendingDelete {
            bag = entry
        }
        return BrewPhotoViewerContent(
            photoID: photo.localID,
            createdAt: photo.createdAt,
            fileURL: url,
            accessibilityLabel: texts.photoLabel(method: brew.method, bag: brew.shelfEntry, date: photo.createdAt),
            brewLocalID: brew.localID,
            shelfEntryID: bag?.localID,
            recipeID: try matchingRecipe(of: brew)?.localID,
            details: details(of: brew)
        )
    }

    /// The saved recipe with the brew's parameters. A brew with an id the bundled vocabulary
    /// does not know has none.
    private func matchingRecipe(of brew: StoredBrew) throws -> StoredRecipe? {
        guard let parameters = try? brew.apiParameters() else {
            return nil
        }
        let conformed = parameters.conformingToMethodRules()
        if let recipe = try store.recipe(matching: conformed) {
            return recipe
        }
        return conformed == parameters ? nil : try store.recipe(matching: parameters)
    }

    // MARK: - Details

    private func details(of brew: StoredBrew) -> [BrewPhotoViewerDetail] {
        let draft = BrewDraft(brew)
        var result: [BrewPhotoViewerDetail] = []
        func add(_ field: BrewPhotoViewerDetail.Field, _ title: String, _ value: String, spoken: String? = nil) {
            result.append(BrewPhotoViewerDetail(field: field, title: title, value: value, spokenValue: spoken ?? value))
        }
        let methodText = brew.method.map { VocabularyLabels.label(for: $0, in: vocabulary, language: language) }
            ?? L10n.galleryMethodUnknown(bundle: bundle)
        add(.method, L10n.viewerDetailMethod(bundle: bundle), methodText)
        if let dose = draft.value(of: .dose) {
            add(.dose, L10n.viewerDetailDose(bundle: bundle), BrewFormat.value(dose, of: .dose, locale: locale))
        }
        if let ratio = draft.ratio {
            add(.ratio, L10n.viewerDetailRatio(bundle: bundle), BrewFormat.ratio(ratio, locale: locale, bundle: bundle))
        }
        switch draft.waterTemperature {
        case .some(.celsius(let celsius)):
            add(.temperature, L10n.viewerDetailTemperature(bundle: bundle), BrewFormat.value(Double(celsius), of: .temperature, locale: locale))
        case .some(.special(let special)):
            add(.temperature, L10n.viewerDetailTemperature(bundle: bundle), VocabularyLabels.label(for: special, in: vocabulary, language: language))
        case .none:
            break
        }
        if let grind = draft.value(of: .grind) {
            add(.grind, L10n.viewerDetailGrind(bundle: bundle), BrewFormat.value(grind, of: .grind, locale: locale))
        }
        if let overall = brew.rating?.score(for: .overall) {
            add(
                .score,
                VocabularyLabels.label(for: Vocabulary.Criterion.overall, in: vocabulary, language: language),
                RatingFormat.score(overall, locale: locale),
                spoken: RatingFormat.spokenScore(overall, locale: locale, bundle: bundle)
            )
        }
        return result
    }

    // MARK: - Deleting

    /// Asks to delete the photo; the screen shows its confirmation.
    func requestDelete() {
        deleteFailed = false
        isConfirmingDelete = true
    }

    func cancelDelete() {
        isConfirmingDelete = false
    }

    /// Deletes the photo, record and file. The brew is not touched. A photo that is already gone
    /// changes nothing and counts as deleted; a failed save changes nothing and sets
    /// `deleteFailed`.
    func confirmDelete() {
        isConfirmingDelete = false
        do {
            try store.deleteBrewPhoto(localID: photoID)
            isDeleted = true
        } catch {
            deleteFailed = true
        }
        reload()
    }
}
