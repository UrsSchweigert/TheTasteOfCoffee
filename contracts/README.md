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

Not defined yet: roasters (they come from the Open Food Facts brand, ADR 0006), grinders, other equipment. See `vocabulary/CHANGELOG.md`.

## Vocabulary v2

Published on 2026-11-25 after the owner approved it with the amendments of ADR 0011, and locked by `vocabulary/v2.lock.json`. Do not edit any file in `vocabulary/v2/`. It is the latest published version: the API allows `vocabulary_version` 1 and 2, the backend loads both, and the iOS app bundles v2.

v2 is v1 with three lists added to `bean.json` (ADR 0006, ADR 0011). Every other file is v1 byte for byte except `version` and `status`.

| List | Holds |
| --- | --- |
| `origins` | Producing countries, and regions that name their country with `country` (for example `{ "id": "sumatra", "country": "indonesia" }`), then `blend`, `other`, `unknown` |
| `species` | `arabica`, `robusta` (Coffea canephora), `liberica`, `excelsa`, `arabica_robusta_blend`, `unknown` |
| `varieties` | Arabica cultivars and groups, then `mixed`, `other`, `unknown`. Robusta is a species, so it is in `species`, not here |

`java` is both an origin (the island) and a variety (the cultivar). Namespaces are separate, so that is allowed; the generated Swift types are `Vocabulary.Origin.java` and `Vocabulary.Variety.java`.

## File shapes

Generators and tests rely on these rules.

- A `v<N>/` directory holds only `<name>.json` files with a snake_case name: no subdirectories, symlinks, hidden files or other files.
- Every file has `version` (equal to its directory) and `status` (`draft` or `published`). All files of one version share one status.
- Every array in a vocabulary file is a list: a non-empty array of objects with an `id`. An array of strings, numbers, arrays or id-less objects is an error, whatever the schema says.
- The property name that holds the array is the list's namespace, and a namespace lives in exactly one file. Ids are lowercase snake_case and unique within their namespace; the same id may appear in two namespaces (`acidity` is a criterion and an intensity dimension).
- A range is `{ "minimum", "maximum", "multipleOf" }`, all three required, bounds inclusive.
- An entry may name a parent entry of its own list only where `PARENT_REFERENCES` in `lib/vocabulary.mjs` says so: today only `origins`, with `country`. The parent is an id of the same list, never the entry itself, never a catch-all id (`NON_PARENT_IDS`: `blend`, `mixed`, `other`, `unknown`), and has no parent of its own, so the hierarchy has two levels. The schema allows the attribute on `origins` entries only. Generators emit it as a typed reference (`Vocabulary.Origin.country` in Swift).
- A language file is `{ "language", "labels": { <namespace>: { <id>: text } }, "questions": { "criteria": { <id>: text } } }`.

## What the tests enforce

- Every vocabulary file validates against its schema; a file without a schema fails, and so does a schema without a file.
- Ids are snake_case and unique per namespace.
- Every id has a non-empty label in `en.json` and `de.json`, every criterion has a question, and no label or question exists for an id the vocabulary does not define.
- Ranges sit on their step, and price bands cover the axis from 0 upward without gap or overlap.
- Every parent reference (`country` on a region) names an entry of the same list that has no parent itself, and the attribute appears in no other list.
- A version directory holds nothing but vocabulary files, and every array is an id list.
- A version marked `published` has a lock, and every file in it matches the lock byte for byte (CRLF is read as LF, so line endings cannot break it; `.gitattributes` also keeps `contracts/vocabulary/**` at LF). A changed, added or removed file fails, and so does a lock whose version directory is gone.

## Publishing a version

A published version is never edited. To change any list, value or range:

1. Copy the latest `vocabulary/v<N>/` to a new `vocabulary/v<N+1>/` and set `"version": <N+1>` and `"status": "draft"` in every file there. Make the change in the new directory only. Removing or renaming an id is breaking and needs an ADR in `docs/decisions/`.
2. Extend the schemas and the labels in both languages, and record the change in `vocabulary/CHANGELOG.md`. While a version is `draft` it may be edited freely.
3. When the owner has approved it (always required if the flavour notes changed), set `"status": "published"` in every file of the new version.
4. Run `npm run lock -- <N+1>`. This writes `vocabulary/v<N+1>.lock.json` and refuses if a lock already exists or if any file is still `draft`. Commit the lock in the same pull request.
5. Follow the version in the API, in the same pull request (`npm test` fails until you do): add the new ids to their enums, bind every new list (`vocabulary list <name> is not used by any schema` names the ones missing), and raise `VocabularyVersion.maximum` to the new version. Then run `npm run generate` in `backend/`, and `node scripts/generate-ios-vocabulary.mjs` with the Xcode project's folder reference moved to the new `vocabulary/v<N>` (its `--check` fails until both match).
6. Run `npm test` here, and the checks of `backend/` and `scripts/`.

For v2, step 5 was: the `Origin` (`x-vocabulary: origins`), `Species` (`x-vocabulary: species`) and `Variety` (`x-vocabulary: varieties`) enums in `components.schemas`, optional `origin`, `species` and `variety` in `BeanAttributes`, and `VocabularyVersion.maximum: 2`. A request that sends any of them must say `vocabulary_version: 2` (or later); the server checks each value against the version sent (ADR 0004), so the same attributes with version 1 are rejected. The tests that use an unpublished version now send 3.

Never regenerate, edit or delete an existing lock file. If a test reports `changed in a published version`, undo the edit and make it in a new version instead.

Adding a list means: add it to a vocabulary file, extend that file's schema, add labels in both languages.

## The API

`openapi.yaml` holds the free-tier routes: barcode lookup in the catalogue and, for an unknown barcode, at Open Food Facts through the server; bean create and read, the stored copy of a catalogue image, label photo upload and completion, shelf, brews with ratings, recipes, profile, CSV export, account deletion, and the health route. Paid and aggregate routes are not in it yet. Every route requires the bearer token except `GET /health` (see "Exceptions"). The reasons for the choices below are in `docs/decisions/0004-api-representation-of-vocabulary-values.md`.

### Rules the lint enforces

`lib/openapi.mjs` walks every schema: components, parameters, request and response bodies, nested properties, `items`, `oneOf`, `anyOf`, `not`, and every `$ref` target. It fails on:

- a string without `enum`, an anchored `pattern` (`^...$`) or a `format` of `date` or `date-time`. The only other strings are the two raw response bodies (`RAW_RESPONSE_MEDIA_TYPES`), each exactly `{ type: string, contentMediaType: <its media type> }` and only directly in the response of an operation under `paths` (never in `components.requestBodies`, `components.responses`, a callback or a webhook, where it would be an unconstrained string a client sends): the CSV export under `text/csv` and a catalogue image under `image/jpeg`; and response-only Open Food Facts text (see "Exceptions");
- a `pattern` that is wide or unbounded: `.`, `\S`, `\s`, `\w`, `\W`, `\D`, `\p{...}`, `\P{...}`, a negated class `[^...]`, or a `*`, `+` or `{n,}` quantifier. A pattern must name its characters and bound its length, like `^[0-9]{12,13}$`;
- any schema keyword outside an allowlist (`SCHEMA_KEYWORDS` in `lib/openapi.mjs`), so `prefixItems`, `contains`, `if`/`then`/`else`, `dependentSchemas`, `propertyNames`, `unevaluated*`, `patternProperties`, `const` and exclusive bounds cannot slip in unchecked;
- a number or integer without `minimum` and `maximum`, or with a `multipleOf` that is not exact in binary floating point (see "Decimal steps");
- an object without `additionalProperties: false`, or with `required` names it does not define;
- an array without `items` or `maxItems`;
- a schema without one `type` (unless it is a `$ref`, `oneOf` or `anyOf`), any `allOf` (it defeats `additionalProperties: false`; nest objects instead), a `$ref` with sibling keywords other than `description`, a non-local or dangling `$ref`, `patternProperties`, and a `not` other than `{ required: [...] }`;
- a property, parameter or path segment that would name a user. The name is turned into snake_case (`ownerId` becomes `owner_id`) and fails if any whole token is `user`, `users`, `owner`, `owners`, `sub` or `uid`, or if it is one of a few exact names such as `subject` or `account_id`. So `cognito_sub` fails and `subscription` does not. The user is always the token's subject.

### Exceptions

There are exactly two, both defined in `lib/openapi.mjs` (`FREE_TEXT_*`, `UNAUTHENTICATED_ROUTES`) and nowhere else. Tests show each one passing where it is allowed and failing everywhere else.

**Response-only text from Open Food Facts (ADR 0005).** The server fetches the product name and brand by barcode and returns them in `Bean.open_food_facts` and from `GET /barcodes/{barcode}/open_food_facts` (schema `OpenFoodFactsProduct`). A string without `enum`, `pattern` or `format` passes only if it has all of:

- `x-free-text-from: open_food_facts` (the only source in `FREE_TEXT_SOURCES`), which also records the field's source (D5);
- `readOnly: true`;
- an integer `maxLength` from 1 to 200 (`FREE_TEXT_MAX_LENGTH`), and if given a `minLength` no larger.

And no request may reach it: `findRequestFreeText` walks every request body, parameter and callback of every operation, plus `components.requestBodies` and `components.parameters` even when unused, follows every `$ref` and looks at every nested value, not only the keywords the lint knows. A marked field reachable from any of them fails, naming the field and the request. `x-free-text-from` on anything but a string fails, and so does `readOnly` without it. The image is not free text either: `image_id` is a server-generated id (the `Id` pattern) that names the server's stored copy (ADR 0011), fetched with `GET /catalogue_images/{image_id}`. No URL is returned, and the app never contacts Open Food Facts. Invariant 1 holds as written: no client sends text.

**`GET /health` without the token (ADR 0007).** The operation must declare `security: []`, take no parameters and no body, answer only `200` and `429`, and return `HealthStatus`. `HealthStatus` is exactly `{ type: object, additionalProperties: false, required: [status], properties: { status } }` (a `description` aside), and `status` is exactly `{ type: string, enum: [ok], x-health-status: true }`, so the body cannot grow a field. `/health` has `get` only: any other method there fails, even with the bearer token. `HealthStatus` may not be used anywhere else, the tag may not appear anywhere else, and the route must exist. Any other operation that overrides the top-level `security` fails, and every other operation still needs a `401` response.

The structural check covers: OpenAPI `3.1.x`, `info`, lowercase paths with `{snake_case}` parameters, unique camelCase `operationId`, path parameters that match the template, a 2xx and a 401 response on every operation, request bodies that are required and `application/json` only, responses that are `application/json`, `text/csv` or `image/jpeg` only, no body on 204, the `bearerAuth` scheme (HTTP bearer, JWT) required at the top level and never overridden, every `$ref` resolving, and no unused component schema. The component schemas are also compiled with ajv in strict mode, so a misspelt keyword fails. This is not a full OpenAPI validator; it checks what the generators and the gateway rely on.

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
| `x-free-text-from: open_food_facts` | string | see "Exceptions"; not a vocabulary tag |
| `x-health-status: true` | string enum | see "Exceptions"; only on `HealthStatus.status` |

An enum without a tag fails, so does an unknown `x-vocabulary*` keyword, a vocabulary range that no schema uses, and a list of the latest published version that no `x-vocabulary` or `x-vocabulary-keys` binds (`UNBOUND_LISTS` names the one exception, `flavour_categories`, which only groups the notes for display). Only published versions feed the enums; a list that exists only in a draft version cannot be bound until that version is published (`x-vocabulary <name> is only in draft vocabulary v<N>; bind it when v<N> is published`), because its ids may still change and no request can name it in `vocabulary_version`. Every request body that holds a vocabulary value has a required top-level `vocabulary_version`; the server validates each value against that version (task M1-T5). Where the enum spans versions it is the union of their ids, since ids are never reused.

When a new vocabulary version is published: add its new ids to the enums, raise `VocabularyVersion.maximum`, and run `npm test`. The test names every enum that is missing an id.

### Decimal steps

A step that is exact in binary (whole numbers, 0.5) stays a JSON number with `multipleOf`. A step that is not (0.1) is sent as an integer count of that step, so no client or validator meets `0.3 / 0.1 = 2.9999999999999996`. In v1 this applies only to the dose: `dose_dg` is tenths of a gram, 50 to 1000 (5.0 to 100.0 g), tagged `x-vocabulary-scale: 10`. Scores and normalised grind stay numbers with `multipleOf: 0.5`. The lint rejects any `multipleOf` that is not a multiple of 2^-20.

### Shapes

- Ids are server-generated ULIDs: `^[0-9A-HJKMNP-TV-Z]{26}$`. Barcodes are 12 or 13 digits (UPC-A, EAN-13); the server checks the check digit and stores the 13-digit form. List pages hold at most 100 items and an opaque `cursor`.
- A response wraps the stored request in `values` next to its id (`{ brew_id, values: BrewInput }`), so request and response cannot drift and no `allOf` is needed.
- A bean's attributes are grouped by source: `picked_attributes` (picked in the app), `operator_attributes` (set when the operator verifies) and `open_food_facts` (fetched by the server: `name`, `brand`, `image_id`). `open_food_facts_match` says whether a user confirmed the Open Food Facts hit for the barcode. The client never sends Open Food Facts text: it confirms the hit with `open_food_facts_confirmed` on `POST /beans`, and the server copies the fields from its cached lookup (ADR 0005). Roaster is not a pick list; it comes from the Open Food Facts brand and the operator (ADR 0006). `BeanAttributes` holds process and roast level (v1) and origin, species and variety (v2). A region's country is not sent: it follows from the origin id in the vocabulary.
- Barcode flow: `GET /barcodes/{barcode}` answers from the catalogue (404 if unknown); then `GET /barcodes/{barcode}/open_food_facts` returns the product the server fetched (404 no hit, 409 already in the catalogue, 429 throttled or over the daily lookup cap, 503 Open Food Facts unreachable); then `POST /beans`. See `docs/05-system-design.md`, Barcode lookup.
- Catalogue images (ADR 0011): when the server caches an Open Food Facts hit, it copies the front image once into the photo bucket (`catalogue/<image_id>.jpg`, metadata stripped) and returns `image_id`. `GET /catalogue_images/{image_id}` returns the JPEG bytes behind the bearer token (404 if no such copy). Catalogue images belong to the catalogue, not to a user.
- Label photos (F1 step 4, ADR 0016): `POST /beans/{bean_id}/label_photos` (no body) returns `LabelPhotoUpload`: a `photo_id`, a presigned S3 POST (`upload.url`, `upload.fields`), `expires_at` (10 minutes) and `max_bytes` (8 MiB). The app posts the JPEG straight to S3, then calls `POST /label_photos/{photo_id}/complete` (no body, 204), where the server checks the JPEG, strips all metadata (D12) and records the photo. 409 when the bean is not unverified or the caller already has 3 photos for it; 400 on completion rejects the photo for good. Label photos are never shown to other users, and no route returns them.
- Presigned POST fields are server-generated, not user text, and need no exception: `LabelPhotoUploadFields` is a closed object, and every value has a `maxLength` and a narrow anchored `pattern` (`uploads/<ULID>.jpg`, a `cupmark-` bucket, `image/jpeg`, base64 policy and token, `AWS4-HMAC-SHA256`, a credential scoped to `eu-central-1/s3`, a basic ISO 8601 date, a 64-hex signature). `upload.url` must be `https://cupmark-<...>.s3.eu-central-1.amazonaws.com/`. The generators need snake_case property names, so each property's description starts with `Form field <name>.`, naming the S3 form field it is sent as (`Content-Type`, `Policy`, `X-Amz-*`, `key`, `bucket`); a test pins that mapping. `x_amz_security_token` is optional (present whenever the server signs with temporary credentials, as in Lambda).
- Error responses have no body; the status code is the answer.
