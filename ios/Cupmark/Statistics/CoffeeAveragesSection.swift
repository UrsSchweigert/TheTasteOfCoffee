import SwiftUI

/// "My brews of this coffee" on the shelf entry screen (M2-T44, ADR 0027 addendum): the
/// user's own mean of each rating criterion over the rated brews of this bag, with the
/// number of rated brews, and a breakdown by method once a method has enough rated brews.
///
/// - Read-only and offline: it shows what `StatisticsRules.coffeeAverages` made from the
///   local store. Nothing is typed, nothing is sent.
/// - No rated brew: one line, "Rate a brew to see your averages here", never zeros.
/// - One rated brew: its values, and a footer that says they are the one brew's, not an
///   average.
/// - A row is a label, the value (one decimal, device locale) and a bar of the mean as a
///   share of the top of the scale, drawn with shapes in the accent colour. The community
///   value (M4) shows under the row only when the row has one.
struct CoffeeAveragesSection: View {
    let averages: CoffeeAverages
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    /// The scroll anchor of the section, for `CoffeeSummaryRow`.
    static let anchor = "coffee-averages-section"

    var body: some View {
        Group {
            summarySection
            ForEach(averages.methods) { entry in
                Section {
                    ForEach(entry.rows) { row in
                        CoffeeAverageRowView(row: row, label: label(row.criterion))
                    }
                } header: {
                    Text(verbatim: L10n.coffeeAveragesMethodHeader(method: label(entry.method), brews: entry.ratedBrews.formatted()))
                        .secondaryText()
                }
                .surfaceRow()
            }
        }
    }

    private var summarySection: some View {
        Section {
            if averages.isEmpty {
                Text(L10n.coffeeAveragesEmpty)
                    .secondaryText()
                    .accessibilityIdentifier("coffee-averages-empty")
            } else {
                LabeledContent {
                    Text(averages.ratedBrews, format: .number)
                } label: {
                    Text(L10n.coffeeAveragesRatedCount)
                }
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("coffee-averages-count")
                // Where the summary row at the top of the screen scrolls to (M2-T48).
                .id(CoffeeAveragesSection.anchor)
                if averages.hasNoKnownScores {
                    // Rated, but only on criteria a newer vocabulary has.
                    Text(L10n.statisticsNoKnownScores)
                        .secondaryText()
                }
                ForEach(averages.rows) { row in
                    CoffeeAverageRowView(row: row, label: label(row.criterion))
                }
            }
        } header: {
            Text(L10n.coffeeAveragesHeader)
                .secondaryText()
        } footer: {
            if averages.isSingleBrew {
                Text(L10n.coffeeAveragesFooterSingle)
                    .secondaryText()
            } else if !averages.isEmpty {
                Text(L10n.coffeeAveragesFooterMany)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    /// A vocabulary label from contracts/i18n, the id if the bundle has none.
    private func label<Item: VocabularyItem>(_ item: Item) -> String {
        (try? vocabulary.label(for: item, language: language)) ?? item.rawValue
    }
}

/// The compact summary at the very top of a stored coffee's screen (M2-T48): "Overall 7.4,
/// rated brews 3". Shown only with a rated brew that scores `overall` (no zeros, no empty
/// state: the section below has that). A tap calls `onSelect`, which scrolls to the
/// dimension section. At least 44 points; VoiceOver reads the label "Your ratings of this
/// coffee", the text as the value and the hint says where the tap goes.
struct CoffeeSummaryRow: View {
    let averages: CoffeeAverages
    let onSelect: () -> Void
    @Environment(\.locale) private var locale

    var body: some View {
        if let mean = averages.summaryOverall {
            let text = L10n.coffeeSummaryOverall(
                mean: mean.formatted(StatisticsRules.meanStyle().locale(locale)),
                brews: averages.ratedBrews.formatted(.number.locale(locale))
            )
            Section {
                Button(action: onSelect) {
                    HStack(spacing: 8) {
                        Text(verbatim: text)
                            .font(.headline)
                            .monospacedDigit()
                            .accentText()
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.down")
                            .font(.footnote)
                            .secondaryText()
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(Text(L10n.coffeeSummaryLabel))
                .accessibilityValue(Text(verbatim: text))
                .accessibilityHint(Text(L10n.coffeeSummaryHint))
                .accessibilityIdentifier("coffee-summary")
            }
            .surfaceRow()
        }
    }
}

/// One criterion: its label and value, a bar, and the community value when there is one.
/// VoiceOver reads it as one element, "Aroma, 7.5 of 10" (`RatingFormat.spokenScore`).
struct CoffeeAverageRowView: View {
    let row: CoffeeAverageRow
    let label: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Label above value at the accessibility sizes, so neither is cut off.
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Text(verbatim: label)
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: 0)
                }
                Text(row.mean, format: StatisticsRules.meanStyle())
                    .monospacedDigit()
                    .accentText()
            }
            AverageBar(fraction: row.barFraction)
            if let community = row.community {
                Text(verbatim: communityText(community))
                    .font(.footnote)
                    .secondaryText()
            }
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityValue(Text(verbatim: spokenValue))
        .accessibilityIdentifier("coffee-average-row")
    }

    private func communityText(_ community: CommunityValue) -> String {
        L10n.coffeeAveragesCommunity(
            mean: community.mean.formatted(StatisticsRules.meanStyle().locale(locale)),
            raters: community.raters.formatted(.number.locale(locale))
        )
    }

    /// "7.5 of 10", then the community's value when there is one.
    private var spokenValue: String {
        let own = RatingFormat.spokenScore(row.mean, locale: locale)
        guard let community = row.community else {
            return own
        }
        return "\(own), \(communityText(community))"
    }
}

/// A bar: a track and the filled part, both capsules, in the accent colour. Decoration only:
/// the value is read from the row.
struct AverageBar: View {
    /// 0 to 1.
    let fraction: Double

    var body: some View {
        Capsule()
            .fill(Theme.accent.opacity(0.2))
            .frame(height: 8)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(Theme.accent)
                        .frame(width: proxy.size.width * min(1, max(0, fraction)))
                }
            }
            .accessibilityHidden(true)
    }
}
