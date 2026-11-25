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
struct AddToShelfBar: View {
    let bean: API.Bean
    let context: ShelfAddContext
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @State private var isAdding = false
    @State private var savedID: UUID?

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
        .sheet(isPresented: $isAdding, onDismiss: {
            // After the sheet is gone, so the shelf can close the flow without a clash.
            if let savedID {
                context.onSaved(savedID)
            }
        }) {
            NavigationStack {
                ShelfEntryEditorScreen(
                    store: context.store,
                    mode: .add(bean),
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
