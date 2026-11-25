import Foundation

/// The values the app computes from a brew (docs/04 F2). This is the only place they are
/// computed; models and screens call these functions.
enum BrewDerivedValues {
    /// Brew ratio: `water_g` / (`dose_dg` / 10), that is grams of water per gram of coffee
    /// (ADR 0004). Nil when either value is missing or the dose is not positive.
    static func ratio(doseDg: API.DoseDg?, waterG: API.WaterG?) -> Double? {
        guard let doseDg, let waterG, doseDg > 0 else {
            return nil
        }
        return Double(waterG) / (Double(doseDg) / 10)
    }

    /// Whole days from `roastDate` to the day `brewedAt` falls on in `calendar`'s time zone,
    /// the device calendar by default. Counted on calendar days, so a daylight saving change
    /// or a time zone change between the two never shifts the count by a day. Nil without a
    /// roast date, or when the roast date lies after the brew day.
    static func daysSinceRoast(
        roastDate: API.CalendarDate?,
        brewedAt: Date,
        calendar: Calendar = .current
    ) -> Int? {
        guard let roastDate,
              let brewDay = API.CalendarDate(date: brewedAt, timeZone: calendar.timeZone) else {
            return nil
        }
        let days = dayNumber(brewDay) - dayNumber(roastDate)
        return days >= 0 ? days : nil
    }

    /// Days since 1970-01-01 in the proleptic Gregorian calendar (H. Hinnant's
    /// `days_from_civil`). Pure integer arithmetic, no time zone involved.
    static func dayNumber(_ date: API.CalendarDate) -> Int {
        let year = date.month <= 2 ? date.year - 1 : date.year
        let era = (year >= 0 ? year : year - 399) / 400
        let yearOfEra = year - era * 400
        let shiftedMonth = date.month > 2 ? date.month - 3 : date.month + 9
        let dayOfYear = (153 * shiftedMonth + 2) / 5 + date.day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }
}
