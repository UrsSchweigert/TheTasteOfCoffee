import SwiftUI

/// The app's `APIClient` in the SwiftUI environment (M2-T14). `CupmarkApp` builds it once from
/// the stage configuration and the `AuthSession` of `AuthModel`; nil when the stage is not
/// configured, so no backend is called.
private struct APIClientEnvironmentKey: EnvironmentKey {
    static let defaultValue: APIClient? = nil
}

extension EnvironmentValues {
    var apiClient: APIClient? {
        get { self[APIClientEnvironmentKey.self] }
        set { self[APIClientEnvironmentKey.self] = newValue }
    }
}
