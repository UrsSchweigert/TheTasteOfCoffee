import Combine
import SwiftUI

/// Pushes the statistics (value route, so the screen and its model are made only when it
/// opens, not on every evaluation of the shelf).
struct StatisticsRoute: Hashable {}

/// The personal statistics (M2-T28, ADR 0027), opened from the shelf. Read-only: it has no
/// input, writes nothing and calls no route, so it works offline.
///
/// - Brews: the total, the rated ones, and brews per ISO week for the last weeks.
/// - Taste profile: the mean per criterion over all rated brews, and per method once the
///   method has enough rated brews.
/// - The most-picked flavour notes, the best method and bean by mean `overall` score, and
///   the buy-again share among the ratings that answer it.
///
/// Every threshold and the number format come from `StatisticsRules`. With no rated brews a
/// section shows an empty state instead of zeros. Labels come from contracts/i18n
/// (`Text(verbatim:)`) and the String Catalog; a bean is shown with `BeanSummaryView`, so
/// Open Food Facts text only ever appears through `Text(verbatim:)`.
struct StatisticsScreen: View {
    let store: AccountStore
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @State private var model: StatisticsModel
    @Environment(\.scenePhase) private var scenePhase

    init(store: AccountStore, vocabulary: VocabularyStore, language: VocabularyLanguage) {
        self.store = store
        self.vocabulary = vocabulary
        self.language = language
        _model = State(initialValue: StatisticsModel(store: store))
    }

    var body: some View {
        List {
            if model.loadFailed {
                Section {
                    Label {
                        Text(L10n.statisticsLoadFailed)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                }
                .surfaceRow()
            } else if let statistics = model.statistics {
                brewsSection(statistics)
                if statistics.hasBrews {
                    weeksSection(statistics)
                }
                tasteProfileSection(statistics)
                methodSections(statistics)
                flavourNotesSection(statistics)
                bestSection(statistics)
                buyAgainSection(statistics)
            } else {
                ProgressView()
                    .accessibilityLabel(Text(L10n.statisticsLoading))
            }
        }
        .listBackground()
        .navigationTitle(Text(L10n.statisticsTitle))
        .accessibilityIdentifier("statistics")
        .onAppear {
            model.reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: store)) { _ in
            // The sync drain saves once per operation: one read after a run of saves.
            model.scheduleReload()
        }
        .onChange(of: scenePhase) { _, phase in
            // The current week moves on with the calendar.
            if phase == .active {
                model.reload()
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private func brewsSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            if statistics.hasBrews {
                LabeledContent {
                    Text(statistics.totalBrews, format: .number)
                } label: {
                    Text(L10n.statisticsBrewsTotal)
                }
                LabeledContent {
                    Text(statistics.ratedBrews, format: .number)
                } label: {
                    Text(L10n.statisticsBrewsRated)
                }
            } else {
                emptyText(L10n.statisticsBrewsEmpty)
            }
        } header: {
            Text(L10n.statisticsBrewsHeader)
                .secondaryText()
        }
        .surfaceRow()
    }

    private func weeksSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            ForEach(statistics.weeks, id: \.start) { week in
                LabeledContent {
                    Text(week.count, format: .number)
                } label: {
                    Text(week.start, format: DisplayDate.day)
                }
                .accessibilityIdentifier("statistics-week")
            }
        } header: {
            Text(L10n.statisticsWeeksHeader)
                .secondaryText()
        } footer: {
            Text(verbatim: L10n.statisticsWeeksFooter(weeks: StatisticsRules.weekCount.formatted()))
                .secondaryText()
        }
        .surfaceRow()
    }

    @ViewBuilder
    private func tasteProfileSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            if !statistics.hasRatedBrews {
                emptyText(L10n.statisticsNoRatings)
            } else if statistics.tasteProfile.isEmpty {
                // Rated, but only on criteria a newer vocabulary has.
                emptyText(L10n.statisticsNoKnownScores)
            } else {
                criterionRows(statistics.tasteProfile)
            }
        } header: {
            Text(L10n.statisticsTasteProfileHeader)
                .secondaryText()
        } footer: {
            if statistics.hasRatedBrews {
                Text(L10n.statisticsTasteProfileFooter)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    @ViewBuilder
    private func methodSections(_ statistics: PersonalStatistics) -> some View {
        if statistics.hasRatedBrews {
            if statistics.methodProfiles.isEmpty {
                Section {
                    emptyText(verbatim: L10n.statisticsMethodsNone(brews: StatisticsRules.minimumRatedBrews.formatted()))
                } header: {
                    Text(L10n.statisticsMethodsHeader)
                        .secondaryText()
                }
                .surfaceRow()
            } else {
                ForEach(statistics.methodProfiles, id: \.method) { profile in
                    Section {
                        LabeledContent {
                            Text(profile.ratedBrews, format: .number)
                        } label: {
                            Text(L10n.statisticsBrewsRated)
                        }
                        criterionRows(profile.means)
                    } header: {
                        Text(verbatim: L10n.statisticsMethodProfileHeader(method: label(profile.method)))
                            .secondaryText()
                    }
                    .surfaceRow()
                }
            }
        }
    }

    private func flavourNotesSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            if !statistics.hasRatedBrews {
                emptyText(L10n.statisticsNoRatings)
            } else if statistics.topFlavourNotes.isEmpty {
                emptyText(L10n.statisticsNotesEmpty)
            } else {
                ForEach(statistics.topFlavourNotes, id: \.note) { entry in
                    LabeledContent {
                        Text(entry.count, format: .number)
                    } label: {
                        Text(verbatim: label(entry.note))
                    }
                    .accessibilityIdentifier("statistics-note")
                }
            }
        } header: {
            Text(L10n.statisticsNotesHeader)
                .secondaryText()
        } footer: {
            if !statistics.topFlavourNotes.isEmpty {
                Text(L10n.statisticsNotesFooter)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    private func bestSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            if !statistics.hasRatedBrews {
                emptyText(L10n.statisticsNoRatings)
            } else {
                bestRow(title: L10n.statisticsBestMethod, score: statistics.bestMethod.map { best in (mean: best.mean, ratedBrews: best.ratedBrews) }) {
                    if let best = statistics.bestMethod {
                        Text(verbatim: label(best.key))
                    }
                }
                .accessibilityIdentifier("statistics-best-method")
                bestRow(title: L10n.statisticsBestBean, score: statistics.bestBean.map { best in (mean: best.score.mean, ratedBrews: best.score.ratedBrews) }) {
                    if let best = statistics.bestBean {
                        BeanSummaryView(summary: best.bean.summary, vocabulary: vocabulary, language: language)
                    }
                }
                .accessibilityIdentifier("statistics-best-bean")
            }
        } header: {
            Text(L10n.statisticsBestHeader)
                .secondaryText()
        } footer: {
            if statistics.hasRatedBrews {
                Text(verbatim: L10n.statisticsBestFooter(brews: StatisticsRules.minimumRatedBrews.formatted()))
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    private func buyAgainSection(_ statistics: PersonalStatistics) -> some View {
        Section {
            if !statistics.hasRatedBrews {
                emptyText(L10n.statisticsNoRatings)
            } else if let buyAgain = statistics.buyAgain {
                LabeledContent {
                    Text(buyAgain.share, format: StatisticsRules.shareStyle())
                } label: {
                    Text(L10n.statisticsBuyAgainShare)
                }
                .accessibilityIdentifier("statistics-buy-again")
                LabeledContent {
                    Text(buyAgain.answered, format: .number)
                } label: {
                    Text(L10n.statisticsBuyAgainAnswered)
                }
            } else {
                emptyText(L10n.statisticsBuyAgainEmpty)
            }
        } header: {
            Text(L10n.statisticsBuyAgainHeader)
                .secondaryText()
        } footer: {
            if statistics.buyAgain != nil {
                Text(L10n.statisticsBuyAgainFooter)
                    .secondaryText()
            }
        }
        .surfaceRow()
    }

    // MARK: - Rows

    private func criterionRows(_ means: [CriterionMean]) -> some View {
        ForEach(means, id: \.criterion) { entry in
            LabeledContent {
                Text(entry.mean, format: StatisticsRules.meanStyle())
                    .accentText()
            } label: {
                Text(verbatim: label(entry.criterion))
            }
        }
    }

    /// A "best" row: its title and what won, with the mean `overall` score and the number
    /// of rated brews, or "not enough rated brews yet".
    private func bestRow<Winner: View>(
        title: LocalizedStringKey,
        score: (mean: Double, ratedBrews: Int)?,
        @ViewBuilder winner: () -> Winner
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline)
                .secondaryText()
            if let score {
                winner()
                LabeledContent {
                    Text(score.mean, format: StatisticsRules.meanStyle())
                        .accentText()
                } label: {
                    Text(L10n.statisticsMeanOverall)
                }
                .font(.subheadline)
                LabeledContent {
                    Text(score.ratedBrews, format: .number)
                } label: {
                    Text(L10n.statisticsBrewsRated)
                }
                .font(.subheadline)
            } else {
                Text(L10n.statisticsBestNone)
                    .secondaryText()
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func emptyText(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .secondaryText()
    }

    private func emptyText(verbatim text: String) -> some View {
        Text(verbatim: text)
            .secondaryText()
    }

    /// A vocabulary label from contracts/i18n, the id if the bundle has none.
    private func label<Item: VocabularyItem>(_ item: Item) -> String {
        (try? vocabulary.label(for: item, language: language)) ?? item.rawValue
    }
}
