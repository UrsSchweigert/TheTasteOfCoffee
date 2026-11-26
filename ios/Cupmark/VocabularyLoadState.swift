import Foundation

/// The result of loading the bundled vocabulary at launch.
enum VocabularyLoadState: Sendable {
    case loaded(VocabularyStore, VocabularyLanguage)
    case failed(VocabularyError)

    static func load(from bundle: Bundle) -> VocabularyLoadState {
        do {
            let store = try VocabularyStore.load(from: bundle)
            return .loaded(store, VocabularyLanguage.current)
        } catch let error as VocabularyError {
            return .failed(error)
        } catch {
            return .failed(.invalidJSON(String(describing: type(of: error))))
        }
    }
}
