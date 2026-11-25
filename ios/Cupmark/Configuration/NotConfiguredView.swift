import SwiftUI

/// Shown when the stage configuration is missing, malformed or outside eu-central-1
/// (M2-T9). The app then calls no backend at all. Read-only; no inputs.
struct NotConfiguredView: View {
    var body: some View {
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
        .accessibilityIdentifier("not-configured")
    }
}
