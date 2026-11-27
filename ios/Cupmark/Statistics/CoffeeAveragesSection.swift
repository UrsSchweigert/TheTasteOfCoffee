import SwiftUI

/// "My brews of this coffee" on the shelf entry screen (M2-T44, ADR 0027 addendum): the
/// user's own mean of each rating criterion over the rated brews of this bag, with the
/// number of rated brews. One menu picker (M2-T52) switches between all methods and each
/// method with enough rated brews; the count, the rows and the footer follow it. The choice is
/// view state only: it resets when the screen is left.
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

    @State private var choice: CoffeeAveragesChoice = .all

    var body: some View {
        summarySection
    }

    private var summarySection: some View {
        Section {
            if averages.isEmpty {
                Text(L10n.coffeeAveragesEmpty)
                    .secondaryText()
                    .accessibilityIdentifier("coffee-averages-empty")
            } else {
                if averages.choices.count > 1 {
                    methodPicker
                }
                LabeledContent {
                    Text(shown.ratedBrews, format: .number)
                } label: {
                    Text(L10n.coffeeAveragesRatedCount)
                }
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("coffee-averages-count")
                .anchoredIf(averages.choices.count <= 1)
                if averages.hasNoKnownScores {
                    // Rated, but only on criteria a newer vocabulary has.
                    Text(L10n.statisticsNoKnownScores)
                        .secondaryText()
                }
                ForEach(shown.rows) { row in
                    CoffeeAverageRowView(row: row, label: label(row.criterion))
                }
            }
        } header: {
            Text(L10n.coffeeAveragesHeader)
                .secondaryText()
        } footer: {
            if !averages.isEmpty, shown.ratedBrews == 1 {
                Text(L10n.coffeeAveragesFooterSingle)
                    .secondaryText()
            } else if !averages.isEmpty {
                Text(L10n.coffeeAveragesFooterMany)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    private var shown: CoffeeAveragesShown {
        averages.shown(for: choice)
    }

    /// The method switcher (M2-T52): "All Methods" and each method with enough rated brews.
    /// It carries the scroll anchor of the summary row at the top of the screen (M2-T48), so
    /// the tap lands on the picker with the count and rows right below it.
    private var methodPicker: some View {
        Picker(selection: Binding(get: { averages.resolved(choice) }, set: { choice = $0 })) {
            Text(L10n.statisticsMethodAll)
                .tag(CoffeeAveragesChoice.all)
            ForEach(averages.methods) { entry in
                Text(verbatim: label(entry.method))
                    .tag(CoffeeAveragesChoice.method(entry.method))
                    .accessibilityIdentifier("coffee-averages-method-option")
            }
        } label: {
            Text(L10n.statisticsMethodPicker)
        }
        .pickerStyle(.menu)
        .frame(minHeight: 44)
        .accessibilityIdentifier("coffee-averages-method-picker")
        .id(CoffeeAveragesSection.anchor)
    }

    /// A vocabulary label from contracts/i18n, the id if the bundle has none.
    private func label<Item: VocabularyItem>(_ item: Item) -> String {
        (try? vocabulary.label(for: item, language: language)) ?? item.rawValue
    }
}

private extension View {
    /// The scroll anchor of the averages section on this row, while no picker carries it.
    @ViewBuilder
    func anchoredIf(_ condition: Bool) -> some View {
        if condition {
            id(CoffeeAveragesSection.anchor)
        } else {
            self
        }
    }
}

/// The compact summary at the very top of a stored coffee's screen (M2-T48): "Overall 7.4,
/// rated brews 3". Shown only with a rated brew that scores `overall` (no zeros, no empty
/// state: the section below has that). A tap calls `onSelect`, which scrolls to the
/// dimension section. At least 44 points; VoiceOver reads the label "Your ratings of this
/// coffee", the text as the value and the hint says where the tap goes.
struct CoffeeSummaryRow: View {
    let averages: CoffeeAverages
    /// The mean over all the user's bags of this bean (M2-T49), nil with one bag of it or no
    /// rated brew: the line is then not shown.
    var product: OverallAverage?
    let onSelect: () -> Void
    @Environment(\.locale) private var locale

    var body: some View {
        if averages.summaryOverall != nil || product != nil {
            Section {
                if let mean = averages.summaryOverall {
                    bagButton(mean: mean)
                }
                // The product line under the bag summary (M2-T49), the wording of the shelf list.
                if let product {
                    Text(verbatim: ShelfAverageLines.productText(product, locale: locale))
                        .font(.subheadline)
                        .monospacedDigit()
                        .secondaryText()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("coffee-summary-product")
                }
            }
            .surfaceRow()
        }
    }

    private func bagButton(mean: Double) -> some View {
        let text = L10n.coffeeSummaryOverall(
            mean: mean.formatted(StatisticsRules.meanStyle().locale(locale)),
            brews: averages.ratedBrews.formatted(.number.locale(locale))
        )
        return Button(action: onSelect) {
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
