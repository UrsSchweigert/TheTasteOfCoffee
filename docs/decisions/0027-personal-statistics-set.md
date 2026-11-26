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
- The thresholds (2 rated brews, 8 weeks, 5 notes) are constants in one place in the statistics code, with tests.
- Community statistics (M3, paid) use the server aggregates instead, with their 5-rater rule (invariant 4).
