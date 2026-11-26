import Foundation
import Observation

/// The Settings screen's state (M2-T29). For now the consent toggle (D1, ADR 0017); export
/// (M2-T30) and account deletion (M2-T31) add their own models next to it.
///
/// - The toggle shows the stored profile's `contribute_to_aggregates`, false without a profile.
/// - A change is written with `AccountStore.setProfile` (inside its `write { }`), which queues
///   `PUT /profile` in the same save; the outbox sends it when online. The locale stays as
///   stored, or follows the preferred language when the store has none.
/// - Consent gates nothing on the device: with it off the shelf, brews, ratings, recipes and
///   statistics work exactly the same. Only the server's aggregator (M3) reads it.
@MainActor
@Observable
final class SettingsModel {
    let store: AccountStore
    /// The consent as stored.
    private(set) var contributesToAggregates = false
    /// The store could not be read; the toggle is disabled.
    private(set) var loadFailed = false
    /// The last change could not be saved; the toggle shows the stored value again.
    private(set) var saveFailed = false

    @ObservationIgnored private let preferredLanguages: () -> [String]

    init(store: AccountStore, preferredLanguages: @escaping () -> [String] = { Locale.preferredLanguages }) {
        self.store = store
        self.preferredLanguages = preferredLanguages
        reload()
    }

    func reload() {
        do {
            contributesToAggregates = try store.profile()?.contributeToAggregates ?? false
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    /// Stores the consent and queues `PUT /profile`. The same value again writes nothing.
    func setContributesToAggregates(_ value: Bool) {
        saveFailed = false
        do {
            let current = try store.profile()
            if let current, current.contributeToAggregates == value {
                contributesToAggregates = value
                return
            }
            let locale = current?.locale ?? OnboardingRules.profileLocale(preferredLanguages: preferredLanguages())
            try store.setProfile(API.Profile(locale: locale, consent: API.Consent(contributeToAggregates: value)))
            contributesToAggregates = value
        } catch {
            saveFailed = true
            reload()
        }
    }
}
