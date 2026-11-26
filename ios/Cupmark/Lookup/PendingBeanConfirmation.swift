import Foundation
import Observation
import SwiftUI

/// The Open Food Facts hits of pending beans that wait for the user (M2-T25). A barcode
/// scanned offline is looked up by the outbox once online; a hit is kept on the bean and the
/// user is asked the next time the app is opened. Confirm creates the bean with the hit and the
/// optional picks; Reject creates it from its barcode alone. Either way the shelf entries and
/// brews that waited for the bean go out after it.
///
/// Like every screen, it writes through `AccountStore` only (ADR 0025). No Open Food Facts text
/// is ever sent: the server copies it from its own cache (ADR 0005).
@MainActor
@Observable
final class PendingBeansModel {
    struct Prompt: Identifiable, Equatable, Sendable {
        /// The pending bean's local id.
        let id: UUID
        /// Untrusted Open Food Facts text, shown with `Text(verbatim:)` only.
        let product: API.OpenFoodFactsProduct
    }

    /// The hits to answer, in queue order. The screen shows the first.
    private(set) var prompts: [Prompt] = []
    /// The optional picks sent with the confirmation of the first hit.
    var picks = API.BeanAttributes()
    /// True when the last read or answer could not be saved; nothing was changed then.
    private(set) var failed = false

    let store: AccountStore

    init(store: AccountStore) {
        self.store = store
    }

    /// The hit to answer now.
    var current: Prompt? {
        prompts.first
    }

    /// Reads the beans waiting for an answer again.
    func reload() {
        do {
            let previous = current?.id
            prompts = try store.beansAwaitingConfirmation().compactMap { bean in
                bean.heldOpenFoodFactsProduct.map { product in Prompt(id: bean.localID, product: product) }
            }
            if current?.id != previous {
                picks = API.BeanAttributes()
            }
            failed = false
        } catch {
            failed = true
        }
    }

    /// The user confirms the current hit.
    func confirm() {
        guard let prompt = current else {
            return
        }
        answer { try self.store.confirmOpenFoodFacts(beanLocalID: prompt.id, picks: self.picks) }
    }

    /// The user says the current hit is not their coffee.
    func reject() {
        guard let prompt = current else {
            return
        }
        answer { try self.store.rejectOpenFoodFacts(beanLocalID: prompt.id) }
    }

    private func answer(_ write: () throws -> Bool) {
        do {
            _ = try write()
            picks = API.BeanAttributes()
            reload()
        } catch {
            // `AccountStore.save()` rolled the change back.
            failed = true
        }
    }
}

/// Asks about each Open Food Facts hit of a pending bean, one after the other, with the same
/// form as the online confirmation (`OpenFoodFactsConfirmView`). "Later" closes it; the shelf
/// asks again the next time the app is opened, and its row opens it at any time.
struct PendingBeansScreen: View {
    @Bindable var model: PendingBeansModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.apiClient) private var apiClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        content
            .navigationTitle(Text(L10n.pendingBeansTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Text(model.current == nil ? L10n.pendingBeansDone : L10n.pendingBeansLater)
                    }
                    .accessibilityIdentifier("pending-beans-close")
                }
            }
            .safeAreaInset(edge: .top) {
                if model.failed {
                    Label {
                        Text(L10n.pendingBeansSaveFailed)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.regularMaterial)
                }
            }
            .onAppear {
                model.reload()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let prompt = model.current {
            OpenFoodFactsConfirmView(
                product: prompt.product,
                isSaving: false,
                picks: $model.picks,
                vocabulary: vocabulary,
                language: language,
                loadImage: loadImage,
                onConfirm: {
                    model.confirm()
                    closeWhenAnswered()
                },
                onReject: {
                    model.reject()
                    closeWhenAnswered()
                }
            )
            .id(prompt.id)
        } else {
            ContentUnavailableView {
                Label {
                    Text(L10n.pendingBeansNoneTitle)
                } icon: {
                    Image(systemName: "checkmark.circle")
                        .accessibilityHidden(true)
                }
            } description: {
                Text(L10n.pendingBeansNoneMessage)
            }
        }
    }

    /// Closes the sheet once the last hit is answered.
    private func closeWhenAnswered() {
        if model.current == nil, !model.failed {
            dismiss()
        }
    }

    private var loadImage: CatalogueImageLoader {
        { [apiClient] imageID in
            guard let apiClient, let id = ResourceID(imageID) else {
                return nil
            }
            return try? await apiClient.catalogueImage(id)
        }
    }
}
