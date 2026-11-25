import Foundation

/// Converts between the calendar days of the contract (`API.CalendarDate`) and the `Date`
/// values a date picker works with (M2-T18).
enum ShelfDates {
    /// The Gregorian day `date` falls on in `calendar`'s time zone.
    static func day(of date: Date, calendar: Calendar = .current) -> API.CalendarDate? {
        API.CalendarDate(date: date, timeZone: calendar.timeZone)
    }

    /// The last second of the day `date` falls on in `calendar`'s time zone, for the upper
    /// bound of a date picker. `date` itself if the calendar cannot say.
    static func endOfDay(of date: Date, calendar: Calendar = .current) -> Date {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let start = gregorian.startOfDay(for: date)
        guard let next = gregorian.date(byAdding: .day, value: 1, to: start) else {
            return date
        }
        return max(date, next.addingTimeInterval(-1))
    }

    /// Noon of `day` in `calendar`'s time zone: far from midnight, so a daylight saving change
    /// never moves it to another day, and `day(of:calendar:)` gives `day` back.
    static func date(of day: API.CalendarDate, calendar: Calendar = .current) -> Date? {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        return gregorian.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12))
    }
}

/// The values of a shelf entry while the user edits them (M2-T18). Screens edit this draft,
/// never a live model, and write it through `AccountStore` in one step (ADR 0025).
///
/// Every value is a date or a `Vocabulary` value; nothing is typed (invariant 1). The bean is
/// not part of the draft: the editor holds it, and the request names it by its server id
/// when it is sent.
struct ShelfEntryDraft: Equatable, Sendable {
    /// `purchase_date`, required. Nil only for a stored entry whose date cannot be read; such
    /// a draft cannot be saved until a date is picked.
    var purchaseDate: API.CalendarDate?
    /// `roast_date`, optional.
    var roastDate: API.CalendarDate?
    /// `bag_size`, optional.
    var bagSize: Vocabulary.BagSize?
    /// `price_band`, optional.
    var priceBand: Vocabulary.PriceBand?

    /// A stored id the bundled vocabulary does not know (picked with a newer version on
    /// another device). It reads as "not set" and is kept unless the user picks a value.
    private(set) var unknownBagSizeID: String?
    private(set) var unknownPriceBandID: String?
    /// The version of the stored values, kept while an unknown id is kept.
    private(set) var storedVocabularyVersion: Int?

    init(
        purchaseDate: API.CalendarDate?,
        roastDate: API.CalendarDate? = nil,
        bagSize: Vocabulary.BagSize? = nil,
        priceBand: Vocabulary.PriceBand? = nil
    ) {
        self.purchaseDate = purchaseDate
        self.roastDate = roastDate
        self.bagSize = bagSize
        self.priceBand = priceBand
        self.unknownBagSizeID = nil
        self.unknownPriceBandID = nil
        self.storedVocabularyVersion = nil
    }

    /// A new entry: bought today, nothing else set.
    static func new(today: Date = Date(), calendar: Calendar = .current) -> ShelfEntryDraft {
        ShelfEntryDraft(purchaseDate: ShelfDates.day(of: today, calendar: calendar))
    }

    /// The values of a stored entry.
    init(_ entry: StoredShelfEntry) {
        self.init(purchaseDate: entry.purchaseDate, roastDate: entry.roastDate, bagSize: entry.bagSize, priceBand: entry.priceBand)
        if entry.bagSize == nil {
            unknownBagSizeID = entry.bagSizeID
        }
        if entry.priceBand == nil {
            unknownPriceBandID = entry.priceBandID
        }
        storedVocabularyVersion = entry.vocabularyVersion
    }

    /// Whether the draft can be saved: it has a purchase date.
    var isComplete: Bool {
        purchaseDate != nil
    }

    /// Whether an id the bundled vocabulary does not know would be kept on save.
    var keepsUnknownIDs: Bool {
        (bagSize == nil && unknownBagSizeID != nil) || (priceBand == nil && unknownPriceBandID != nil)
    }

    /// The `POST /shelf` or `PUT /shelf/{id}` body for the bean with server id `beanID`: the
    /// bundled vocabulary version and the draft's values. Nil without a purchase date.
    func input(beanID: API.Id) -> API.ShelfEntryInput? {
        guard let purchaseDate else {
            return nil
        }
        return API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: beanID,
            purchaseDate: purchaseDate,
            roastDate: roastDate,
            bagSize: bagSize,
            priceBand: priceBand
        )
    }

    /// Writes the values into `entry`, which the caller then saves through `AccountStore`
    /// in the same step. Does nothing without a purchase date. An unknown stored id is kept
    /// when the user left its list on "not set", and so is the stored version with it.
    func apply(to entry: StoredShelfEntry) {
        guard let purchaseDate else {
            return
        }
        entry.purchaseDateRaw = purchaseDate.description
        entry.roastDate = roastDate
        entry.bagSizeID = bagSize?.rawValue ?? unknownBagSizeID
        entry.priceBandID = priceBand?.rawValue ?? unknownPriceBandID
        if keepsUnknownIDs, let storedVocabularyVersion {
            entry.vocabularyVersion = max(storedVocabularyVersion, Vocabulary.version)
        } else {
            entry.vocabularyVersion = Vocabulary.version
        }
    }

    /// Turns the optional roast date on (the purchase date, or `today` without one) or off.
    mutating func setHasRoastDate(_ hasRoastDate: Bool, today: Date = Date(), calendar: Calendar = .current) {
        if hasRoastDate {
            if roastDate == nil {
                roastDate = purchaseDate ?? ShelfDates.day(of: today, calendar: calendar)
            }
        } else {
            roastDate = nil
        }
    }
}
