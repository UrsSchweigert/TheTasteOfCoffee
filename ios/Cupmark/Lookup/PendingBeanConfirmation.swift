import Foundation
import Observation
import SwiftUI

/// The questions about pending beans (M2-T25). A barcode scanned offline is looked up by the
/// outbox once online. The user is asked the next time the app is opened:
/// - an Open Food Facts hit: Confirm creates the bean with the hit and the optional picks;
///   "Not my coffee" asks for a description instead;
/// - no hit, or a rejected one (docs/04 F1 step 4): the user describes the bean with pick lists
///   and a label photo, as online (`BeanEntryScreen` in its describing mode), or skips that,
///   which creates the bean from its barcode alone.
/// The shelf entries and brews that wait for the bean go out after it. Beans without a shelf
/// entry are not asked about.
///
/// Like every screen, it writes through `AccountStore` only (ADR 0025). No Open Food Facts text
/// is ever sent: the server copies it from its own cache (ADR 0005).
@MainActor
@Observable
final class PendingBeansModel {
    typealias Prompt = PendingBeanQuestion

    /// The questions to answer, in queue order. The screen shows the first.
    private(set) var prompts: [Prompt] = []
    /// The optional picks sent with the confirmation of the first hit.
    var picks = API.BeanAttributes()
    /// True when the last read or answer could not be saved; nothing was changed then.
    private(set) var failed = false

    let store: AccountStore

    init(store: AccountStore) {
        self.store = store
    }

    /// The question to answer now.
    var current: Prompt? {
        prompts.first
    }

    /// Reads the questions again.
    func reload() {
        do {
            let previous = current
            prompts = try store.pendingBeanQuestions()
            if current != previous {
                picks = API.BeanAttributes()
            }
            failed = false
        } catch {
            failed = true
        }
    }

    /// The user confirms the current hit.
    func confirm() {
        guard let prompt = current, case .confirm = prompt.kind else {
            return
        }
        answer { try self.store.confirmOpenFoodFacts(beanLocalID: prompt.beanID, picks: self.picks) }
    }

    /// The user says the current hit is not their coffee: the same bean is asked about again,
    /// now for a description.
    func reject() {
        guard let prompt = current, case .confirm = prompt.kind else {
            return
        }
        answer { try self.store.rejectOpenFoodFacts(beanLocalID: prompt.beanID) }
    }

    /// The user skips the description of the current bean: it is created from its barcode.
    func skip() {
        guard let prompt = current, prompt.kind == .describe else {
            return
        }
        answer { try self.store.skipDescription(beanLocalID: prompt.beanID) }
    }

    private func answer(_ write: () throws -> Bool) {
        do {
            _ = try write()
            picks = API.BeanAttributes()
            reload()
        } catch {
            // The write changed nothing: `AccountStore.write` put the bean and its question back
            // to their saved values and dropped what it inserted, so the same answer can be
            // given again.
            failed = true
        }
    }
}

/// Asks each question about a pending bean, one after the other: the online confirmation form
/// (`OpenFoodFactsConfirmView`) for a hit, the pick-list entry with its label photo
/// (`BeanEntryScreen`) for a description, with "Skip". "Later" closes it; the shelf asks again
/// the next time the app is opened, and its row opens it at any time.
struct PendingBeansScreen: View {
    @Bindable var model: PendingBeansModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.apiClient) private var apiClient
    @Environment(AuthModel.self) private var auth: AuthModel?
    @Environment(\.dismiss) private var dismiss
    /// The pick-list entry of the current description, made when the question shows.
    @State private var entry: BeanEntryModel?

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
                if model.current?.kind == .describe {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            model.skip()
                            closeWhenAnswered()
                        } label: {
                            Text(L10n.pendingBeansSkip)
                        }
                        .accessibilityHint(Text(L10n.pendingBeansSkipHint))
                        .accessibilityIdentifier("pending-beans-skip")
                    }
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
                prepareEntry()
            }
            .onChange(of: model.current) { _, _ in
                prepareEntry()
            }
            .onChange(of: entry?.state) { _, state in
                // The description was written: on to the next question.
                if case .savedOffline? = state {
                    model.reload()
                    closeWhenAnswered()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let prompt = model.current {
            switch prompt.kind {
            case .confirm(let product):
                OpenFoodFactsConfirmView(
                    product: product,
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
                    }
                )
                .id(prompt.beanID)
            case .describe:
                if let entry, entry.describing == prompt.beanID {
                    BeanEntryScreen(model: entry, vocabulary: vocabulary, language: language, shelf: nil)
                        .id(prompt.beanID)
                } else {
                    ProgressView()
                }
            }
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

    /// The pick-list entry for the current description, if there is one and it is not made yet.
    private func prepareEntry() {
        guard let prompt = model.current, prompt.kind == .describe else {
            entry = nil
            return
        }
        guard entry?.describing != prompt.beanID, let apiClient else {
            return
        }
        let labelPhotos = auth.flatMap { auth in
            auth.accountID.map { LabelPhotoAccount.live(account: $0, session: auth.session) }
        }
        entry = BeanEntryModel(
            barcode: prompt.barcode,
            client: apiClient,
            labelPhotos: labelPhotos,
            offlineStore: model.store,
            describing: prompt.beanID
        )
    }

    /// Closes the sheet once the last question is answered.
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
