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

## Addendum M2-T48: the averages in context (lead, ADR 0014)

After testing the TestFlight build the owner asked to see the averages "right next to where I look at my things, rather than having to scroll down and lose the context". The numbers of the addendum above now also appear in three places, from the same pure function, `StatisticsRules.coffeeAverages`, which gains a parameter `excluding:` (the local id of one brew to leave out; `StatisticsBrew` carries its own `id`). There is no second implementation. Still on the device, offline, no route and no cost. The rules:

- **Rating sliders:** each criterion slider gets a marker at the mean of the user's OTHER rated, not removed brews of the same shelf entry (the brew being rated is excluded, so an edit does not compare a brew with itself), with the number under the slider ("Your average for this coffee 7.5"). The owner's decision: the marker appears only after the user has set that slider in this rating, so the average does not anchor the score; a brew opened with a rating (an edit, or "Start from the last rating") has its scores set and shows its markers at once. It appears only when at least one other rated brew scores that criterion. It is a fixed average: moving the slider does not move it, and it never changes the slider's value, step or behaviour (it is drawn over the slider's lower edge with hit testing off). VoiceOver: the slider keeps its label, value ("Aroma, 7 of 10") and hint; the number under it is one more element, "Your average for this coffee, 7.5 of 10", present only while the marker is shown.
- **Marker colour:** `AverageMarker` (a teal, ADR 0032 table), distinct in hue and shape (a diamond, not a circle) from the espresso thumb and track, with contrast of at least 6.5:1 against the row backgrounds in both appearances. It is drawn beside the track, not on it, so it is judged against the row.
- **Community slot (M4):** the rating model has an optional community value per criterion (mean and raters). While it is set, a second marker (a ring) and its own label ("All raters: 7.1 (raters: 12)") are drawn, again only after the slider is set; while nil nothing is drawn. Nothing sets it yet: no server call and no contract change. M4 decides what free users see (the overall only, and only for beans they rated).
- **Top of the coffee's screen:** a compact summary row at the very top of a stored entry's screen, "Overall 7.4, rated brews 3": the mean overall score and the number of rated brews, no plural wording. It appears only with at least one rated brew that scores `overall` (no empty state of its own and no zeros: the section below says "Rate a brew to see your averages here"). With one rated brew it shows that brew's values, as the section does. A tap scrolls to the dimension section of the addendum above, which stays as it is.
- **Brew list:** a rated row shows its own overall score and, next to it, the coffee's average overall ("avg 7.4"). An unrated row shows neither; with one rated brew there is no average (it would be the brew's own number). VoiceOver reads "Overall 8.0, coffee average 7.4".


## Addendum M2-T50: a method switcher (lead, ADR 0014)

The owner found the statistics screen, which listed every method one after another, far too long (2026-11-26). A menu picker at the top replaces those sections. On the device, offline, no route, no cost. The rules:

- **Options:** "All methods" and each method with at least one rated, not removed brew, in vocabulary order, labelled from the vocabulary.
- **Effect:** with one method chosen every section (brews, weeks, taste profile, flavour notes, best bean, buy again) shows the numbers of that method's brews only, from the same `PersonalStatistics.compute` with a method filter. "All methods" is the output as before. "Best method" compares methods and is hidden while one is chosen.
- **Threshold:** unchanged. A chosen method with fewer than `StatisticsRules.minimumRatedBrews` rated brews shows the empty state of the taste profile, not zeros.
- **Kept:** per device in `UserDefaults` (privacy reason CA92.1) as one method id or "all". An unknown id, or a method that has no rated brew any more, shows "All methods"; the kept value is not overwritten until the user picks again.

## Addendum M2-T49: averages on the shelf list, per bag and per product (lead, ADR 0014)

The owner asked (2026-11-26) for the averages of a bag on each row of the shelf, and across all bags of the same product.

- **Bag line:** each shelf row shows the mean overall score and the number of rated brews of its own bag ("Overall 7.4, rated brews 3"), the wording of the coffee screen. A bag without rated brews shows nothing, no zeros.
- **Product line:** when the user has more than one bag of the same bean, each of those rows also shows "All bags 7.1, rated brews 5", the mean over the rated brews of every bag of that bean. With one bag the line is not shown (it would repeat the bag line); a bag without a bean has none. The coffee screen shows the same line under its summary.
- **Which brews count:** as in M2-T44: not removed, rated; brews of other beans never count.
- **Count:** the shelf counts brews that scored `overall`; the coffee screen's summary counts rated brews. Every vocabulary version defines `overall` and a rating cannot be saved without it, so the two are equal today.
- **Where:** one pure function, `StatisticsRules.shelfAverages(of:bags:)`, with tests; one batched read for the whole list.

## Addendum M2-T52: one averages section with a method switcher on the bag screen (lead, ADR 0014)

After M2-T44 a bag's screen listed the averages over all ratings and then one more section per method with enough rated brews. The owner found two kinds of rating sections confusing (2026-11-26) and asked for one section with a drop-down. On the device, offline, no route, no cost. The rules:

- **Options:** a menu `Picker` "Method" with "All Methods" and each method that has at least `StatisticsRules.minimumRatedBrews` rated, not removed brews of this bag, in vocabulary order, labelled from the vocabulary. With no such method the picker is not shown. The per-method sections are removed.
- **Effect:** the rated-brew count, the criterion rows and the footer follow the choice. "All Methods" is the output of M2-T44 as before; a method shows its `CoffeeMethodAverages` entry (its rows and its rated-brew count). Same pure data, `CoffeeAverages.methods`; no second computation.
- **State:** view state only. It is not persisted (no `UserDefaults`) and resets when the screen is left. A choice whose method no longer qualifies (a brew was removed) shows "All Methods".
- **Kept:** the summary row at the top, its scroll anchor `coffee-averages-section` (now on the picker row, so the tap lands above the count and rows), the community slot (the "All Methods" rows only, as before), the empty and one-brew states and `coffee-averages-count`.
