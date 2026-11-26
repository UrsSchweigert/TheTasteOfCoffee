import Foundation

/// How the app shows a date or a time: Foundation format styles, so the device locale picks
/// the order, the separators and the month names (M2-T32). `Text(date, format:)` applies the
/// environment's locale; tests set `.locale(_:)` on the style to pin one.
///
/// Only for display. What goes to the server (RFC 3339 instants, `YYYY-MM-DD` days) and file
/// names (the export) are never written with these styles.
enum DisplayDate {
    /// A day: `Nov 25, 2026` in English, `25. Nov. 2026` in German.
    static var day: Date.FormatStyle {
        .dateTime.day().month().year()
    }

    /// A day and the time of day, for a brew's moment.
    static var dayAndTime: Date.FormatStyle {
        .dateTime.day().month().year().hour().minute()
    }
}
