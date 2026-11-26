# 0026 Rating input: no default answers, an offered last rating, and the version raised on rating

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014), task M2-T20; no cloud cost

## Context

M2-T20 builds the rating screen (docs/04 F3). Four details were left open:
- how to keep the repeat-brew path within the 8-tap target, when eight sliders alone take eight taps;
- whether an untouched buy-again toggle counts as "no";
- which `vocabulary_version` a brew carries once it is rated with a newer bundle;
- what the brew list shows for a rated brew.

## Decision

1. **No default answers.**
   - A criterion counts as scored only once the user touches its slider. A rating is saved only when all eight are scored, as `Scores` requires.
   - Buy-again has three states: not set, yes and no. Not set is left out of the request (`buy_again` is optional in the contract). An untouched control therefore never counts as "no" in the buy-again share on the bean page (docs/04, M3).
   - The intensities and the flavour notes are likewise optional and sent only when picked.
2. **Start from the last rating of this bag.** The screen offers to copy the newest rating of an earlier brew of the same shelf entry. It is copied only when the user taps the offer, and then the user adjusts it. This keeps a repeat brew within the 8-tap target.
3. **The version is raised on rating.** Rating a brew raises its `vocabulary_version` to the bundled version if that is newer. Published vocabulary ids are never removed (contracts/vocabulary CHANGELOG), so the older ids stay valid under the newer version.
4. **The brew list shows rated or not rated, and no score.** A single overall score would mean choosing one criterion, or a formula, in Swift. Statistics (M2-T28) decide how scores are summarised.

## Consequences

- A rating saved on its own is `PUT /brews/{brew_id}` through the outbox. If the brew's create has not been sent yet, the rating goes with the create (ADR 0025).
- The aggregator (M3) counts buy-again only for ratings that carry it.

## Addendum (M2-T27, lead, ADR 0014; no cloud cost)

Decision 2 only offered a rating of the same shelf entry, so the first repeat onto a new bag (a new bag of the usual coffee, or a repeat of the last brew onto another coffee) needed eight slider touches and missed the 8-tap target. The offer now falls back, in this order:

1. the newest rating of an earlier brew of the same shelf entry (as before);
2. else the newest rating of an earlier brew of the same bean, on any shelf entry;
3. else, for a brew started as a repeat of the last brew (ADR 0028), the rating of the brew it copied. A brew started from a recipe has no such brew: a recipe holds parameters, not a rating.

Every candidate is another brew, not removed, brewed no later than the brew being rated, so a later brew's rating is never offered. It is still copied only when the user taps the offer. The offer says where it comes from: "Start from the Last Rating of This Bag", "... of This Coffee", or "Start from the Rating of the Repeated Brew". The brew a repeat copied is known only to the sheet that logged it; rating the brew later from the brew list offers fallbacks 1 and 2 only.
