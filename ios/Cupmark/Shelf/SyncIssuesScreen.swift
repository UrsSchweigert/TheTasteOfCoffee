import Combine
import SwiftUI

/// The items whose sync went wrong (M2-T18, ADR 0025), each with a way out:
/// - a parked operation (refused create, change or removal, also a 404-then-200 on `PUT` and
///   a refused removal of an item that stays hidden as `pendingDelete`): "Try again" queues it
///   again; "Discard" drops the local change, or removes an item the server never had;
/// - a flag only (bean change undone, bag restored): "OK" clears it.
/// After a discard the screen asks for a pull, so the server's values come back.
struct SyncIssuesScreen: View {
    @State private var model: SyncIssuesModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(SyncHost.self) private var sync: SyncHost?
    @State private var pendingDiscard: SyncIssueItem?

    init(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        _model = State(initialValue: SyncIssuesModel(store: store))
        self.vocabulary = vocabulary
        self.language = language
    }

    var body: some View {
        List {
            if let failure = model.failure {
                Section {
                    Label {
                        Text(SyncIssuesScreen.message(for: failure))
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("sync-issues-error")
                }
            }
            if model.rows.isEmpty {
                Section {
                    Text(L10n.syncIssuesNone)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(model.rows) { row in
                Section {
                    SyncIssueSubjectView(subject: row.subject, vocabulary: vocabulary, language: language)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(SyncIssueTexts.title(for: row.item.kind))
                            .font(.headline)
                        Text(SyncIssueTexts.message(for: row.item.kind))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    actions(for: row.item)
                }
            }
        }
        .navigationTitle(Text(L10n.syncIssuesTitle))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            L10n.syncIssuesDiscardConfirmTitle,
            isPresented: isConfirmingDiscard,
            titleVisibility: .visible,
            presenting: pendingDiscard
        ) { item in
            Button(role: .destructive) {
                if model.discard(item) {
                    sync?.requestPull()
                }
            } label: {
                Text(L10n.syncIssuesDiscard)
            }
        }
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            model.reload()
        }
    }

    @ViewBuilder
    private func actions(for item: SyncIssueItem) -> some View {
        if item.isParked {
            Button {
                _ = model.redo(item)
            } label: {
                Text(L10n.syncIssuesRetry)
            }
            .accessibilityIdentifier("sync-issue-retry")
            Button(role: .destructive) {
                pendingDiscard = item
            } label: {
                Text(L10n.syncIssuesDiscard)
            }
            .disabled(!item.allowsDiscard)
            .accessibilityIdentifier("sync-issue-discard")
            if let block = item.discardBlock {
                Text(SyncIssueTexts.reason(for: block))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            Button {
                _ = model.redo(item)
            } label: {
                Text(L10n.syncIssuesDismiss)
            }
            .accessibilityIdentifier("sync-issue-dismiss")
        }
    }

    private var isConfirmingDiscard: Binding<Bool> {
        Binding(
            get: { pendingDiscard != nil },
            set: { isShown in
                if !isShown {
                    pendingDiscard = nil
                }
            }
        )
    }

    static func message(for failure: SyncIssuesModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .loadFailed: L10n.syncIssuesLoadFailed
        case .discardBlocked(let block): SyncIssueTexts.reason(for: block)
        case .saveFailed: L10n.syncIssuesSaveFailed
        }
    }
}

/// What a sync issue is about: a bean, a bag, a brew, a recipe or the settings.
struct SyncIssueSubjectView: View {
    let subject: SyncIssueSubject
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        switch subject {
        case .bean(let summary):
            BeanSummaryView(summary: summary, vocabulary: vocabulary, language: language)
        case .shelfEntry(let summary, let purchaseDate):
            VStack(alignment: .leading, spacing: 4) {
                BeanSummaryView(summary: summary, vocabulary: vocabulary, language: language)
                if let purchaseDate, let date = ShelfDates.date(of: purchaseDate) {
                    LabeledContent {
                        Text(date, format: .dateTime.day().month().year())
                    } label: {
                        Text(L10n.shelfPurchaseDate)
                    }
                    .font(.subheadline)
                }
            }
            .accessibilityElement(children: .combine)
        case .brew(let methodID, let brewedAt):
            LabeledContent {
                Text(brewedAt, format: .dateTime.day().month().year().hour().minute())
            } label: {
                VStack(alignment: .leading) {
                    Text(L10n.syncIssuesBrew)
                    Text(verbatim: methodLabel(methodID))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        case .recipe(let methodID):
            LabeledContent {
                Text(verbatim: methodLabel(methodID))
            } label: {
                Text(L10n.syncIssuesRecipe)
            }
            .accessibilityElement(children: .combine)
        case .profile:
            Text(L10n.syncIssuesProfile)
        }
    }

    /// The method's label from contracts/i18n; the id if the bundled labels lack it.
    private func methodLabel(_ methodID: String) -> String {
        (try? vocabulary.label(namespace: Vocabulary.Method.namespace, id: methodID, language: language)) ?? methodID
    }
}
