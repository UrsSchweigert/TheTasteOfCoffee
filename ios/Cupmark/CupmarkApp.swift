import SwiftUI

@main
struct CupmarkApp: App {
    private let vocabulary = VocabularyLoadState.load(from: .main)
    private let stage: StageConfigLoadState
    /// Sign-in and the app's `TokenProvider` (M2-T11). Nil when the stage is not configured.
    private let auth: AuthModel?

    init() {
        let stage = StageConfigLoadState.load(from: .main)
        self.stage = stage
        if case .configured(let config) = stage {
            auth = AuthModel.live(config: config)
        } else {
            auth = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(state: vocabulary, stage: stage)
                .environment(auth)
        }
    }
}

/// Marks the app bundle, so tests can find its resources with `Bundle(for:)`.
final class AppBundleToken {}
