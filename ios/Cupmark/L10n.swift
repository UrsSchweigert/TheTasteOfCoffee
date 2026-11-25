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
    static var signInTitle: LocalizedStringKey { "sign_in.title" }
    static var signInMessage: LocalizedStringKey { "sign_in.message" }
    static var signInWithApple: LocalizedStringKey { "sign_in.apple_button" }
    static var signInInProgress: LocalizedStringKey { "sign_in.in_progress" }
    static var signInFailed: LocalizedStringKey { "sign_in.failed" }
    static var signInOffline: LocalizedStringKey { "sign_in.offline" }
    static var signInSessionExpired: LocalizedStringKey { "sign_in.session_expired" }
    static var authRestoring: LocalizedStringKey { "auth.restoring" }
    static var accountSignOut: LocalizedStringKey { "account.sign_out" }
    static var accountSignOutConfirmTitle: LocalizedStringKey { "account.sign_out.confirm_title" }
    static var lookupTitle: LocalizedStringKey { "lookup.title" }
    static var lookupLookingUp: LocalizedStringKey { "lookup.looking_up" }
    static var lookupSaving: LocalizedStringKey { "lookup.saving" }
    static var lookupConfirm: LocalizedStringKey { "lookup.confirm" }
    static var lookupReject: LocalizedStringKey { "lookup.reject" }
    static var lookupConfirmTitle: LocalizedStringKey { "lookup.confirm.title" }
    static var lookupConfirmMessage: LocalizedStringKey { "lookup.confirm.message" }
    static var lookupPicksHeader: LocalizedStringKey { "lookup.picks.header" }
    static var lookupPickNotSet: LocalizedStringKey { "lookup.pick.not_set" }
    static var lookupRetry: LocalizedStringKey { "lookup.retry" }
    static var lookupRejectedTitle: LocalizedStringKey { "lookup.rejected.title" }
    static var lookupRejectedMessage: LocalizedStringKey { "lookup.rejected.message" }
    static var lookupNoProductTitle: LocalizedStringKey { "lookup.no_product.title" }
    static var lookupNoProductMessage: LocalizedStringKey { "lookup.no_product.message" }
    static var lookupLimitTitle: LocalizedStringKey { "lookup.limit.title" }
    static var lookupLimitMessage: LocalizedStringKey { "lookup.limit.message" }
    static var lookupUnavailableTitle: LocalizedStringKey { "lookup.unavailable.title" }
    static var lookupUnavailableMessage: LocalizedStringKey { "lookup.unavailable.message" }
    static var lookupFailedTitle: LocalizedStringKey { "lookup.failed.title" }
    static var lookupFailedMessage: LocalizedStringKey { "lookup.failed.message" }
    static var openFoodFactsHeader: LocalizedStringKey { "open_food_facts.header" }
    static var openFoodFactsName: LocalizedStringKey { "open_food_facts.name" }
    static var openFoodFactsBrand: LocalizedStringKey { "open_food_facts.brand" }
    static var openFoodFactsAttribution: LocalizedStringKey { "open_food_facts.attribution" }
    static var openFoodFactsImageAccessibility: LocalizedStringKey { "open_food_facts.image.accessibility" }
    static var openFoodFactsImageLoading: LocalizedStringKey { "open_food_facts.image.loading" }
    static var beanVerified: LocalizedStringKey { "bean.verified" }
    static var beanUnverified: LocalizedStringKey { "bean.unverified" }
    static var beanVerifiedMessage: LocalizedStringKey { "bean.verified.message" }
    static var beanUnverifiedMessage: LocalizedStringKey { "bean.unverified.message" }
    static var beanAttributesHeader: LocalizedStringKey { "bean.attributes.header" }
    static var beanAttributesEmpty: LocalizedStringKey { "bean.attributes.empty" }
    static var beanAttributeOrigin: LocalizedStringKey { "bean.attribute.origin" }
    static var beanAttributeSpecies: LocalizedStringKey { "bean.attribute.species" }
    static var beanAttributeVariety: LocalizedStringKey { "bean.attribute.variety" }
    static var beanAttributeProcess: LocalizedStringKey { "bean.attribute.process" }
    static var beanAttributeRoastLevel: LocalizedStringKey { "bean.attribute.roast_level" }
    static var beanSourceOperator: LocalizedStringKey { "bean.source.operator" }
    static var beanSourcePicked: LocalizedStringKey { "bean.source.picked" }
}
