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
}
