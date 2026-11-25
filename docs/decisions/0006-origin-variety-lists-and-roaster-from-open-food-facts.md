# 0006 Origin and variety pick lists in vocabulary v2; roaster comes from Open Food Facts

- Status: accepted
- Date: 2026-11-25
- Decided by: owner (D8)

## Context

The specification has users describe a bean by roaster, origin and variety, but vocabulary v1 has none of these lists. Origins and varieties are well-known, slow-changing sets. Roasters number in the thousands and change often.

## Decision

- Vocabulary v2 adds an `origins` list (producing countries and major regions) and a `varieties` list (common cultivars). Each has `other` and `unknown` entries and German and English labels. v1 stays unchanged and locked.
- Roaster is not a pick list. It comes from the Open Food Facts brand, which the backend fetches (ADR 0005). The operator curates and merges roasters with the CLI (D3).

## Alternatives

- A curated seed list of roasters in the vocabulary: rejected, because it would need a new vocabulary version whenever a roaster appears.
- Leaving these fields out until M2: rejected by the owner.

## Consequences

- contract-keeper publishes v2 (copy v1 to `v2/`, add the lists, get approval, lock it), adds the fields to the bean request schema, and extends the enums.
- A bean without an Open Food Facts hit has no roaster until the operator curates it.
