# 0021 Brew fields depend on the method, and grinders get their own scales

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

docs/04 F2 says brew fields depend on the method and lists a grinder pick list and a grind setting on the grinder's own scale, but no mapping existed (D13, a gap since M1). M2 builds the brew form, so the rules must exist first, in the vocabulary (invariant 2).

## Decision

Vocabulary v3 (draft in M2-T2, published in M2-T4 after the owner approves it) holds:

- **Method rules.** A field not allowed for a method must be absent; the server answers 400 (M2-T5), and the app does not show it.
  - `water_temp_special` (`cold`): `cold_brew` only. `cold_brew` does not allow `water_temp_c`.
  - `water_temp_c`: every method except `cold_brew`, `moka_pot` and `cezve`, where the water heats in the pot and a set temperature would skew the recipe ranges (F4).
  - `grinder` and `grind_setting`: every method except `fully_automatic`, whose grinder is built in. `grind_normalised` stays allowed everywhere, so every brew still records coarseness.
  - `dose_dg`, `water_g`, `brew_time_s`, `water_type`, `milk`: every method. For espresso the app labels `water_g` "yield"; that is an app string, not a rule.
- **Grinders.** A curated list of common home grinders, each with its own scale (range and step, exact in binary floating point per ADR 0004), plus `pre_ground` and `other` without a scale. `grind_setting` needs a grinder with a scale and must lie on it.

## Alternatives

- **No rules, every field everywhere** (the M1 state): a cold brew with 93 °C or a fully automatic brew with a hand-grinder setting would distort the aggregates (M3).
- **Rules in app and backend code:** breaks invariant 2.
- **A free grinder model:** breaks invariant 1.

## Consequences

- The grinder list is published only after the owner approves it (contracts/README.md, Publishing a version). A missing grinder is added in a later version; `other` covers it until then.
- Aggregates (M3) can compare grind settings only within one grinder; across grinders they use `grind_normalised`.
- docs/07 D13 is answered.
