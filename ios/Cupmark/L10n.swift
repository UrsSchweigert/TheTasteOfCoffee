import SwiftUI

/// Keys of the String Catalog, `Localizable.xcstrings`. Every user-visible
/// string that is not a vocabulary label goes through here; vocabulary labels
/// come from contracts/i18n through `VocabularyStore`.
/// `scripts/check-ios-strings.mjs` checks that each key below exists in the
/// catalog with English and German, and that the catalog has no unused key.
enum L10n {
    static var appTitle: LocalizedStringKey { "app.title" }
    static var rootMethodsHeader: LocalizedStringKey { "root.methods.header" }
    static var rootVocabularyErrorTitle: LocalizedStringKey { "root.vocabulary_error.title" }
    static var rootVocabularyErrorMessage: LocalizedStringKey { "root.vocabulary_error.message" }
    static var rootScanBag: LocalizedStringKey { "root.scan_bag" }
    static var scannerTitle: LocalizedStringKey { "scanner.title" }
    static var scannerChecking: LocalizedStringKey { "scanner.checking" }
    static var scannerHint: LocalizedStringKey { "scanner.hint" }
    static var scannerCameraAccessibility: LocalizedStringKey { "scanner.camera.accessibility" }
    static var scannerPickListEntry: LocalizedStringKey { "scanner.pick_list_entry" }
    static var scannerOpenSettings: LocalizedStringKey { "scanner.open_settings" }
    static var scannerScannedTitle: LocalizedStringKey { "scanner.scanned.title" }
    static var scannerUnsupportedTitle: LocalizedStringKey { "scanner.unsupported.title" }
    static var scannerUnsupportedMessage: LocalizedStringKey { "scanner.unsupported.message" }
    static var scannerPermissionDeniedTitle: LocalizedStringKey { "scanner.permission_denied.title" }
    static var scannerPermissionDeniedMessage: LocalizedStringKey { "scanner.permission_denied.message" }
    static var scannerNotAvailableTitle: LocalizedStringKey { "scanner.not_available.title" }
    static var scannerNotAvailableMessage: LocalizedStringKey { "scanner.not_available.message" }
    static var notConfiguredTitle: LocalizedStringKey { "not_configured.title" }
    static var notConfiguredMessage: LocalizedStringKey { "not_configured.message" }
}
