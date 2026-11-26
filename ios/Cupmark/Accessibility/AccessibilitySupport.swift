import SwiftUI

/// What VoiceOver reads as the value of a control (M2-T33, docs/04 Non-functional:
/// Dynamic Type and VoiceOver on every control). A value with a unit (grams, °C) is read as
/// shown; a value on a scale without a unit (a rating score, the grind) is read with the top
/// of its scale, "7.5 of 10", so the number means something without the slider in view.
enum AccessibilityValue {
    /// `valueText` (already formatted for `locale`) on a scale up to `maximum`: "7.5 of 10" in
    /// English, "7,5 von 10" in German. The top is written with the digits it needs, so a
    /// scale up to 10 reads "10", not "10.0". `bundle` is the app bundle; tests pass a
    /// language's `.lproj` bundle.
    static func ofScale(_ valueText: String, maximum: Double, locale: Locale = .current, bundle: Bundle = .main) -> String {
        L10n.valueOfScale(valueText, of: maximum.formatted(FloatingPointFormatStyle<Double>(locale: locale)), bundle: bundle)
    }
}

extension View {
    /// Makes a small control at least 44 by 44 points to tap (Human Interface Guidelines,
    /// "Buttons"), without changing how it looks: the frame grows around the content, and the
    /// whole frame takes the tap. For the label of a borderless button, such as "Clear".
    func minimumTapTarget() -> some View {
        frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// Shows `content` as it is when it fits the height it is offered, and in a vertical scroll
/// view when it does not (M2-T33). `ContentUnavailableView` does not scroll, so at the largest
/// accessibility text sizes its title, message and buttons would otherwise be cut off. At the
/// default size nothing changes: the first view fits and is the one shown.
struct FitsOrScrolls<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView {
                content
            }
        }
    }
}
