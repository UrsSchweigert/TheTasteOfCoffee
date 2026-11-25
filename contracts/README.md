# Contracts

Everything the app and the backend agree on. Owned by the `contract-keeper` agent.

- `vocabulary/v<N>/`: the closed lists and numeric ranges. This is what makes the app free of free text. Ids are stable forever. A published version is never edited; changes go into the next version and into `vocabulary/CHANGELOG.md`.
- `vocabulary/v<N>.lock.json`: sha256 of every file of a published version. It makes "never edited" a test, not a promise.
- `vocabulary/schema/`: one JSON Schema per vocabulary file (`<name>.schema.json` for `<name>.json`), plus `common.schema.json` with the shared shapes.
- `i18n/<lang>.json`: display labels for every id, German and English. Vocabulary files hold no display text.
- `openapi.yaml`: the API, OpenAPI 3.1. See "The API" below.
- `lib/`, `test/`, `bin/`, `package.json`: the checks, the lock tool and the API lint (`bin/lint-openapi.mjs`, also run by `scripts/check-no-free-text.sh`). Run `npm ci && npm test` here (Node 22).

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

## The API

`openapi.yaml` holds the free-tier routes: barcode lookup, bean create and read, shelf, brews with ratings, recipes, profile, CSV export and account deletion. Paid and aggregate routes, the label-photo upload URL (task M1-T4) and a health route are not in it yet. The reasons for the choices below are in `docs/decisions/0004-api-representation-of-vocabulary-values.md`.

### Rules the lint enforces

`lib/openapi.mjs` walks every schema: components, parameters, request and response bodies, nested properties, `items`, `oneOf`, `anyOf`, `not`, and every `$ref` target. It fails on:

- a string without `enum`, an anchored `pattern` (`^...$`) or a `format` of `date` or `date-time`. The only other string is the CSV export body, `{ type: string, contentMediaType: text/csv }` under `text/csv`;
- a number or integer without `minimum` and `maximum`, or with a `multipleOf` that is not exact in binary floating point (see "Decimal steps");
- an object without `additionalProperties: false`, or with `required` names it does not define;
- an array without `items` or `maxItems`;
- a schema without one `type` (unless it is a `$ref`, `oneOf` or `anyOf`), any `allOf` (it defeats `additionalProperties: false`; nest objects instead), a `$ref` with sibling keywords other than `description`, a non-local or dangling `$ref`, `patternProperties`, and a `not` other than `{ required: [...] }`;
- a property, parameter or path segment that would name a user (`user_id`, `sub`, `owner` and so on). The user is always the token's subject.

The structural check covers: OpenAPI `3.1.x`, `info`, lowercase paths with `{snake_case}` parameters, unique camelCase `operationId`, path parameters that match the template, a 2xx and a 401 response on every operation, request bodies that are required and `application/json` only, responses that are `application/json` or `text/csv` only, no body on 204, the `bearerAuth` scheme (HTTP bearer, JWT) required at the top level and never overridden, every `$ref` resolving, and no unused component schema. The component schemas are also compiled with ajv in strict mode, so a misspelt keyword fails. This is not a full OpenAPI validator; it checks what the generators and the gateway rely on.

### Binding to the vocabulary

Enums and ranges are written by hand in `openapi.yaml` and tagged with the vocabulary value they come from. The tests compare each tagged value with the vocabulary, so the two cannot drift:

| Tag | On | The test requires |
| --- | --- | --- |
| `x-vocabulary: <namespace>` | string enum | the enum equals the ids of that list, in order, across all published versions |
| `x-i18n-languages: true` | string enum | the enum equals the languages in `i18n/` |
| `x-vocabulary-range: <file>.<path>` | number or integer | bounds and step equal the range, times `x-vocabulary-scale` if given |
| `x-vocabulary-scale: <n>` | integer | the API value is the vocabulary value times n |
| `x-vocabulary-keys: <namespace>` | object | the property names equal the ids of that list, in order |
| `x-vocabulary-max-items: <file>.<path>` | array | `maxItems` equals that value |
| `x-vocabulary-version: true` | integer | minimum 1, maximum the latest published version |

An enum without a tag fails, so does an unknown `x-vocabulary*` keyword, and so does a vocabulary range that no schema uses. Every request body that holds a vocabulary value has a required top-level `vocabulary_version`; the server validates each value against that version (task M1-T5). Where the enum spans versions it is the union of their ids, since ids are never reused.

When a new vocabulary version is published: add its new ids to the enums, raise `VocabularyVersion.maximum`, and run `npm test`. The test names every enum that is missing an id.

### Decimal steps

A step that is exact in binary (whole numbers, 0.5) stays a JSON number with `multipleOf`. A step that is not (0.1) is sent as an integer count of that step, so no client or validator meets `0.3 / 0.1 = 2.9999999999999996`. In v1 this applies only to the dose: `dose_dg` is tenths of a gram, 50 to 1000 (5.0 to 100.0 g), tagged `x-vocabulary-scale: 10`. Scores and normalised grind stay numbers with `multipleOf: 0.5`. The lint rejects any `multipleOf` that is not a multiple of 2^-20.

### Shapes

- Ids are server-generated ULIDs: `^[0-9A-HJKMNP-TV-Z]{26}$`. Barcodes are 12 or 13 digits (UPC-A, EAN-13); the server checks the check digit and stores the 13-digit form. List pages hold at most 100 items and an opaque `cursor`.
- A response wraps the stored request in `values` next to its id (`{ brew_id, values: BrewInput }`), so request and response cannot drift and no `allOf` is needed.
- A bean's attributes are grouped by source: `user_attributes` (picked in the app) and `operator_attributes` (set when the operator verifies). `open_food_facts_match` says whether Open Food Facts data exists for the barcode. No Open Food Facts text (name, brand) crosses the API.
- Error responses have no body; the status code is the answer.
