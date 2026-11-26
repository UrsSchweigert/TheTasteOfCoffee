# 0027 Personal statistics: the default set, computed on the device

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014), task M2-T28; no cloud cost (no new route)

## Context

docs/03 promises "own statistics and taste profile" in the free tier. The spec does not list which statistics, and M2-T28 asks the lead to confirm the set before work starts.

## Decision

The statistics are computed on the device from the account's local store, and work offline. They cover the user's own brews that are not removed. Only rated brews count for scores.

1. **Brews:** the total, and per ISO week for the last 8 weeks.
2. **Taste profile:** the mean of each criterion over all rated brews, and per method. A method is shown once it has at least 2 rated brews.
3. **Flavour notes:** the 5 notes picked most often, with their counts.
4. **Best method and best bean:** by mean `overall` score. A method or bean takes part only with at least 2 rated brews, so a single good cup does not top the list. On a tie, the one with more rated brews wins, then the most recent.
5. **Buy again:** the share of yes among the ratings that answer it (ADR 0026). A rating without an answer is not counted as no.

How the numbers are shown:
- Means have one decimal, in the device locale.
- With no rated brews, each section shows an empty state instead of zeros.
- Labels come from the vocabulary and the catalogue. No number, list or threshold is hard-coded in a view.

## Consequences

- No backend change and no cost.
- The thresholds (2 rated brews, 8 weeks, 5 notes) are constants in one place in the statistics code (`StatisticsRules`), with tests. They are also stated in docs/04 and ios/README.md, so a change to them updates all four.
- Community statistics (M3, paid) use the server aggregates instead, with their 5-rater rule (invariant 4).

## Addendum M2-T44: the averages of one coffee (lead, ADR 0014)

The owner asked (2026-11-26) to see, on opening a coffee, the averages of all their brews of it, the dimensions, and later the community's too. "A coffee" is a shelf entry (one bag), not the bean: two bags of the same bean have separate averages. The shelf entry screen gets a section "My brews of this coffee". It is computed on the device like the rest of this ADR: no route, no cost, offline. The rules:

- **Which brews count:** the rated brews of this shelf entry that are not removed on the device (`pendingDelete`). A brew of another bag of the same bean, an unrated brew and a removed brew count nowhere. A rating made with an older vocabulary version counts (it is read-only): a criterion it does not score is left out of that criterion's mean only. A rating that scores only criteria this build does not know counts as a rated brew and has no rows; the section says so.
- **What is shown:** the mean of each criterion of the vocabulary, in vocabulary order (`overall` is one of them, so the mean overall score is the last row), and the number of rated brews, as "Rated brews" with the number (no plural wording). Each row is a value and a bar, the mean as a share of the top of the scale.
- **Threshold:** a breakdown by method follows, for each method with at least `StatisticsRules.minimumRatedBrews` (2) rated brews of this entry, the same constant as above. A brew with a method this build does not know counts in the totals only.
- **Rounding:** the model keeps the unrounded mean; it is shown with one decimal in the device locale (`StatisticsRules.meanStyle()`), and VoiceOver reads the same one decimal as "7.5 of 10" through `RatingFormat.spokenScore`.
- **Empty state:** with no rated brew the section shows "Rate a brew to see your averages here", no rows and no zeros.
- **One rated brew:** its own values are shown, and the footer says they are the values of one rated brew and that averages appear with a second. Nothing is called an average.
- **Community slot (M4):** each row has an optional community value (mean and number of raters). The view hides it while it is nil, and nothing sets it yet: no server call and no contract change in this task. Community aggregates are per bean and need 5 raters (invariant 4), while the user's numbers are for this bag, so M4 labels them "All raters" and states that.
- **Where:** one pure function, `StatisticsRules.coffeeAverages(of:shelfEntry:community:)`, with tests on fixtures. The threshold is not copied.

