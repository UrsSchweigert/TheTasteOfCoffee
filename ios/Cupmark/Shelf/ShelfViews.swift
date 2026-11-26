import SwiftUI

/// A bean as the shelf shows it: the Open Food Facts name and brand, or else its attribute
/// labels from contracts/i18n, or "Bean without details".
///
/// Name and brand are untrusted Open Food Facts text (ADR 0005): `Text(verbatim:)` only, so
/// they are never read as a localisation key or as Markdown.
struct BeanSummaryView: View {
    let summary: ShelfBeanSummary
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if summary.hasOpenFoodFactsText {
                if let name = summary.name {
                    Text(verbatim: name)
                        .font(.headline)
                }
                if let brand = summary.brand {
                    Text(verbatim: brand)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else if summary.attributes.isEmpty {
                Text(L10n.shelfBeanUnnamed)
                    .font(.headline)
            } else {
                Text(verbatim: attributeList)
                    .font(.headline)
            }
        }
    }

    /// The attribute labels, joined as a list in the device language.
    private var attributeList: String {
        let labels = summary.attributes.map { row in
            (try? vocabulary.label(namespace: row.field.namespace, id: row.valueID, language: language)) ?? row.valueID
        }
        return ListFormatter.localizedString(byJoining: labels)
    }
}

/// One shelf entry in the list: the bean, the roast date, days since roast and the brew count.
struct ShelfRowView: View {
    let row: ShelfRow
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            BeanSummaryView(summary: row.bean, vocabulary: vocabulary, language: language)
            Group {
                if let roastDate = row.roastDate, let date = ShelfDates.date(of: roastDate) {
                    LabeledContent {
                        Text(date, format: .dateTime.day().month().year())
                    } label: {
                        Text(L10n.shelfRoastDate)
                    }
                } else {
                    Text(L10n.shelfRoastDateUnknown)
                        .foregroundStyle(.secondary)
                }
                if let days = row.daysSinceRoast {
                    LabeledContent {
                        Text(days, format: .number)
                    } label: {
                        Text(L10n.shelfDaysSinceRoast)
                    }
                }
                LabeledContent {
                    Text(row.brewCount, format: .number)
                } label: {
                    Text(L10n.shelfBrewCount)
                }
            }
            .font(.subheadline)
            if let pending = row.pendingBean {
                Label {
                    Text(pending == .awaitingConfirmation ? L10n.shelfRowBeanAwaitingConfirmation : L10n.shelfRowBeanLookingUp)
                } icon: {
                    Image(systemName: pending == .awaitingConfirmation ? "questionmark.circle" : "clock.arrow.circlepath")
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            if row.issue != nil {
                Label {
                    Text(L10n.shelfRowIssue)
                } icon: {
                    Image(systemName: "exclamationmark.icloud")
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// What the user is told about a sync issue (M2-T18, ADR 0025).
enum SyncIssueTexts {
    static func title(for kind: SyncIssueItem.Kind) -> LocalizedStringKey {
        switch kind {
        case .parked(.some(.create), _), .parked(.some(.lookUp), _), .parked(.some(.awaitConfirmation), _), .parked(.some(.awaitDescription), _): L10n.syncIssuesRejectedCreateTitle
        case .parked(.some(.update), _): L10n.syncIssuesRejectedUpdateTitle
        case .parked(.some(.delete), _): L10n.syncIssuesRejectedDeleteTitle
        case .parked(.none, _), .flagged(.rejected): L10n.syncIssuesRejectedTitle
        case .flagged(.beanChangeReverted): L10n.syncIssuesBeanChangeRevertedTitle
        case .flagged(.deleteRestored): L10n.syncIssuesDeleteRestoredTitle
        }
    }

    static func message(for kind: SyncIssueItem.Kind) -> LocalizedStringKey {
        switch kind {
        case .parked(.some(.create), _), .parked(.some(.lookUp), _), .parked(.some(.awaitConfirmation), _), .parked(.some(.awaitDescription), _): L10n.syncIssuesRejectedCreateMessage
        case .parked(.some(.update), _): L10n.syncIssuesRejectedUpdateMessage
        case .parked(.some(.delete), _): L10n.syncIssuesRejectedDeleteMessage
        case .parked(.none, _), .flagged(.rejected): L10n.syncIssuesRejectedMessage
        case .flagged(.beanChangeReverted): L10n.syncIssuesBeanChangeRevertedMessage
        case .flagged(.deleteRestored): L10n.syncIssuesDeleteRestoredMessage
        }
    }

    /// The title for a flag on a shelf entry, for the entry's own screen.
    static func title(for issue: SyncIssue) -> LocalizedStringKey {
        title(for: .flagged(issue))
    }

    static func message(for issue: SyncIssue) -> LocalizedStringKey {
        message(for: .flagged(issue))
    }

    static func reason(for block: SyncIssueDiscardBlock) -> LocalizedStringKey {
        switch block {
        case .shelfEntryHasBrews: L10n.syncIssuesDiscardHasBrews
        case .beanHasShelfEntries: L10n.syncIssuesDiscardHasEntries
        }
    }
}
