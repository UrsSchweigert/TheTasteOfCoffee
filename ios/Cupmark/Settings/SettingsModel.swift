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
    /// Whether brew photos are in the device backup (M2-T45): per device, off by default.
    private(set) var brewPhotosInBackup = false
    /// The backup flag of a photo folder or file could not be set; the setting is stored and
    /// is tried again at the next store open.
    private(set) var backupApplyFailed = false

    @ObservationIgnored private let preferredLanguages: () -> [String]
    @ObservationIgnored private let backup: BrewPhotoBackupSetting
    @ObservationIgnored private let folders: BrewPhotoFolders?

    /// `backup` is the device's setting; `folders` are the brew photo folders of every account
    /// on the device (nil: only the open store's folder is set).
    init(
        store: AccountStore,
        preferredLanguages: @escaping () -> [String] = { Locale.preferredLanguages },
        backup: BrewPhotoBackupSetting = .standard,
        folders: BrewPhotoFolders? = .standard
    ) {
        self.store = store
        self.preferredLanguages = preferredLanguages
        self.backup = backup
        self.folders = folders
        reload()
    }

    /// Stores the backup setting on the device and applies it to the folders and files of the
    /// brew photos (`isExcludedFromBackup`). Nothing is written to the store, queued or sent.
    func setBrewPhotosInBackup(_ value: Bool) {
        backup.isIncluded = value
        brewPhotosInBackup = value
        // On the main actor on purpose: one flag per file, a few microseconds each, and the
        // switch must show the result at once and stay deterministic in tests. The shared
        // folders include the open store's own, so it is set once; without them (tests, the
        // UI-test launch) only the open store's folder is set.
        let applied = folders?.applyBackupSettingToAllFolders() ?? store.applyBrewPhotoBackupSetting()
        store.brewPhotoBackupApplyFailed = !applied
        backupApplyFailed = !applied
    }

    func reload() {
        brewPhotosInBackup = backup.isIncluded
        backupApplyFailed = store.brewPhotoBackupApplyFailed
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
