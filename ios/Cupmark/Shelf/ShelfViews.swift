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
                        .secondaryText()
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

/// The bag's and the product's mean overall score as text lines (M2-T49): "Overall 7.4, rated
/// brews 3" and, with more than one bag of the bean, "All bags 7.1, rated brews 5". A line
/// that has no rated brew behind it is not drawn (no zeros). The lines wrap at every Dynamic
/// Type size; the number is formatted in the device locale with one decimal.
struct ShelfAverageLines: View {
    let averages: ShelfAverages
    @Environment(\.locale) private var locale

    var body: some View {
        if averages.bag != nil || averages.product != nil {
            VStack(alignment: .leading, spacing: 2) {
                if let bag = averages.bag {
                    Text(verbatim: ShelfAverageLines.bagText(bag, locale: locale))
                        .font(.subheadline)
                        .monospacedDigit()
                        .accentText()
                }
                if let product = averages.product {
                    Text(verbatim: ShelfAverageLines.productText(product, locale: locale))
                        .font(.subheadline)
                        .monospacedDigit()
                        .secondaryText()
                }
            }
        }
    }

    /// "Overall 7.4, rated brews 3" (the wording of the summary row of a coffee's screen).
    static func bagText(_ average: OverallAverage, locale: Locale) -> String {
        L10n.coffeeSummaryOverall(mean: mean(average, locale: locale), brews: count(average, locale: locale))
    }

    /// "All bags 7.1, rated brews 5".
    static func productText(_ average: OverallAverage, locale: Locale) -> String {
        L10n.shelfRowProductAverage(mean: mean(average, locale: locale), brews: count(average, locale: locale))
    }

    private static func mean(_ average: OverallAverage, locale: Locale) -> String {
        average.mean.formatted(StatisticsRules.meanStyle().locale(locale))
    }

    private static func count(_ average: OverallAverage, locale: Locale) -> String {
        average.ratedBrews.formatted(.number.locale(locale))
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
            ShelfAverageLines(averages: row.averages)
            Group {
                if let roastDate = row.roastDate, let date = ShelfDates.date(of: roastDate) {
                    LabeledContent {
                        Text(date, format: DisplayDate.day)
                    } label: {
                        Text(L10n.shelfRoastDate)
                    }
                } else {
                    Text(L10n.shelfRoastDateUnknown)
                        .secondaryText()
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
                    Text(ShelfRowView.note(for: pending))
                } icon: {
                    Image(systemName: pending.asksUser ? "questionmark.circle" : "clock.arrow.circlepath")
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .secondaryText()
            }
            if row.issue != nil {
                Label {
                    Text(L10n.shelfRowIssue)
                } icon: {
                    Image(systemName: "exclamationmark.icloud")
                        .foregroundStyle(Theme.errorText)
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .secondaryText()
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

extension ShelfRowView {
    /// The note of a row whose bean is a pending scan (M2-T25).
    static func note(for state: PendingBeanState) -> LocalizedStringKey {
        switch state {
        case .lookingUp: L10n.shelfRowBeanLookingUp
        case .awaitingConfirmation: L10n.shelfRowBeanAwaitingConfirmation
        case .awaitingDescription: L10n.shelfRowBeanAwaitingDescription
        }
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
