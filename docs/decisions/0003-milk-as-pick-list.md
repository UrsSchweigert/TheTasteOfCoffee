# 0003 Milk is a pick list of dairy, plant and nut drinks

- Status: accepted
- Date: 2026-11-25
- Decided by: owner

## Context

The specification contradicted itself. The Input model listed "milk added" as a toggle, while F2 listed milk as a pick list (none, dairy, oat, soy, other plant). The vocabulary followed F2. The OpenAPI skeleton (M0-T2) needs one shape.

## Decision

Milk is a single pick list, not a toggle. People add many different milks and nut drinks to coffee, so the list in vocabulary v1 is: none, dairy, oat, soy, almond, cashew, hazelnut, macadamia, coconut, rice, pea, other plant.

The extra drinks were added to v1 before v1 was published on `main`. Nothing used v1 yet, so the owner approved changing it in place and re-locking it rather than creating v2.

## Alternatives

- A toggle ("milk added"). Rejected: it loses which milk was used, and that changes how a coffee tastes.
- Keeping the five-item list and recording nut drinks under "other plant". Rejected by the owner.
- Adding the drinks in a new v2. Rejected: it adds a second version before any consumer exists.

## Consequences

- One milk per brew. If blends or several additions are ever needed, that is a new decision and a new vocabulary version.
- Any further milk type needs a new vocabulary version.
