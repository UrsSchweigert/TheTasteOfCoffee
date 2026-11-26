#if DEBUG
import SwiftUI

/// The window content of a UI-test launch (M2-T33, `UITestLaunch`): the requested screen,
/// made by `UITestHarness` once the view is on screen (on the main actor, like every model
/// the screens use).
struct UITestRootView: View {
    let launch: UITestLaunch
    let vocabulary: VocabularyLoadState
    @State private var harness: UITestHarness? = nil

    init(launch: UITestLaunch, vocabulary: VocabularyLoadState) {
        self.launch = launch
        self.vocabulary = vocabulary
    }

    var body: some View {
        Group {
            if let harness {
                harness.root
            } else {
                ProgressView()
                    .accessibilityLabel(Text(L10n.shelfLoading))
            }
        }
        .task {
            if harness == nil {
                harness = UITestHarness(launch: launch, vocabulary: vocabulary)
            }
        }
    }
}

/// Builds the screen of a UI-test launch from the fixtures (`UITestFixtures`), the stub API
/// (`UITestAPI`) and the fake sign-in (`UITestAuth`). The screens are the app's own views with
/// their own models:
/// - sign-in, onboarding and the shelf go through `RootView`, `AuthGate`, `SyncHost`,
///   `ShelfRoot` and `OnboardingGate`, as at app start. The sync engine never sends: its
///   account check says no, and the outbox is empty anyway;
/// - every other screen is shown on its own in a navigation stack, on a seeded store, so a
///   test needs no taps to reach it.
@MainActor
final class UITestHarness {
    private let launch: UITestLaunch
    private let vocabulary: VocabularyLoadState
    private let client: APIClient?
    private let config: StageConfig?
    private let auth: AuthModel?
    private let sync: SyncHost?
    /// The store of a screen shown on its own; nil for the `RootView` screens, whose store
    /// `SyncHost` opens.
    private let seeded: UITestFixtures.Seeded?
    private let lookup: LookupModel?
    private let beanEntry: BeanEntryModel?
    private let recipes: BrewStartModel?

    init(launch: UITestLaunch, vocabulary: VocabularyLoadState) {
        self.launch = launch
        self.vocabulary = vocabulary
        let client = UITestAPI.makeClient()
        self.client = client
        let config = UITestAuth.stageConfig()
        self.config = config
        let barcode = CanonicalBarcode(UITestFixtures.barcode)
        switch launch.screen {
        case .signIn, .onboarding, .shelf:
            let signedIn = launch.screen != .signIn
            let withProfile = launch.screen == .shelf
            auth = config.map { UITestAuth.model(config: $0, signedInAs: signedIn ? UITestFixtures.account : nil) }
            sync = client.map { client in
                SyncHost(
                    makeStore: { _ in try UITestFixtures.seed(withProfile: withProfile).store },
                    makeEngine: { _, store in
                        SyncEngine(store: store, client: client, isCurrentAccount: { false })
                    },
                    labelPhotos: LabelPhotoFolders(root: FileManager.default.temporaryDirectory.appending(path: "CupmarkUITestLabelPhotos"))
                )
            }
            seeded = nil
            lookup = nil
            beanEntry = nil
            recipes = nil
        case .notConfigured, .scannerFallback, .lookupResult, .beanEntry, .brewForm, .timer, .rating, .recipes, .statistics, .settings:
            auth = nil
            sync = nil
            let seeded = try? UITestFixtures.seed(withProfile: true)
            self.seeded = seeded
            if let barcode, let client {
                lookup = LookupModel(barcode: barcode, client: client)
            } else {
                lookup = nil
            }
            beanEntry = client.map { client in BeanEntryModel(barcode: barcode, client: client, offlineStore: seeded?.store) }
            recipes = seeded.map { seeded in BrewStartModel(shelfEntry: seeded.shelfEntry, store: seeded.store) }
        }
    }

    @ViewBuilder
    var root: some View {
        switch launch.screen {
        case .notConfigured:
            RootView(state: vocabulary, stage: .notConfigured(.missing(.stage)))
        case .signIn, .onboarding, .shelf:
            if let config, let auth, let sync {
                RootView(state: vocabulary, stage: .configured(config))
                    .environment(auth)
                    .environment(\.apiClient, client)
                    .environment(sync)
                    .syncHost(sync, auth: auth)
            } else {
                NotConfiguredView()
            }
        case .scannerFallback, .lookupResult, .beanEntry, .brewForm, .timer, .rating, .recipes, .statistics, .settings:
            if case .loaded(let store, let language) = vocabulary, let seeded, let client {
                screen(seeded: seeded, client: client, vocabulary: store, language: language)
                    .environment(\.apiClient, client)
                    // The system photo picker cannot be driven here: a fixture photo stands in (M2-T42b).
                    .environment(\.uiTestBrewPhotoPicker, UITestBrewPhotoPicker())
            } else {
                RootView(state: vocabulary, stage: .notConfigured(.missing(.stage)))
            }
        }
    }

    @ViewBuilder
    private func screen(seeded: UITestFixtures.Seeded, client: APIClient, vocabulary: VocabularyStore, language: VocabularyLanguage) -> some View {
        let shelf = ShelfAddContext(store: seeded.store, onSaved: { _ in })
        switch launch.screen {
        case .scannerFallback:
            // The app's scan flow. The simulator cannot scan, so the scanner shows its fallback.
            NavigationStack {
                ScanFlowView(client: client, vocabulary: vocabulary, language: language, shelf: shelf)
            }
        case .lookupResult:
            if let lookup {
                NavigationStack {
                    LookupScreen(model: lookup, vocabulary: vocabulary, language: language, onPickListEntry: {}, shelf: shelf)
                }
            }
        case .beanEntry:
            if let beanEntry {
                NavigationStack {
                    BeanEntryScreen(model: beanEntry, vocabulary: vocabulary, language: language, shelf: shelf)
                }
            }
        case .brewForm:
            BrewSheet(store: seeded.store, route: BrewRoute(shelfEntryLocalID: seeded.shelfEntry), vocabulary: vocabulary, language: language)
        case .timer:
            BrewSheet(store: seeded.store, route: BrewRoute(shelfEntryLocalID: seeded.shelfEntry, start: .lastBrew), vocabulary: vocabulary, language: language)
        case .rating:
            NavigationStack {
                RatingScreen(store: seeded.store, brew: seeded.unratedBrew, mode: .afterBrew, vocabulary: vocabulary, language: language)
            }
        case .recipes:
            if let recipes {
                NavigationStack {
                    RecipeListScreen(model: recipes, vocabulary: vocabulary, language: language)
                }
            }
        case .statistics:
            NavigationStack {
                StatisticsScreen(store: seeded.store, vocabulary: vocabulary, language: language)
            }
        case .settings:
            NavigationStack {
                SettingsScreen(account: UITestFixtures.account, store: seeded.store)
            }
        case .signIn, .notConfigured, .onboarding, .shelf:
            EmptyView()
        }
    }
}
#endif
