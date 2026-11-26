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
    /// Account deletion, which goes on after a restart (M2-T31). Nil when the stage is not
    /// configured.
    private let deletion: AccountDeletionModel?
    #if DEBUG
    /// Set when the UI tests launched the app with `-CupmarkUITestScreen` (M2-T33,
    /// `UITestLaunch`): the window then shows `UITestRootView` instead, and nothing below runs,
    /// so no Keychain, file or network is touched. Debug builds only; Release has no such path.
    private let uiTestLaunch: UITestLaunch?
    #endif

    init() {
        #if DEBUG
        if let launch = UITestLaunch(arguments: ProcessInfo.processInfo.arguments) {
            uiTestLaunch = launch
            stage = StageConfigLoadState.load(from: .main)
            auth = nil
            apiClient = nil
            sync = nil
            deletion = nil
            return
        }
        uiTestLaunch = nil
        #endif
        // An export file an earlier run left behind (M2-T30).
        ExportFileStore().removeAll()
        let stage = StageConfigLoadState.load(from: .main)
        self.stage = stage
        if case .configured(let config) = stage {
            // The record of a running account deletion (M2-T31): while it exists nothing but
            // `DELETE /account` is sent, for any account.
            let deletions = KeychainAccountDeletionStore(stage: config.stage)
            let model = AuthModel.live(config: config, deletions: deletions)
            let client = APIClient(baseURL: config.apiBaseURL, tokenProvider: model.session)
            let host = SyncHost.live(client: client, session: model.session, deletions: deletions)
            auth = model
            apiClient = client
            sync = host
            deletion = AccountDeletionModel(
                records: deletions,
                requests: .live(client: client, session: model.session),
                auth: model,
                sync: host
            )
        } else {
            auth = nil
            apiClient = nil
            sync = nil
            deletion = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let uiTestLaunch {
                UITestRootView(launch: uiTestLaunch, vocabulary: vocabulary)
            } else {
                root
            }
            #else
            root
            #endif
        }
    }

    /// The app's window content.
    @MainActor
    private var root: some View {
        RootView(state: vocabulary, stage: stage)
            .environment(auth)
            .environment(\.apiClient, apiClient)
            .environment(sync)
            .environment(deletion)
            .syncHost(sync, auth: auth)
            .accountDeletion(deletion, auth: auth)
    }
}

/// Marks the app bundle, so tests can find its resources with `Bundle(for:)`.
final class AppBundleToken {}
