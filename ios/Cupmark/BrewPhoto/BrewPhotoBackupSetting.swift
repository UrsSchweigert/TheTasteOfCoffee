import Foundation

/// Whether the brew photos are part of the device backup (M2-T45, ADR 0033 addendum M2-T45).
///
/// - Per device: the flag is kept in `UserDefaults`, not in an account's store, because the
///   backup is a property of the phone and not of an account, and it must be known before any
///   store is open (a folder is created lazily). It is not part of the profile, never synced
///   and never sent. The privacy manifest declares the access (`CA92.1`).
/// - Off by default: the app's promise is that brew photos stay on the device, and an iCloud
///   backup copies them to Apple.
/// - It only decides `URLResourceValues.isExcludedFromBackup` of the photo folders and files
///   (`BrewPhotoFileStore.applyBackupSetting`). Nothing else changes with it: the store and the
///   label photos keep their own backup behaviour.
struct BrewPhotoBackupSetting: @unchecked Sendable {
    // `UserDefaults` is thread-safe, and the flag is one boolean.
    static let key = "brewPhotosIncludedInBackup"

    /// The device's setting.
    static let standard = BrewPhotoBackupSetting(defaults: .standard)

    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// Whether the photos are in the backup. False until the user turns it on.
    var isIncluded: Bool {
        get { defaults.bool(forKey: BrewPhotoBackupSetting.key) }
        nonmutating set { defaults.set(newValue, forKey: BrewPhotoBackupSetting.key) }
    }
}
