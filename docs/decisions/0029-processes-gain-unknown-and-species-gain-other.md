# 0029 Processes gain `unknown` and species gain `other` in vocabulary v3

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014); no cloud cost

## Context

Vocabulary v2 does not offer `other` and `unknown` in every bean list: `processes` has `other` but no `unknown`, `species` has `unknown` but no `other`, and `roast_levels` has neither (M2-T22 review). M2-T4 asked whether to make them consistent before v3 is published.

## Decision

- `processes` gains `unknown`, after `other`.
- `species` gains `other`, before `unknown`, so a species that is not listed (a hybrid or a rare one) can be named.
- `roast_levels` stays an ordered scale from light to dark, with neither id. Neither word is a roast level.
- The app still treats "Not set" as unknown, so `unknown` is a choice a user can make on purpose, not a replacement for leaving a field empty.

Both changes are made in the v3 draft before it is published, so v1 and v2 are unchanged and no id is removed or renamed.

## Alternatives

- **Leave v2's lists as they are:** the lists stay inconsistent with `origins` and `varieties`, which end with `other` and `unknown`.
- **Add `other` and `unknown` to roast levels as well:** it would break the scale, and the aggregates (M3) would have to skip two ids that are not on it.

## Consequences

- Not breaking. Both ids are new in v3. The API enums `Process` and `Species` gain them with `openapi.yaml` 0.6.0.
- A bean sent with `vocabulary_version` 2 cannot use the new ids; the server checks each value against the version sent (ADR 0004).
- Labels exist in English and German.
