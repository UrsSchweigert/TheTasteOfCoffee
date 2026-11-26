import SwiftUI

/// Where the scan flow saves a shelf entry (M2-T18): the signed-in account's store, and what
/// happens once an entry was saved (the shelf closes the flow).
struct ShelfAddContext {
    let store: AccountStore
    /// Called with the new entry's local id once the form has closed.
    let onSaved: @MainActor (UUID) -> Void
}

/// The bar below a found, confirmed or created bean (F1 step 5): "Add to Shelf" opens the
/// shelf entry form for that bean in a sheet. The sheet hangs off this bar, so it is
/// presented by the screen the user sees, whichever screen of the scan flow that is.
/// A pending bean (M2-T25), already in the local store, is added by its local id; with
/// `presentsAtOnce` the form opens as soon as the bar appears, so "Add to Shelf Now" on the
/// lookup's fallback needs no second tap.
struct AddToShelfBar: View {
    let mode: ShelfEntryEditorModel.Mode
    let context: ShelfAddContext
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    let presentsAtOnce: Bool
    @State private var isAdding = false
    @State private var savedID: UUID?
    @State private var didPresentAtOnce = false

    /// A catalogue bean the API returned.
    init(bean: API.Bean, context: ShelfAddContext, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.mode = .add(bean)
        self.context = context
        self.vocabulary = vocabulary
        self.language = language
        self.presentsAtOnce = false
    }

    /// A bean in the local store, by its local id (a pending bean, M2-T25).
    init(
        storedBean localID: UUID,
        context: ShelfAddContext,
        vocabulary: VocabularyStore,
        language: VocabularyLanguage,
        presentsAtOnce: Bool = false
    ) {
        self.mode = .addStored(localID)
        self.context = context
        self.vocabulary = vocabulary
        self.language = language
        self.presentsAtOnce = presentsAtOnce
    }

    var body: some View {
        Button {
            savedID = nil
            isAdding = true
        } label: {
            Text(L10n.shelfAdd)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("add-to-shelf")
        .padding()
        .background(.regularMaterial)
        .onAppear {
            if presentsAtOnce, !didPresentAtOnce {
                didPresentAtOnce = true
                savedID = nil
                isAdding = true
            }
        }
        .sheet(isPresented: $isAdding, onDismiss: {
            // After the sheet is gone, so the shelf can close the flow without a clash.
            if let savedID {
                context.onSaved(savedID)
            }
        }) {
            NavigationStack {
                ShelfEntryEditorScreen(
                    store: context.store,
                    mode: mode,
                    vocabulary: vocabulary,
                    language: language,
                    onFinished: { localID in
                        savedID = localID
                    }
                )
            }
        }
    }
}
