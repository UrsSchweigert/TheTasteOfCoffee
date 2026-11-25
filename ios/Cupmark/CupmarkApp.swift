import SwiftUI

@main
struct CupmarkApp: App {
    private let vocabulary = VocabularyLoadState.load(from: .main)

    var body: some Scene {
        WindowGroup {
            RootView(state: vocabulary)
        }
    }
}

/// Marks the app bundle, so tests can find its resources with `Bundle(for:)`.
final class AppBundleToken {}
