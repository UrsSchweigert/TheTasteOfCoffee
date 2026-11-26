import SwiftUI

/// The coffee look (M2-T41, ADR 0032). The only file that names the colour sets of
/// `Assets.xcassets`; the sets are the only place a colour value is written. Screens use the
/// names and modifiers below, never a colour literal or a system colour as a brand tint
/// (`scripts/check-ios-colours.mjs` fails on one).
///
/// The accent colour is also the app's global tint (`AccentColor`, set in the build settings),
/// so buttons, links, sliders, steppers and pickers take it without a modifier. A `Toggle` stays
/// green unless `.tint(Theme.accent)` is applied, so every toggle does.
enum Theme {
    /// Espresso brown in light mode, caramel in dark mode.
    static let accent = Color("AccentColor")
    /// Text and icons on a filled accent button.
    static let onAccent = Color("OnAccent")
    /// Behind forms (cream; dark roast in dark mode).
    static let formBackground = Color("FormBackground")
    /// Behind lists and plain screens.
    static let listBackground = Color("ListBackground")
    /// Rows and cards on those backgrounds.
    static let surface = Color("Surface")
    static let textPrimary = Color("TextPrimary")
    /// Captions, footers and hints. Not the system's `.secondary`, which is a translucent grey
    /// that nearly fails 4.5:1 on cream (ADR 0032, point 3).
    static let textSecondary = Color("TextSecondary")
    /// Background of a swipe action; the system draws its label in white (8.5:1 light, 5.8:1 dark).
    static let swipeAction = Color("SwipeAction")
    /// A second swipe action next to the first, so the two look different.
    static let swipeActionSecondary = Color("SwipeActionSecondary")
    /// Error and failure text and its icon. The system red is 3.0 to 3.4:1 on cream; the
    /// destructive button role keeps the system red.
    static let errorText = Color("ErrorText")
    /// The marker of the user's average on a rating slider, and its number (M2-T48). Teal, so
    /// it differs in hue from the espresso thumb and track; the marker is also a diamond, not
    /// a circle. Drawn beside the track, on the row.
    static let averageMarker = Color("AverageMarker")

    /// A title or large heading: system font, rounded design, heavier weight. A text style, not
    /// a size, so Dynamic Type scales it.
    static func titleFont(_ style: Font.TextStyle = .largeTitle) -> Font {
        .system(style, design: .rounded, weight: .bold)
    }
}

extension View {
    /// A form: the system's grey is hidden and cream (dark roast in dark mode) shows instead.
    /// Add `surfaceRow()` to its rows.
    func formBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.formBackground, ignoresSafeAreaEdges: .all)
    }

    /// A list.
    func listBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.listBackground, ignoresSafeAreaEdges: .all)
    }

    /// A plain screen that is not a scroll view (sign-in, onboarding, fallbacks).
    func screenBackground() -> some View {
        background(Theme.listBackground, ignoresSafeAreaEdges: .all)
    }

    /// A row of a form or list on `Surface`.
    func surfaceRow() -> some View {
        listRowBackground(Theme.surface)
    }

    /// Captions, footers, hints and other secondary text.
    func secondaryText() -> some View {
        foregroundStyle(Theme.textSecondary)
    }

    /// Scores, selected marks and other accent-coloured values.
    func accentText() -> some View {
        foregroundStyle(Theme.accent)
    }

    /// A title: rounded and bold on system fonts, in `TextPrimary`.
    func themeTitle(_ style: Font.TextStyle = .largeTitle) -> some View {
        font(Theme.titleFont(style))
            .foregroundStyle(Theme.textPrimary)
    }
}

/// A filled button in the accent colour with `OnAccent` text and icons. The system's
/// `.borderedProminent` always writes white, which on the caramel accent of dark mode is about
/// 2:1; `OnAccent` is the colour ADR 0032 checked at 8.2:1 (light) and 9.5:1 (dark). For a
/// destructive action keep `.borderedProminent` with `role: .destructive`.
struct ProminentButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.controlSize) private var controlSize

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return configuration.label
            .labelStyle(.titleAndIcon)
            .font(.body.weight(.semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 16)
            .padding(.vertical, controlSize == .large ? 14 : 10)
            .frame(minHeight: controlSize == .large ? 50 : 44)
            .background(Theme.accent, in: shape)
            .contentShape(shape)
            .opacity(configuration.isPressed ? 0.7 : (isEnabled ? 1 : 0.5))
    }
}

extension ButtonStyle where Self == ProminentButtonStyle {
    /// `.buttonStyle(.prominent)`.
    static var prominent: ProminentButtonStyle { ProminentButtonStyle() }
}
