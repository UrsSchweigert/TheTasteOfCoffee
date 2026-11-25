import SwiftUI

@main
struct CupmarkApp: App {
    private let vocabulary = VocabularyLoadState.load(from: .main)
    private let stage: StageConfigLoadState
    /// Sign-in and the app's `TokenProvider` (M2-T11). Nil when the stage is not configured.
    private let auth: AuthModel?
    /// The API with the signed-in account's token (M2-T14). Nil when the stage is not configured.
    private let apiClient: APIClient?
    /// The signed-in account's store and outbox (M2-T16). Nil when the stage is not configured.
    private let sync: SyncHost?

    init() {
        let stage = StageConfigLoadState.load(from: .main)
        self.stage = stage
        if case .configured(let config) = stage {
            let model = AuthModel.live(config: config)
            auth = model
            apiClient = APIClient(baseURL: config.apiBaseURL, tokenProvider: model.session)
            sync = apiClient.map { client in SyncHost.live(client: client, session: model.session) }
        } else {
            auth = nil
            apiClient = nil
            sync = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(state: vocabulary, stage: stage)
                .environment(auth)
                .environment(\.apiClient, apiClient)
                .environment(sync)
                .syncHost(sync, auth: auth)
        }
    }
}

/// Marks the app bundle, so tests can find its resources with `Bundle(for:)`.
final class AppBundleToken {}
