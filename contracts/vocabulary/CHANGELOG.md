# Vocabulary changelog

A published version is immutable. Every change to a list goes into the next `v<N>/` directory and is recorded here. Removing or renaming an id is a breaking change and needs an ADR in `docs/decisions/`.

## v1 (draft, not published)

First version, task M0-T1. Status stays `draft` in every file until the owner approves the flavour-note list (`docs/07-open-questions.md`, "Things only a human can do"). While it is `draft`, v1 may still be edited in place.

Taken from `docs/04-specification.md`:

- `brew.json`: 12 methods, 4 water types, 5 milk types, the special water temperature `cold`, ranges for dose, water or yield, water temperature, brew time and normalised grind.
- `criteria.json`: 8 criteria, the score scale 1 to 10 in half steps, 3 intensity dimensions with 3 levels, buy again.
- `shelf.json`: bag sizes 250 g, 500 g, 1 kg.
- `flavour_notes.json`: at most 5 picks.

Proposed here because the specification names the list but not its values (owner to confirm):

- `bean.json`: 8 processes, 5 roast levels.
- `shelf.json`: 6 price bands in EUR per kg.
- `flavour_notes.json`: 13 categories, 81 notes.
- `brew.json`: brew time 1 to 172,800 s; steps of 1 g for water, 1 °C for temperature, 0.5 for normalised grind.

Not in v1 yet (the specification names them, no task has defined them): origin countries, varieties, roasters, grinders and their own scales, other equipment, and which brew fields apply to which method.
