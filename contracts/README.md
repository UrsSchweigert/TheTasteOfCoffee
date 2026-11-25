# Contracts

Everything the app and the backend agree on. Owned by the `contract-keeper` agent.

- `vocabulary/v<N>/`: the closed lists and numeric ranges. This is what makes the app free of free text. Ids are stable forever. A published version is never edited; changes go into the next version and into `vocabulary/CHANGELOG.md`.
- `vocabulary/schema/`: one JSON Schema per vocabulary file (`<name>.schema.json` for `<name>.json`), plus `common.schema.json` with the shared shapes.
- `i18n/<lang>.json`: display labels for every id, German and English. Vocabulary files hold no display text.
- `openapi.yaml`: the API (created in task M0-T2).
- `lib/`, `test/`, `package.json`: the checks. Run `npm ci && npm test` here (Node 22).

## Vocabulary v1

All files are marked `draft`. The owner approves the flavour notes before v1 is published.

| File | Lists | Other values |
| --- | --- | --- |
| `brew.json` | `methods`, `water_types`, `milk_types`, `water_temp_special` | `ranges`: `dose_g`, `water_g`, `water_temp_c`, `brew_time_s`, `grind_normalised` |
| `criteria.json` | `criteria`, `intensity_dimensions`, `intensity_levels` | `scale` (range of every score), `buy_again` |
| `bean.json` | `processes`, `roast_levels` | |
| `shelf.json` | `bag_sizes` (with `grams`), `price_bands` (with `minimum`, `maximum_exclusive`) | `price_band_basis` (currency and weight the bands refer to) |
| `flavour_notes.json` | `flavour_categories`, each holding `flavour_notes` | `max_picks` |

Not defined yet: origins, varieties, roasters, grinders, other equipment. See `vocabulary/CHANGELOG.md`.

## File shapes

Generators and tests rely on these rules.

- Every file has `version` (equal to its directory) and `status` (`draft` or `published`).
- A list is an array of objects with an `id`. The property name that holds the array is the list's namespace, and a namespace lives in exactly one file. Ids are lowercase snake_case and unique within their namespace; the same id may appear in two namespaces (`acidity` is a criterion and an intensity dimension).
- A range is `{ "minimum", "maximum", "multipleOf" }`, all three required, bounds inclusive.
- A language file is `{ "language", "labels": { <namespace>: { <id>: text } }, "questions": { "criteria": { <id>: text } } }`.

## What the tests enforce

- Every vocabulary file validates against its schema; a file without a schema fails, and so does a schema without a file.
- Ids are snake_case and unique per namespace.
- Every id has a non-empty label in `en.json` and `de.json`, every criterion has a question, and no label or question exists for an id the vocabulary does not define.
- Ranges sit on their step, and price bands cover the axis from 0 upward without gap or overlap.

Adding a list means: add it to a vocabulary file, extend that file's schema, add labels in both languages.
