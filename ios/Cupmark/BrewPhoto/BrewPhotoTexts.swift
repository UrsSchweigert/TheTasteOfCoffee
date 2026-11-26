import Foundation

/// The texts the brew photo gallery and the viewer share (M2-T43, M2-T43b): the bean of a bag as
/// one line, the bag's title, a day, a list, and the photo's VoiceOver label "Espresso, Ethiopia
/// washed bag, 12 Nov 2026". The viewer's image has the same label as the grid's cell because
/// both come from here.
///
/// One instance is made per read of the store: its formatters are made once, and the bean text
/// and the bag title of a shelf entry are worked out once per entry (a gallery reload runs after
/// every save of the store, the sync engine's too, so it must not repeat the work per photo).
/// The instance is not kept between reads, so nothing it holds can go stale.
@MainActor
final class BrewPhotoTexts {
    private let vocabulary: VocabularyStore
    private let language: VocabularyLanguage
    private let locale: Locale
    private let calendar: Calendar
    private let bundle: Bundle
    private let dayStyle: Date.FormatStyle
    private let listFormatter: ListFormatter
    private var beanTexts: [UUID: String] = [:]
    private var bagTitles: [UUID: String] = [:]

    init(vocabulary: VocabularyStore, language: VocabularyLanguage, locale: Locale, calendar: Calendar, bundle: Bundle) {
        self.vocabulary = vocabulary
        self.language = language
        self.locale = locale
        self.calendar = calendar
        self.bundle = bundle
        var style = DisplayDate.day
        style.locale = locale
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        dayStyle = style
        let formatter = ListFormatter()
        formatter.locale = locale
        listFormatter = formatter
    }

    func label(of method: Vocabulary.Method) -> String {
        VocabularyLabels.label(for: method, in: vocabulary, language: language)
    }

    /// The bean of a bag as the shelf shows it, as one line: the Open Food Facts name (else its
    /// brand), else the attribute labels as a list, else "Bean without details".
    func beanText(of entry: StoredShelfEntry) -> String {
        if let known = beanTexts[entry.localID] {
            return known
        }
        let summary = ShelfBeanSummary(entry.bean)
        let text: String
        if summary.hasOpenFoodFactsText, let named = summary.name ?? summary.brand {
            text = named
        } else {
            let labels = summary.attributes.map { row in
                (try? vocabulary.label(namespace: row.field.namespace, id: row.valueID, language: language)) ?? row.valueID
            }
            text = labels.isEmpty ? L10n.galleryBeanUnnamed(bundle: bundle) : join(labels)
        }
        beanTexts[entry.localID] = text
        return text
    }

    /// The bean and the purchase date: "Ethiopia washed, bought 12 Nov 2026".
    func bagTitle(of entry: StoredShelfEntry) -> String {
        if let known = bagTitles[entry.localID] {
            return known
        }
        let bean = beanText(of: entry)
        let title: String
        if let purchase = entry.purchaseDate, let date = ShelfDates.date(of: purchase, calendar: calendar) {
            title = L10n.galleryBagOption(bean, bought: dayText(date), bundle: bundle)
        } else {
            title = bean
        }
        bagTitles[entry.localID] = title
        return title
    }

    /// Method, bag and date: "Espresso, Ethiopia washed bag, 12 Nov 2026". A method the
    /// vocabulary does not know is "Brew", a brew without a bag "no bag".
    func photoLabel(method: Vocabulary.Method?, bag: StoredShelfEntry?, date: Date) -> String {
        let methodText = method.map(label(of:)) ?? L10n.galleryMethodUnknown(bundle: bundle)
        let bagText = bag.map { L10n.galleryPhotoBag(beanText(of: $0), bundle: bundle) } ?? L10n.galleryNoBag(bundle: bundle)
        return L10n.galleryPhotoLabel(methodText, bag: bagText, date: dayText(date), bundle: bundle)
    }

    func dayText(_ date: Date) -> String {
        date.formatted(dayStyle)
    }

    func join(_ parts: [String]) -> String {
        listFormatter.string(from: parts) ?? parts.joined(separator: ", ")
    }
}
