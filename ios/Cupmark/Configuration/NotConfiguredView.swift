import SwiftUI

/// Shown when the stage configuration is missing, malformed or outside eu-central-1
/// (M2-T9). The app then calls no backend at all. Read-only; no inputs.
struct NotConfiguredView: View {
    var body: some View {
        // Scrolls at the largest text sizes instead of cutting off the message (M2-T33).
        FitsOrScrolls {
            ContentUnavailableView {
                Label {
                    Text(L10n.notConfiguredTitle)
                } icon: {
                    Image(systemName: "wrench.and.screwdriver")
                        .accessibilityHidden(true)
                }
            } description: {
                Text(L10n.notConfiguredMessage)
            }
        }
        .accessibilityIdentifier("not-configured")
    }
}
