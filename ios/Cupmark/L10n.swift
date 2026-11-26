import SwiftUI

/// Keys of the String Catalog, `Localizable.xcstrings`. Every user-visible
/// string that is not a vocabulary label goes through here; vocabulary labels
/// come from contracts/i18n through `VocabularyStore`.
/// `scripts/check-ios-strings.mjs` checks that each key below exists in the
/// catalog with English and German, and that the catalog has no unused key.
enum L10n {
    static var appTitle: LocalizedStringKey { "app.title" }
    /// VoiceOver's value of a control on a scale without a unit ("7.5 of 10", M2-T33); both
    /// numbers in the device locale. `bundle` is the app bundle; tests pass a language's `.lproj`.
    static func valueOfScale(_ value: String, of maximum: String, bundle: Bundle = .main) -> String { String(localized: "accessibility.value_of_scale \(value) \(maximum)", bundle: bundle) }
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
    static var signInRequiredByServer: LocalizedStringKey { "sign_in.required_by_server" }
    static var signInAccountDeleted: LocalizedStringKey { "sign_in.account_deleted" }
    static var signInOtherAccountDeleted: LocalizedStringKey { "sign_in.other_account_deleted" }
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
    /// Header of the entries a long pick list offers first (the grinders of recent brews).
    static var pickListRecent: LocalizedStringKey { "pick_list.recent" }
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
    static var beanEntryTitle: LocalizedStringKey { "bean_entry.title" }
    static var beanEntryBarcode: LocalizedStringKey { "bean_entry.barcode" }
    static var beanEntryPicksHeader: LocalizedStringKey { "bean_entry.picks.header" }
    static var beanEntryPicksFooter: LocalizedStringKey { "bean_entry.picks.footer" }
    static var beanEntrySave: LocalizedStringKey { "bean_entry.save" }
    static var beanEntryClear: LocalizedStringKey { "bean_entry.clear" }
    static var beanEntryRoastLevelClear: LocalizedStringKey { "bean_entry.roast_level.clear" }
    static var beanEntryRejectedTitle: LocalizedStringKey { "bean_entry.rejected.title" }
    static var beanEntryRejectedMessage: LocalizedStringKey { "bean_entry.rejected.message" }
    static var beanEntryFailedTitle: LocalizedStringKey { "bean_entry.failed.title" }
    static var beanEntryFailedMessage: LocalizedStringKey { "bean_entry.failed.message" }
    static var labelPhotoAttachedAccessibility: LocalizedStringKey { "label_photo.attached.accessibility" }
    static var labelPhotoFailedMessage: LocalizedStringKey { "label_photo.failed.message" }
    static var labelPhotoFailedTitle: LocalizedStringKey { "label_photo.failed.title" }
    static var labelPhotoFooter: LocalizedStringKey { "label_photo.footer" }
    static var labelPhotoHeader: LocalizedStringKey { "label_photo.header" }
    static var labelPhotoPermissionDenied: LocalizedStringKey { "label_photo.permission_denied" }
    static var labelPhotoPreparing: LocalizedStringKey { "label_photo.preparing" }
    static var labelPhotoRemove: LocalizedStringKey { "label_photo.remove" }
    static var labelPhotoRetake: LocalizedStringKey { "label_photo.retake" }
    static var labelPhotoTake: LocalizedStringKey { "label_photo.take" }
    static var labelPhotoUploadsHeader: LocalizedStringKey { "label_photo.uploads.header" }
    static var labelPhotoUploadsFooter: LocalizedStringKey { "label_photo.uploads.footer" }
    static var labelPhotoAddAnother: LocalizedStringKey { "label_photo.add_another" }
    static var labelPhotoUploading: LocalizedStringKey { "label_photo.uploading" }
    static var labelPhotoUploaded: LocalizedStringKey { "label_photo.uploaded.title" }
    static var labelPhotoUploadedMessage: LocalizedStringKey { "label_photo.uploaded.message" }
    static var labelPhotoRejectedTitle: LocalizedStringKey { "label_photo.rejected.title" }
    static var labelPhotoRejectedMessage: LocalizedStringKey { "label_photo.rejected.message" }
    static var labelPhotoUploadFailedTitle: LocalizedStringKey { "label_photo.upload_failed.title" }
    static var labelPhotoUploadFailedMessage: LocalizedStringKey { "label_photo.upload_failed.message" }
    static var labelPhotoSignInMessage: LocalizedStringKey { "label_photo.sign_in.message" }
    static var labelPhotoNotUploaded: LocalizedStringKey { "label_photo.not_uploaded" }
    static var labelPhotoNoMorePhotos: LocalizedStringKey { "label_photo.no_more_photos" }
    static var labelPhotoDailyLimit: LocalizedStringKey { "label_photo.daily_limit" }
    // Shelf, shelf entries and sync issues (M2-T18).
    static var shelfHeader: LocalizedStringKey { "shelf.header" }
    static var shelfEmpty: LocalizedStringKey { "shelf.empty" }
    static var shelfLoading: LocalizedStringKey { "shelf.loading" }
    static var shelfStoreErrorTitle: LocalizedStringKey { "shelf.store_error.title" }
    static var shelfStoreErrorMessage: LocalizedStringKey { "shelf.store_error.message" }
    static var shelfRoastDate: LocalizedStringKey { "shelf.roast_date" }
    static var shelfRoastDateUnknown: LocalizedStringKey { "shelf.roast_date.unknown" }
    static var shelfDaysSinceRoast: LocalizedStringKey { "shelf.days_since_roast" }
    static var shelfBrewCount: LocalizedStringKey { "shelf.brew_count" }
    static var shelfPurchaseDate: LocalizedStringKey { "shelf.purchase_date" }
    static var shelfBeanUnnamed: LocalizedStringKey { "shelf.bean.unnamed" }
    static var shelfRowIssue: LocalizedStringKey { "shelf.row.issue" }
    static var shelfAdd: LocalizedStringKey { "shelf.add" }
    static var shelfEntryAddTitle: LocalizedStringKey { "shelf.entry.add_title" }
    static var shelfEntryEditTitle: LocalizedStringKey { "shelf.entry.edit_title" }
    static var shelfEntryBeanHeader: LocalizedStringKey { "shelf.entry.bean_header" }
    static var shelfEntryDatesHeader: LocalizedStringKey { "shelf.entry.dates_header" }
    static var shelfEntryRoastDateKnown: LocalizedStringKey { "shelf.entry.roast_date_known" }
    static var shelfEntryBagHeader: LocalizedStringKey { "shelf.entry.bag_header" }
    static var shelfEntryBagSize: LocalizedStringKey { "shelf.entry.bag_size" }
    static var shelfEntryPriceBand: LocalizedStringKey { "shelf.entry.price_band" }
    static var shelfEntrySave: LocalizedStringKey { "shelf.entry.save" }
    static var shelfEntryCancel: LocalizedStringKey { "shelf.entry.cancel" }
    static var shelfEntryChangeBean: LocalizedStringKey { "shelf.entry.change_bean" }
    static var shelfEntryChooseBeanTitle: LocalizedStringKey { "shelf.entry.choose_bean_title" }
    static var shelfEntryDelete: LocalizedStringKey { "shelf.entry.delete" }
    static var shelfEntryDeleteConfirmTitle: LocalizedStringKey { "shelf.entry.delete.confirm_title" }
    static var shelfEntryLockedReason: LocalizedStringKey { "shelf.entry.locked_reason" }
    static var shelfEntryNotFound: LocalizedStringKey { "shelf.entry.not_found" }
    static var shelfEntrySaveFailed: LocalizedStringKey { "shelf.entry.save_failed" }
    static var shelfEntryOfflineNote: LocalizedStringKey { "shelf.entry.offline_note" }
    static var syncIssuesTitle: LocalizedStringKey { "sync_issues.title" }
    static var syncIssuesNone: LocalizedStringKey { "sync_issues.none" }
    static var syncIssuesRetry: LocalizedStringKey { "sync_issues.retry" }
    static var syncIssuesDiscard: LocalizedStringKey { "sync_issues.discard" }
    static var syncIssuesDismiss: LocalizedStringKey { "sync_issues.dismiss" }
    static var syncIssuesDiscardConfirmTitle: LocalizedStringKey { "sync_issues.discard.confirm_title" }
    static var syncIssuesDiscardHasBrews: LocalizedStringKey { "sync_issues.discard.has_brews" }
    static var syncIssuesDiscardHasEntries: LocalizedStringKey { "sync_issues.discard.has_entries" }
    static var syncIssuesSaveFailed: LocalizedStringKey { "sync_issues.save_failed" }
    static var syncIssuesLoadFailed: LocalizedStringKey { "sync_issues.load_failed" }
    static var syncIssuesProfile: LocalizedStringKey { "sync_issues.profile" }
    static var syncIssuesRecipe: LocalizedStringKey { "sync_issues.recipe" }
    static var syncIssuesBrew: LocalizedStringKey { "sync_issues.brew" }
    static var syncIssuesRejectedCreateTitle: LocalizedStringKey { "sync_issues.rejected_create.title" }
    static var syncIssuesRejectedCreateMessage: LocalizedStringKey { "sync_issues.rejected_create.message" }
    static var syncIssuesRejectedUpdateTitle: LocalizedStringKey { "sync_issues.rejected_update.title" }
    static var syncIssuesRejectedUpdateMessage: LocalizedStringKey { "sync_issues.rejected_update.message" }
    static var syncIssuesRejectedDeleteTitle: LocalizedStringKey { "sync_issues.rejected_delete.title" }
    static var syncIssuesRejectedDeleteMessage: LocalizedStringKey { "sync_issues.rejected_delete.message" }
    static var syncIssuesRejectedTitle: LocalizedStringKey { "sync_issues.rejected.title" }
    static var syncIssuesRejectedMessage: LocalizedStringKey { "sync_issues.rejected.message" }
    static var syncIssuesBeanChangeRevertedTitle: LocalizedStringKey { "sync_issues.bean_change_reverted.title" }
    static var syncIssuesBeanChangeRevertedMessage: LocalizedStringKey { "sync_issues.bean_change_reverted.message" }
    static var syncIssuesDeleteRestoredTitle: LocalizedStringKey { "sync_issues.delete_restored.title" }
    static var syncIssuesDeleteRestoredMessage: LocalizedStringKey { "sync_issues.delete_restored.message" }
    // Brew form (M2-T19).
    static var brewStart: LocalizedStringKey { "brew.start" }
    static var brewTitle: LocalizedStringKey { "brew.title" }
    static var brewCancel: LocalizedStringKey { "brew.cancel" }
    static var brewSave: LocalizedStringKey { "brew.save" }
    static var brewBeanHeader: LocalizedStringKey { "brew.bean_header" }
    static var brewMethod: LocalizedStringKey { "brew.method" }
    static var brewMethodChoose: LocalizedStringKey { "brew.method.choose" }
    static var brewMethodFooter: LocalizedStringKey { "brew.method.footer" }
    static var brewAmountsHeader: LocalizedStringKey { "brew.amounts_header" }
    static var brewDose: LocalizedStringKey { "brew.dose" }
    static var brewDoseClear: LocalizedStringKey { "brew.dose.clear" }
    static var brewWater: LocalizedStringKey { "brew.water" }
    static var brewWaterClear: LocalizedStringKey { "brew.water.clear" }
    static var brewRatio: LocalizedStringKey { "brew.ratio" }
    static var brewRatioAccessibility: LocalizedStringKey { "brew.ratio.accessibility" }
    static var brewRatioMissing: LocalizedStringKey { "brew.ratio.missing" }
    /// The ratio as shown ("1:16.2"); the catalog value places `%@`, the number in the device locale.
    /// `bundle` is the app bundle; tests pass a language's `.lproj` bundle.
    static func brewRatioValue(_ number: String, bundle: Bundle = .main) -> String { String(localized: "brew.ratio.value \(number)", bundle: bundle) }
    static var brewWaterHeader: LocalizedStringKey { "brew.water_header" }
    static var brewTemperature: LocalizedStringKey { "brew.temperature" }
    static var brewTemperatureHeated: LocalizedStringKey { "brew.temperature.heated" }
    static var brewTemperatureValue: LocalizedStringKey { "brew.temperature.value" }
    static var brewTemperatureClear: LocalizedStringKey { "brew.temperature.clear" }
    static var brewWaterType: LocalizedStringKey { "brew.water_type" }
    static var brewMoreHeader: LocalizedStringKey { "brew.more_header" }
    static var brewGrind: LocalizedStringKey { "brew.grind" }
    static var brewGrindClear: LocalizedStringKey { "brew.grind.clear" }
    static var brewGrinder: LocalizedStringKey { "brew.grinder" }
    static var brewGrindSetting: LocalizedStringKey { "brew.grind_setting" }
    static var brewGrindSettingClear: LocalizedStringKey { "brew.grind_setting.clear" }
    static var brewMilk: LocalizedStringKey { "brew.milk" }
    static var brewOfflineNote: LocalizedStringKey { "brew.offline_note" }
    static var brewNotFound: LocalizedStringKey { "brew.not_found" }
    static var brewSaveFailed: LocalizedStringKey { "brew.save_failed" }
    static var brewTimer: LocalizedStringKey { "brew.timer" }
    static var brewTimerHeader: LocalizedStringKey { "brew.timer.header" }
    static var brewTimerFooter: LocalizedStringKey { "brew.timer.footer" }
    static var brewTimerStart: LocalizedStringKey { "brew.timer.start" }
    static var brewTimerStartHint: LocalizedStringKey { "brew.timer.start.hint" }
    static var brewTimerStop: LocalizedStringKey { "brew.timer.stop" }
    static var brewTimerStopHint: LocalizedStringKey { "brew.timer.stop.hint" }
    static var brewTimerReset: LocalizedStringKey { "brew.timer.reset" }
    static var brewTimerResetHint: LocalizedStringKey { "brew.timer.reset.hint" }
    // VoiceOver announcements are posted as text, so these are looked up as a String.
    static var brewTimerAnnounceStarted: String { String(localized: "brew.timer.announce.started") }
    /// The stop announcement with the brew time in words; the catalog value places `%@`.
    static func brewTimerAnnounceStopped(time: String) -> String { String(localized: "brew.timer.announce.stopped_with_time \(time)") }
    static var brewTimerAnnounceReset: String { String(localized: "brew.timer.announce.reset") }
    // Brew list and rating (M2-T20).
    static var brewListTitle: LocalizedStringKey { "brew_list.title" }
    static var brewListEmpty: LocalizedStringKey { "brew_list.empty" }
    static var brewListRated: LocalizedStringKey { "brew_list.rated" }
    static var brewListNotRated: LocalizedStringKey { "brew_list.not_rated" }
    static var ratingTitle: LocalizedStringKey { "rating.title" }
    static var ratingSave: LocalizedStringKey { "rating.save" }
    static var ratingLater: LocalizedStringKey { "rating.later" }
    static var ratingBrewHeader: LocalizedStringKey { "rating.brew_header" }
    static var ratingBrewedAt: LocalizedStringKey { "rating.brewed_at" }
    static var ratingUseLast: LocalizedStringKey { "rating.use_last" }
    static var ratingUseLastFooter: LocalizedStringKey { "rating.use_last.footer" }
    static var ratingScoresHeader: LocalizedStringKey { "rating.scores.header" }
    static var ratingScoresFooter: LocalizedStringKey { "rating.scores.footer" }
    static var ratingScoresMissing: LocalizedStringKey { "rating.scores.missing" }
    static var ratingIntensityHeader: LocalizedStringKey { "rating.intensity.header" }
    static var ratingIntensityFooter: LocalizedStringKey { "rating.intensity.footer" }
    static var ratingIntensityClear: LocalizedStringKey { "rating.intensity.clear" }
    static var ratingNotesHeader: LocalizedStringKey { "rating.notes.header" }
    static var ratingNotesChoose: LocalizedStringKey { "rating.notes.choose" }
    static var ratingNotesFooter: LocalizedStringKey { "rating.notes.footer" }
    static var ratingNotesPicked: LocalizedStringKey { "rating.notes.picked" }
    static var ratingNotesMax: LocalizedStringKey { "rating.notes.max" }
    static var ratingNotesFull: LocalizedStringKey { "rating.notes.full" }
    static var ratingNoteRemoveHint: LocalizedStringKey { "rating.note.remove_hint" }
    static var ratingBuyAgain: LocalizedStringKey { "rating.buy_again" }
    static var ratingBuyAgainYes: LocalizedStringKey { "rating.buy_again.yes" }
    static var ratingBuyAgainNo: LocalizedStringKey { "rating.buy_again.no" }
    static var ratingBuyAgainClear: LocalizedStringKey { "rating.buy_again.clear" }
    static var ratingNotFound: LocalizedStringKey { "rating.not_found" }
    static var ratingIncomplete: LocalizedStringKey { "rating.incomplete" }
    static var ratingReadOnly: LocalizedStringKey { "rating.read_only" }
    static var signInAgainTitle: LocalizedStringKey { "sign_in_again.title" }
    static var signInAgainMessage: LocalizedStringKey { "sign_in_again.message" }
    static var signInAgainButton: LocalizedStringKey { "sign_in_again.button" }
    // Offline scan and pending beans (M2-T25)
    static var pendingBeansSkip: LocalizedStringKey { "pending_beans.skip" }
    static var pendingBeansSkipHint: LocalizedStringKey { "pending_beans.skip.hint" }
    static var shelfRowBeanAwaitingDescription: LocalizedStringKey { "shelf.row.bean_awaiting_description" }
    static var beanEntryPhotoNotSavedTitle: LocalizedStringKey { "bean_entry.photo_not_saved.title" }
    static var beanEntryPhotoNotSavedMessage: LocalizedStringKey { "bean_entry.photo_not_saved.message" }
    static var beanEntryNoStoreTitle: LocalizedStringKey { "bean_entry.no_store.title" }
    static var beanEntryNoStoreMessage: LocalizedStringKey { "bean_entry.no_store.message" }
    static var beanEntryPicksNotKept: LocalizedStringKey { "bean_entry.picks_not_kept" }
    static var lookupKeepForLater: LocalizedStringKey { "lookup.keep_for_later" }
    static var lookupKeepForLaterHint: LocalizedStringKey { "lookup.keep_for_later.hint" }
    static var lookupPendingTitle: LocalizedStringKey { "lookup.pending.title" }
    static var lookupPendingMessage: LocalizedStringKey { "lookup.pending.message" }
    static var beanEntrySavedOfflineTitle: LocalizedStringKey { "bean_entry.saved_offline.title" }
    static var beanEntrySavedOfflineMessage: LocalizedStringKey { "bean_entry.saved_offline.message" }
    static var shelfRowBeanLookingUp: LocalizedStringKey { "shelf.row.bean_looking_up" }
    static var shelfRowBeanAwaitingConfirmation: LocalizedStringKey { "shelf.row.bean_awaiting_confirmation" }
    static var pendingBeansRow: LocalizedStringKey { "pending_beans.row" }
    static var pendingBeansTitle: LocalizedStringKey { "pending_beans.title" }
    static var pendingBeansLater: LocalizedStringKey { "pending_beans.later" }
    static var pendingBeansDone: LocalizedStringKey { "pending_beans.done" }
    static var pendingBeansNoneTitle: LocalizedStringKey { "pending_beans.none.title" }
    static var pendingBeansNoneMessage: LocalizedStringKey { "pending_beans.none.message" }
    static var pendingBeansSaveFailed: LocalizedStringKey { "pending_beans.save_failed" }
    // Personal statistics (M2-T28, ADR 0027)
    static var statisticsTitle: LocalizedStringKey { "statistics.title" }
    static var statisticsLoading: LocalizedStringKey { "statistics.loading" }
    static var statisticsLoadFailed: LocalizedStringKey { "statistics.load_failed" }
    static var statisticsBrewsHeader: LocalizedStringKey { "statistics.brews.header" }
    static var statisticsBrewsTotal: LocalizedStringKey { "statistics.brews.total" }
    static var statisticsBrewsRated: LocalizedStringKey { "statistics.brews.rated" }
    static var statisticsBrewsEmpty: LocalizedStringKey { "statistics.brews.empty" }
    static var statisticsWeeksHeader: LocalizedStringKey { "statistics.weeks.header" }
    /// The weeks footer; the catalog value places `%@`, the number of weeks.
    static func statisticsWeeksFooter(weeks: String) -> String { String(localized: "statistics.weeks.footer \(weeks)") }
    static var statisticsNoRatings: LocalizedStringKey { "statistics.no_ratings" }
    static var statisticsNoKnownScores: LocalizedStringKey { "statistics.no_known_scores" }
    static var statisticsTasteProfileHeader: LocalizedStringKey { "statistics.taste_profile.header" }
    static var statisticsTasteProfileFooter: LocalizedStringKey { "statistics.taste_profile.footer" }
    static var statisticsMethodsHeader: LocalizedStringKey { "statistics.methods.header" }
    /// Shown while no method has enough rated brews; `%@` is that number.
    static func statisticsMethodsNone(brews: String) -> String { String(localized: "statistics.methods.none \(brews)") }
    /// A method's taste profile header; `%@` is the method's vocabulary label.
    static func statisticsMethodProfileHeader(method: String) -> String { String(localized: "statistics.method_profile.header \(method)") }
    static var statisticsNotesHeader: LocalizedStringKey { "statistics.notes.header" }
    static var statisticsNotesFooter: LocalizedStringKey { "statistics.notes.footer" }
    static var statisticsNotesEmpty: LocalizedStringKey { "statistics.notes.empty" }
    static var statisticsBestHeader: LocalizedStringKey { "statistics.best.header" }
    static var statisticsBestMethod: LocalizedStringKey { "statistics.best.method" }
    static var statisticsBestBean: LocalizedStringKey { "statistics.best.bean" }
    static var statisticsBestNone: LocalizedStringKey { "statistics.best.none" }
    /// The "best" footer; `%@` is the number of rated brews a method or bean needs.
    static func statisticsBestFooter(brews: String) -> String { String(localized: "statistics.best.footer \(brews)") }
    static var statisticsMeanOverall: LocalizedStringKey { "statistics.mean_overall" }
    static var statisticsBuyAgainHeader: LocalizedStringKey { "statistics.buy_again.header" }
    static var statisticsBuyAgainShare: LocalizedStringKey { "statistics.buy_again.share" }
    static var statisticsBuyAgainAnswered: LocalizedStringKey { "statistics.buy_again.answered" }
    static var statisticsBuyAgainEmpty: LocalizedStringKey { "statistics.buy_again.empty" }
    static var statisticsBuyAgainFooter: LocalizedStringKey { "statistics.buy_again.footer" }
    // My brews of this coffee, on the shelf entry screen (M2-T44).
    static var coffeeAveragesHeader: LocalizedStringKey { "coffee_averages.header" }
    static var coffeeAveragesEmpty: LocalizedStringKey { "coffee_averages.empty" }
    static var coffeeAveragesRatedCount: LocalizedStringKey { "coffee_averages.rated_count" }
    static var coffeeAveragesFooterMany: LocalizedStringKey { "coffee_averages.footer_many" }
    static var coffeeAveragesFooterSingle: LocalizedStringKey { "coffee_averages.footer_single" }
    /// A method's averages header; the catalog value places `%1$@`, the method's label, and `%2$@`, its rated brews.
    static func coffeeAveragesMethodHeader(method: String, brews: String) -> String { String(localized: "coffee_averages.method_header \(method) \(brews)") }
    /// The community mean next to the user's own (M4); `%1$@` is the mean, `%2$@` the number of raters.
    static func coffeeAveragesCommunity(mean: String, raters: String) -> String { String(localized: "coffee_averages.community \(mean) \(raters)") }
    // Recipes and repeats (M2-T27).
    static var brewRepeatLast: LocalizedStringKey { "brew.repeat_last" }
    static var brewRepeatHint: LocalizedStringKey { "brew.repeat.hint" }
    static var brewRepeatHeader: LocalizedStringKey { "brew.repeat.header" }
    static var brewRepeatFooter: LocalizedStringKey { "brew.repeat.footer" }
    static var brewStartedFromLastBrew: LocalizedStringKey { "brew.started_from.last_brew" }
    static var brewStartedFromRecipe: LocalizedStringKey { "brew.started_from.recipe" }
    static var brewStartNotFound: LocalizedStringKey { "brew.start_not_found" }
    static var brewRecipeSave: LocalizedStringKey { "brew.recipe.save" }
    static var brewRecipeUpdate: LocalizedStringKey { "brew.recipe.update" }
    static var recipeHeader: LocalizedStringKey { "recipe.header" }
    static var recipeFooter: LocalizedStringKey { "recipe.footer" }
    static var recipeListTitle: LocalizedStringKey { "recipe_list.title" }
    static var recipeEmpty: LocalizedStringKey { "recipe_list.empty" }
    static var recipeDeleteFailed: LocalizedStringKey { "recipe_list.delete_failed" }
    static var recipeUnknownMethod: LocalizedStringKey { "recipe.unknown_method" }
    static var brewListSaveAsRecipe: LocalizedStringKey { "brew_list.save_as_recipe" }
    static var brewListIsRecipe: LocalizedStringKey { "brew_list.is_recipe" }
    static var brewListRecipeSaveFailed: LocalizedStringKey { "brew_list.recipe_save_failed" }
    /// The grind in a recipe or brew summary; the catalog value places `%@`.
    static func recipeGrindValue(_ value: String) -> String { String(localized: "recipe.grind_value \(value)") }
    /// Between the values of a recipe or brew summary (" · ").
    static var recipeSummarySeparator: String { String(localized: "recipe.summary.separator") }
    static var brewRecipeAlreadyKept: LocalizedStringKey { "brew.recipe.already_kept" }
    static var ratingUseLastSameBean: LocalizedStringKey { "rating.use_last.same_bean" }
    static var ratingUseLastRepeatedBrew: LocalizedStringKey { "rating.use_last.repeated_brew" }
    // Onboarding and consent (M2-T29, docs/07 D1, ADR 0017).
    static var onboardingChecking: LocalizedStringKey { "onboarding.checking" }
    /// "Step 1 of 3"; the catalog value places the step and the count, both `%@`.
    static func onboardingStep(_ current: String, of total: String) -> String { String(localized: "onboarding.step \(current) \(total)") }
    static var onboardingLogTitle: LocalizedStringKey { "onboarding.log.title" }
    static var onboardingLogMessage: LocalizedStringKey { "onboarding.log.message" }
    static var onboardingPrivateTitle: LocalizedStringKey { "onboarding.private.title" }
    static var onboardingPrivateMessage: LocalizedStringKey { "onboarding.private.message" }
    static var onboardingConsentTitle: LocalizedStringKey { "onboarding.consent.title" }
    static var onboardingConsentMessage: LocalizedStringKey { "onboarding.consent.message" }
    static var onboardingConsentNotShared: LocalizedStringKey { "onboarding.consent.not_shared" }
    static var onboardingConsentAgree: LocalizedStringKey { "onboarding.consent.agree" }
    static var onboardingConsentChangeLater: LocalizedStringKey { "onboarding.consent.change_later" }
    static var onboardingNext: LocalizedStringKey { "onboarding.next" }
    static var onboardingFinish: LocalizedStringKey { "onboarding.finish" }
    static var onboardingSkip: LocalizedStringKey { "onboarding.skip" }
    static var onboardingSkipHint: LocalizedStringKey { "onboarding.skip.hint" }
    static var onboardingSaveFailed: LocalizedStringKey { "onboarding.save_failed" }
    // Settings (M2-T29).
    static var settingsTitle: LocalizedStringKey { "settings.title" }
    static var settingsLoadFailed: LocalizedStringKey { "settings.load_failed" }
    static var settingsPrivacyHeader: LocalizedStringKey { "settings.privacy.header" }
    static var settingsConsentToggle: LocalizedStringKey { "settings.consent.toggle" }
    static var settingsConsentHint: LocalizedStringKey { "settings.consent.hint" }
    static var settingsConsentFooter: LocalizedStringKey { "settings.consent.footer" }
    static var settingsConsentSaveFailed: LocalizedStringKey { "settings.consent.save_failed" }
    // Brew photos in the device backup (M2-T45).
    static var settingsPhotosHeader: LocalizedStringKey { "settings.photos.header" }
    static var settingsPhotoBackupToggle: LocalizedStringKey { "settings.photo_backup.toggle" }
    static var settingsPhotoBackupFooterOff: LocalizedStringKey { "settings.photo_backup.footer_off" }
    static var settingsPhotoBackupFooterOn: LocalizedStringKey { "settings.photo_backup.footer_on" }
    static var settingsPhotoBackupApplyFailed: LocalizedStringKey { "settings.photo_backup.apply_failed" }
    // Export and local data (M2-T30).
    static var exportTitle: LocalizedStringKey { "export.title" }
    static var exportStart: LocalizedStringKey { "export.start" }
    static var exportPreparing: LocalizedStringKey { "export.preparing" }
    static var exportFooter: LocalizedStringKey { "export.footer" }
    static var exportShare: LocalizedStringKey { "export.share" }
    static var exportDone: LocalizedStringKey { "export.done" }
    static var exportPendingChanges: LocalizedStringKey { "export.pending_changes" }
    static var exportFailedOffline: LocalizedStringKey { "export.failed.offline" }
    static var exportFailedTooLarge: LocalizedStringKey { "export.failed.too_large" }
    static var exportFailedSignIn: LocalizedStringKey { "export.failed.sign_in" }
    static var exportFailedTooManyRequests: LocalizedStringKey { "export.failed.too_many_requests" }
    static var exportFailedUnavailable: LocalizedStringKey { "export.failed.unavailable" }
    static var exportFailedFile: LocalizedStringKey { "export.failed.file" }
    static var localDataHeader: LocalizedStringKey { "local_data.header" }
    static var localDataRemove: LocalizedStringKey { "local_data.remove" }
    static var localDataRemoveConfirm: LocalizedStringKey { "local_data.remove.confirm" }
    static var localDataConfirmTitle: LocalizedStringKey { "local_data.confirm.title" }
    static var localDataConfirmMessage: LocalizedStringKey { "local_data.confirm.message" }
    static var localDataFooter: LocalizedStringKey { "local_data.footer" }
    static var localDataNone: LocalizedStringKey { "local_data.none" }
    static var localDataRemoved: LocalizedStringKey { "local_data.removed" }
    static var localDataFailed: LocalizedStringKey { "local_data.failed" }
    // Account deletion (M2-T31).
    static var accountDeletionTitle: LocalizedStringKey { "account_deletion.title" }
    static var accountDeletionSettingsFooter: LocalizedStringKey { "account_deletion.settings_footer" }
    static var accountDeletionWhatHeader: LocalizedStringKey { "account_deletion.what.header" }
    static var accountDeletionWhatData: LocalizedStringKey { "account_deletion.what.data" }
    static var accountDeletionWhatPhotos: LocalizedStringKey { "account_deletion.what.photos" }
    static var accountDeletionWhatSignIn: LocalizedStringKey { "account_deletion.what.sign_in" }
    static var accountDeletionWhatFooter: LocalizedStringKey { "account_deletion.what.footer" }
    static var accountDeletionContinue: LocalizedStringKey { "account_deletion.continue" }
    static var accountDeletionContinueHint: LocalizedStringKey { "account_deletion.continue.hint" }
    static var accountDeletionExportHint: LocalizedStringKey { "account_deletion.export_hint" }
    static var accountDeletionCouldNotStart: LocalizedStringKey { "account_deletion.could_not_start" }
    static var accountDeletionConfirmTitle: LocalizedStringKey { "account_deletion.confirm.title" }
    static var accountDeletionConfirmMessage: LocalizedStringKey { "account_deletion.confirm.message" }
    static var accountDeletionConfirm: LocalizedStringKey { "account_deletion.confirm" }
    static var accountDeletionProgressTitle: LocalizedStringKey { "account_deletion.progress.title" }
    static var accountDeletionProgressMessage: LocalizedStringKey { "account_deletion.progress.message" }
    static var accountDeletionRetrying: LocalizedStringKey { "account_deletion.retrying" }
    static var accountDeletionRetryNow: LocalizedStringKey { "account_deletion.retry_now" }
    static var accountDeletionSignInRequired: LocalizedStringKey { "account_deletion.sign_in_required" }
    static var accountDeletionSignInAgain: LocalizedStringKey { "account_deletion.sign_in_again" }
    static var accountDeletionCleanupFailed: LocalizedStringKey { "account_deletion.cleanup_failed" }
    static var accountDeletionSignInNote: LocalizedStringKey { "account_deletion.sign_in_note" }
    static var accountDeletionDifferentAccountMessage: LocalizedStringKey { "account_deletion.different_account.message" }
    static var accountDeletionUnreadableRecordMessage: LocalizedStringKey { "account_deletion.unreadable_record.message" }
    static var accountDeletionDeleteThisAccount: LocalizedStringKey { "account_deletion.delete_this_account" }
    static var accountDeletionDeleteThisAccountHint: LocalizedStringKey { "account_deletion.delete_this_account.hint" }
    static var accountDeletionSignOutInstead: LocalizedStringKey { "account_deletion.sign_out_instead" }
    static var accountDeletionSignOutInsteadHint: LocalizedStringKey { "account_deletion.sign_out_instead.hint" }
    static var brewPhotosHeader: LocalizedStringKey { "brew_photos.header" }
    static var brewPhotosFooter: LocalizedStringKey { "brew_photos.footer" }
    static func brewPhotosCount(_ count: String, of limit: String, bundle: Bundle = .main) -> String { String(localized: "brew_photos.count \(count) \(limit)", bundle: bundle) }
    static func brewPhotosSummary(_ count: String, of limit: String, bundle: Bundle = .main) -> String { String(localized: "brew_photos.summary \(count) \(limit)", bundle: bundle) }
    static var brewPhotosEmpty: LocalizedStringKey { "brew_photos.empty" }
    static var brewPhotosTake: LocalizedStringKey { "brew_photos.take" }
    static var brewPhotosPick: LocalizedStringKey { "brew_photos.pick" }
    static var brewPhotosAdding: LocalizedStringKey { "brew_photos.adding" }
    static func brewPhotosLimitReached(_ limit: String) -> String { String(localized: "brew_photos.limit_reached \(limit)") }
    static var brewPhotosPermissionDenied: LocalizedStringKey { "brew_photos.permission_denied" }
    static func brewPhotosItem(_ position: String, of count: String, bundle: Bundle = .main) -> String { String(localized: "brew_photos.item \(position) \(count)", bundle: bundle) }
    static func brewPhotosDelete(_ position: String, of count: String, bundle: Bundle = .main) -> String { String(localized: "brew_photos.delete \(position) \(count)", bundle: bundle) }
    static var brewPhotosDeleteShort: LocalizedStringKey { "brew_photos.delete.short" }
    static var brewPhotosFileMissing: LocalizedStringKey { "brew_photos.file_missing" }
    static var brewPhotosDeleteTitle: LocalizedStringKey { "brew_photos.delete.title" }
    static var brewPhotosDeleteMessage: LocalizedStringKey { "brew_photos.delete.message" }
    static var brewPhotosDeleteConfirm: LocalizedStringKey { "brew_photos.delete.confirm" }
    static var brewPhotosFailedUnreadable: LocalizedStringKey { "brew_photos.failed.unreadable" }
    static var brewPhotosFailedTooLarge: LocalizedStringKey { "brew_photos.failed.too_large" }
    static var brewPhotosFailedLimit: LocalizedStringKey { "brew_photos.failed.limit" }
    static var brewPhotosFailedBrewNotFound: LocalizedStringKey { "brew_photos.failed.brew_not_found" }
    static var brewPhotosFailedSave: LocalizedStringKey { "brew_photos.failed.save" }

    // Brew photo gallery (M2-T43)
    static var galleryTitle: LocalizedStringKey { "gallery.title" }
    static var gallerySummaryLabel: LocalizedStringKey { "gallery.summary.label" }
    static func galleryCount(_ count: String, bundle: Bundle = .main) -> String { String(localized: "gallery.count \(count)", bundle: bundle) }
    static func galleryCountFiltered(_ count: String, filter: String, bundle: Bundle = .main) -> String { String(localized: "gallery.count.filtered \(count) \(filter)", bundle: bundle) }
    static var galleryEmptyTitle: LocalizedStringKey { "gallery.empty.title" }
    static var galleryEmptyMessage: LocalizedStringKey { "gallery.empty.message" }
    static var galleryEmptyFiltered: LocalizedStringKey { "gallery.empty.filtered" }
    static var galleryFilterMethod: LocalizedStringKey { "gallery.filter.method" }
    static var galleryFilterBag: LocalizedStringKey { "gallery.filter.bag" }
    static var galleryFilterAnyMethod: LocalizedStringKey { "gallery.filter.any_method" }
    static var galleryFilterAnyBag: LocalizedStringKey { "gallery.filter.any_bag" }
    static var galleryFilterClear: LocalizedStringKey { "gallery.filter.clear" }
    static func galleryPhotoLabel(_ method: String, bag: String, date: String, bundle: Bundle = .main) -> String { String(localized: "gallery.photo.label \(method) \(bag) \(date)", bundle: bundle) }
    static func galleryPhotoBag(_ bean: String, bundle: Bundle = .main) -> String { String(localized: "gallery.photo.bag \(bean)", bundle: bundle) }
    static func galleryMethodUnknown(bundle: Bundle = .main) -> String { String(localized: "gallery.photo.method_unknown", bundle: bundle) }
    static func galleryNoBag(bundle: Bundle = .main) -> String { String(localized: "gallery.photo.no_bag", bundle: bundle) }
    static func galleryBagOption(_ bean: String, bought date: String, bundle: Bundle = .main) -> String { String(localized: "gallery.bag.option \(bean) \(date)", bundle: bundle) }
    static func galleryBeanUnnamed(bundle: Bundle = .main) -> String { String(localized: "gallery.bean.unnamed", bundle: bundle) }
    static var galleryViewerNotFound: LocalizedStringKey { "gallery.viewer.not_found" }
    static func galleryCountValueFiltered(_ count: String, filter: String, bundle: Bundle = .main) -> String { String(localized: "gallery.count.value.filtered \(count) \(filter)", bundle: bundle) }

    // Brew photo viewer (M2-T43b)
    static var viewerTitle: LocalizedStringKey { "viewer.title" }
    static var viewerDetailsHeader: LocalizedStringKey { "viewer.details.header" }
    static func viewerDetailMethod(bundle: Bundle = .main) -> String { String(localized: "viewer.detail.method", bundle: bundle) }
    static func viewerDetailDose(bundle: Bundle = .main) -> String { String(localized: "viewer.detail.dose", bundle: bundle) }
    static func viewerDetailRatio(bundle: Bundle = .main) -> String { String(localized: "viewer.detail.ratio", bundle: bundle) }
    static func viewerDetailTemperature(bundle: Bundle = .main) -> String { String(localized: "viewer.detail.temperature", bundle: bundle) }
    static func viewerDetailGrind(bundle: Bundle = .main) -> String { String(localized: "viewer.detail.grind", bundle: bundle) }
    static var viewerLinksHeader: LocalizedStringKey { "viewer.links.header" }
    static var viewerLinksFooter: LocalizedStringKey { "viewer.links.footer" }
    static var viewerLinkBrew: LocalizedStringKey { "viewer.link.brew" }
    static var viewerLinkBrewHint: LocalizedStringKey { "viewer.link.brew.hint" }
    static var viewerLinkBag: LocalizedStringKey { "viewer.link.bag" }
    static var viewerLinkBagHint: LocalizedStringKey { "viewer.link.bag.hint" }
    static var viewerLinkRecipe: LocalizedStringKey { "viewer.link.recipe" }
    static var viewerLinkRecipeHint: LocalizedStringKey { "viewer.link.recipe.hint" }
    static var viewerDeleteLabel: LocalizedStringKey { "viewer.delete.label" }
    static var viewerDeleteFailed: LocalizedStringKey { "viewer.delete.failed" }

    // Recipe screen reached from the viewer (M2-T43b)
    static var recipeDetailTitle: LocalizedStringKey { "recipe_detail.title" }
    static var recipeDetailBrew: LocalizedStringKey { "recipe_detail.brew" }
    static var recipeDetailBrewHint: LocalizedStringKey { "recipe_detail.brew.hint" }
    static var recipeDetailNotFound: LocalizedStringKey { "recipe_detail.not_found" }
}
