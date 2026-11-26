import SwiftUI

/// The export screen with its model, made when Settings pushes it. Needs the API client and the
/// sync engine from the environment; without them it shows the not-configured view. Kept out of
/// `SettingsScreen` so that the settings files never touch the API client (the profile goes
/// through the outbox only).
struct ExportDestination: View {
    let store: AccountStore
    @Environment(\.apiClient) private var apiClient
    @Environment(SyncHost.self) private var sync: SyncHost?

    var body: some View {
        if let apiClient, let engine = sync?.engine {
            ExportScreen(model: ExportModel(source: apiClient, outbox: .live(engine: engine, store: store)))
        } else {
            NotConfiguredView()
        }
    }
}
