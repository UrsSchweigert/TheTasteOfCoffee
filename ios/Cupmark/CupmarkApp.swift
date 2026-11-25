import SwiftUI

@main
struct CupmarkApp: App {
    private let vocabulary = VocabularyLoadState.load(from: .main)
    private let stage = StageConfigLoadState.load(from: .main)

    var body: some Scene {
        WindowGroup {
            RootView(state: vocabulary, stage: stage)
        }
    }
}

/// Marks the app bundle, so tests can find its resources with `Bundle(for:)`.
final class AppBundleToken {}
