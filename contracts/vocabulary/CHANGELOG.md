# Vocabulary changelog

A published version is immutable. Every change to a list goes into the next `v<N>/` directory and is recorded here. Removing or renaming an id is a breaking change and needs an ADR in `docs/decisions/`.

## v2 (draft, awaiting the owner's approval)

Task M1-T8, ADR 0006 (D8). Not published and not locked: ids may still change until the owner approves the lists. v1 stays the latest published version, and the API, the backend and the app keep using it until v2 is published.

- Copied from v1: every file, with `"version": 2` and `"status": "draft"`. No id, value or range of v1 was changed, removed or renamed.
- Added to `bean.json`: `origins`, 50 ids (47 producing countries and regions, then `blend`, `other`, `unknown`), and `varieties`, 28 ids (25 cultivars and groups, then `mixed`, `other`, `unknown`). Labels in `en.json` and `de.json`.
- `schema/bean.schema.json` requires both lists from version 2 on and forbids them in version 1.
- Not breaking: ids were only added.
- Proposed by the agent; for the owner to confirm: the choice of origins, including the regions `hawaii`, `sumatra`, `java` and `sulawesi` next to the country `indonesia` (pick the island when the bag names it); `blend` for multi-origin coffees, since origin is a single pick; `robusta` as a variety entry, though it is a species; `mixed` for bags that name several varieties.
- Still not in the vocabulary: roasters (from the Open Food Facts brand, ADR 0006), grinders, other equipment.

## 2026-11-25: v1 milk list extended before release

- Exception to immutability, approved by the owner (ADR 0003). v1 was marked published only on an unmerged branch, and nothing used it yet.
- Added to `milk_types` in `brew.json`: `almond`, `cashew`, `hazelnut`, `macadamia`, `coconut`, `rice`, `pea`. Nothing was removed or renamed, and `other_plant` stays last.
- `v1.lock.json` was regenerated for `brew.json`. From here on, v1 is immutable without exception.

## 2026-11-25: v1 published

- The owner approved v1 as proposed: the flavour notes, processes, roast levels, the EUR-per-kg price bands, and the ranges and steps. No id, value or range changed; only `"status"` went from `draft` to `published` in all five files.
- v1 is now immutable. Its files are locked by sha256 in `v1.lock.json`, and the tests fail if any file in `v1/` is changed, added or removed, or if a published version has no lock. See `../README.md`, "Publishing a version".
- Not breaking: no id was added, removed or renamed.

## v1

First version, task M0-T1. Published on 2026-11-25 (see above); before that it was `draft` and could be edited in place.

Taken from `docs/04-specification.md`:

- `brew.json`: 12 methods, 4 water types, 12 milk types (none, dairy and ten plant or nut drinks), the special water temperature `cold`, ranges for dose, water or yield, water temperature, brew time and normalised grind.
- `criteria.json`: 8 criteria, the score scale 1 to 10 in half steps, 3 intensity dimensions with 3 levels, buy again.
- `shelf.json`: bag sizes 250 g, 500 g, 1 kg.
- `flavour_notes.json`: at most 5 picks.

Proposed here because the specification names the list but not its values (owner to confirm):

- `bean.json`: 8 processes, 5 roast levels.
- `shelf.json`: 6 price bands in EUR per kg.
- `flavour_notes.json`: 13 categories, 81 notes.
- `brew.json`: brew time 1 to 172,800 s; steps of 1 g for water, 1 °C for temperature, 0.5 for normalised grind.

Not in v1 yet (the specification names them, no task has defined them): origin countries, varieties, roasters, grinders and their own scales, other equipment, and which brew fields apply to which method.
