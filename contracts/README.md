# Contracts

Everything the app and the backend agree on. Owned by the `contract-keeper` agent.

- `vocabulary/v<N>/`: the closed lists and numeric ranges. This is what makes the app free of free text. Ids are stable forever. A published version is never edited; changes go into the next version and into `vocabulary/CHANGELOG.md`.
- `vocabulary/v<N>.lock.json`: sha256 of every file of a published version. It makes "never edited" a test, not a promise.
- `vocabulary/schema/`: one JSON Schema per vocabulary file (`<name>.schema.json` for `<name>.json`), plus `common.schema.json` with the shared shapes.
- `i18n/<lang>.json`: display labels for every id, German and English. Vocabulary files hold no display text.
- `openapi.yaml`: the API (created in task M0-T2).
- `lib/`, `test/`, `bin/`, `package.json`: the checks and the lock tool. Run `npm ci && npm test` here (Node 22).

## Vocabulary v1

Published on 2026-11-25 after the owner approved it, and locked by `vocabulary/v1.lock.json`. Do not edit any file in `vocabulary/v1/`.

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

- A `v<N>/` directory holds only `<name>.json` files with a snake_case name: no subdirectories, symlinks, hidden files or other files.
- Every file has `version` (equal to its directory) and `status` (`draft` or `published`). All files of one version share one status.
- Every array in a vocabulary file is a list: a non-empty array of objects with an `id`. An array of strings, numbers, arrays or id-less objects is an error, whatever the schema says.
- The property name that holds the array is the list's namespace, and a namespace lives in exactly one file. Ids are lowercase snake_case and unique within their namespace; the same id may appear in two namespaces (`acidity` is a criterion and an intensity dimension).
- A range is `{ "minimum", "maximum", "multipleOf" }`, all three required, bounds inclusive.
- A language file is `{ "language", "labels": { <namespace>: { <id>: text } }, "questions": { "criteria": { <id>: text } } }`.

## What the tests enforce

- Every vocabulary file validates against its schema; a file without a schema fails, and so does a schema without a file.
- Ids are snake_case and unique per namespace.
- Every id has a non-empty label in `en.json` and `de.json`, every criterion has a question, and no label or question exists for an id the vocabulary does not define.
- Ranges sit on their step, and price bands cover the axis from 0 upward without gap or overlap.
- A version directory holds nothing but vocabulary files, and every array is an id list.
- A version marked `published` has a lock, and every file in it matches the lock byte for byte (CRLF is read as LF, so line endings cannot break it; `.gitattributes` also keeps `contracts/vocabulary/**` at LF). A changed, added or removed file fails, and so does a lock whose version directory is gone.

## Publishing a version

A published version is never edited. To change any list, value or range:

1. Copy the latest `vocabulary/v<N>/` to a new `vocabulary/v<N+1>/` and set `"version": <N+1>` and `"status": "draft"` in every file there. Make the change in the new directory only. Removing or renaming an id is breaking and needs an ADR in `docs/decisions/`.
2. Extend the schemas and the labels in both languages, and record the change in `vocabulary/CHANGELOG.md`. While a version is `draft` it may be edited freely.
3. When the owner has approved it (always required if the flavour notes changed), set `"status": "published"` in every file of the new version.
4. Run `npm run lock -- <N+1>`. This writes `vocabulary/v<N+1>.lock.json` and refuses if a lock already exists or if any file is still `draft`. Commit the lock in the same pull request.
5. Run `npm test`.

Never regenerate, edit or delete an existing lock file. If a test reports `changed in a published version`, undo the edit and make it in a new version instead.

Adding a list means: add it to a vocabulary file, extend that file's schema, add labels in both languages.
