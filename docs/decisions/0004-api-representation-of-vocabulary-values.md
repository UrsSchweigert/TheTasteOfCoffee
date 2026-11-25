# 0004 How the API represents vocabulary values

- Status: proposed
- Date: 2026-11-25
- Decided by: agent (contract-keeper), task M0-T2

## Context

The OpenAPI skeleton (M0-T2) must carry the vocabulary's lists and ranges without becoming a second definition of them (CLAUDE.md, invariant 2). Three questions had no answer in the docs:

1. Are the enums in `openapi.yaml` generated from `vocabulary/v<N>/` or written by hand?
2. How is a value with a 0.1 step (the dose, 5.0 to 100.0 g) sent? `multipleOf: 0.1` fails naive floating-point checks: in ajv without a precision option, 0.3 is not a multiple of 0.1.
3. How does a request say which vocabulary version it was made with (M1-T5)?

## Decision

1. **Hand-written enums, bound by tags and a drift test.** Each enum and range in `openapi.yaml` carries an `x-vocabulary*` tag naming its source, and `npm test` fails if any value differs from the vocabulary, if an enum has no tag, or if a vocabulary range is unused. The YAML stays one readable, reviewable file with no generated sections and no template, and the tags make the mapping explicit, which a generator would need anyway. The test names the missing or extra id, so following a new version is a small edit.
2. **Scaled integers for steps that are not exact in binary.** A step of 1 or 0.5 is exact in IEEE 754 and stays a number with `multipleOf`. The dose is sent as `dose_dg`, integer tenths of a gram (50 to 1000), tagged `x-vocabulary-scale: 10`. The lint rejects any `multipleOf` that is not a multiple of 2^-20, so a future 0.1 step cannot slip in. Vocabulary v1 is unchanged; the scale is applied in the contract.
3. **`vocabulary_version` on every request that carries a vocabulary value**: a required integer from 1 to the latest published version. Enums are the union of ids over all published versions (ids are never reused), and the server checks each value against the version sent.

## Alternatives

- Generating the enums into `openapi.yaml` from the vocabulary: no hand edits, but it needs a template or YAML rewriting plus its own no-drift check, and generated and hand-written parts would share one file.
- `multipleOf: 0.1` with a precision note for generators: keeps grams on the wire, but every generator and client (zod, Swift, ajv) must get the tolerance right, and one that does not rejects valid doses.
- Integer half points for scores (2 to 20): float-safe, but 0.5 is already exact, and half points would leak into every client and aggregate.
- Version per field or in a header: a header is not covered by the body schema, and per-field versions add noise for no gain.

## Consequences

- Clients convert the dose for display (`dose_dg / 10`). Ratio is computed from `dose_dg` and `water_g`.
- Publishing a vocabulary version needs a matching edit of `openapi.yaml` (new ids, `VocabularyVersion.maximum`), caught by the test.
- Revisit if a range changes between versions: the test then reports that the API needs a decision instead of guessing a representation.
