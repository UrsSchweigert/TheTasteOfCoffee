# Backend

The Lambda code of Cupmark: TypeScript (strict, ESM), Node 22, bundled with esbuild for the `nodejs22.x` runtime on arm64. Design: `docs/05-system-design.md`. The API it implements: `contracts/openapi.yaml`.

## Commands

Run in `backend/` with Node `^22.18.0` or 24 and later; `.npmrc` sets `engine-strict` so `npm ci` refuses older versions (the scripts in `scripts/` are TypeScript run directly by Node's type stripping).

| Command | What it does |
| --- | --- |
| `npm ci` | Install exactly what `package-lock.json` pins. |
| `npm run generate` | Regenerate `src/generated/contract.ts` from `contracts/openapi.yaml`, and `src/generated/vocabulary.ts` from the published versions in `contracts/vocabulary/` and the contract's `x-vocabulary*` tags. Commit the result. |
| `npm run check:generated` | Regenerate in memory and fail if a committed generated file differs. |
| `npm run lint` | ESLint (typescript-eslint, strict type-checked, `any` banned) and `tsc --noEmit`. |
| `npm test` | Vitest, unit tests only (no Docker needed). Includes the same no-drift check as `check:generated`. |
| `npm run dynamodb:start` / `dynamodb:stop` | Start or stop DynamoDB Local in Docker on `127.0.0.1:8000` (`amazon/dynamodb-local:3.3.2`, pinned by digest, in memory). |
| `npm run test:integration` | The repository and the API routes against DynamoDB Local (`test/integration/`). Skips with a message if it is not reachable; with `REQUIRE_DYNAMODB_LOCAL=1` (CI) it fails instead. `DYNAMODB_ENDPOINT` overrides the endpoint, which must be a local `http://` address. |
| `npm run build` | Bundle each file in `src/handlers/` into `dist/<name>/index.mjs` (minified, with source map). `dist/` is not committed. |

## Layout

```
src/handlers/          one file per Lambda entry point (each exports `handler`): api, health, apple-idp
src/apple-idp/         the deploy-time custom resource for the Sign in with Apple provider (ADR 0015)
src/api/               the API Lambda: router, resources, body and query parsing, signed cursors, configuration
src/openfoodfacts/     the outbound Open Food Facts client, the cleaning of its text (M1-T4b), the image URL rules and the image copy (M1-T4c)
src/images/            JPEG validation and metadata stripping, and the S3 store of catalogue images (M1-T4c)
src/vocabulary/        checks a request against the vocabulary version it names; method-dependent rules hook
src/auth/user-id.ts    the caller's user id (`UserId`), from the token subject only
src/repository/        the only module that talks to DynamoDB: key builders, typed reads and writes
src/ids/ulid.ts        server-generated ids (ULIDs)
src/contract/          runtime checks used by the generated schemas (dates, uniqueness)
src/generated/         generated from contracts/ (contract.ts, vocabulary.ts); never edit by hand
scripts/codegen/       the OpenAPI-to-zod generator
scripts/               generate, check and build entry points
test/                  Vitest unit tests; test/integration/ runs against DynamoDB Local
```

## The generated contract

`src/generated/contract.ts` holds a zod schema (`<Name>Schema`) and an inferred type (`<Name>`) for every schema in `components.schemas` of `contracts/openapi.yaml`, plus `componentSchemas` keyed by name. Validate every request body with it.

The generator (`scripts/codegen/zod-from-openapi.ts`) is hand-written for the subset of JSON Schema the contract lint allows. It translates each keyword exactly and throws on anything it does not know, so a constraint can never be dropped silently. Notes:

- Objects are `z.strictObject`: unknown properties are rejected.
- A string needs `enum`, `pattern` or `format`, except response-only Open Food Facts text (ADR 0005): `x-free-text-from: open_food_facts` with `readOnly: true` and a `maxLength`, emitted as a string bounded in code points (as JSON Schema counts length, not UTF-16 units as zod's `.max` does). Without the marker, or with it but no `maxLength` or `readOnly`, the generator throws. The contract lint proves no request schema reaches such a field; `OpenFoodFactsProduct` is a response schema and must never be used to parse a request body.
- `multipleOf` must be a multiple of 2^-20 (exact in binary, the same rule as the contract lint), and values are checked with `%`, which is exact on doubles. zod's own `multipleOf` allows a small relative tolerance, which the contract does not.
- `format: date` and `format: date-time` are never more lenient than the contract's own checker (`compileComponentSchemas` in `contracts/lib/openapi.mjs`): upper-case `T` and `Z` only, 1 to 9 fraction digits, offset as `+hh:mm`, and no leap second (second 60). The backend is stricter in one way: the day must exist (no 2026-02-29 or 2026-04-31), which the contract's regular expressions do not check.
- `test/differential.test.ts` runs every generated schema next to ajv, set up as `contracts/` sets it up, on the fixtures and thousands of one-step mutations of them, and fails on any disagreement. A test there fails if the contract's date expressions change without the copy in the test.

When `contracts/openapi.yaml` changes, run `npm run generate` and commit the new file in the same pull request. `npm test` and `npm run check:generated` fail until you do.

## The repository

`src/repository/` owns every key format of the data model (`docs/05-system-design.md`, Data model; ADR 0010) and is the only code that reads or writes the table.

- `keys.ts` builds each key and validates every part first: ids must be ULIDs, barcodes 12 or 13 digits with a correct GS1 check digit (stored and keyed as EAN-13, UPC-A with a leading 0), methods and facets vocabulary ids, dates real dates. A bad part throws `InvalidKeyError` and never reaches a key.
- User-scoped functions take a `UserId`. Only `userIdFromEvent` makes one: it is a class with a private field and a module-private constructor token, so neither a string nor a look-alike object passes the type check or the run-time check (`UserId.is`). Reads also check that each returned item lies in the caller's partition.
- Creates are conditional on `attribute_not_exists(pk)`; replaces and deletes on the item existing. Failures surface as `ItemExistsError`, `ItemNotFoundError`, `BarcodeTakenError` and the like (`errors.ts`); their messages never contain input values.
- References are kept in the same transaction as the write (ADR 0012): a shelf entry needs its bean (`BeanNotFoundError`), a brew needs a shelf entry in the caller's partition (`ShelfEntryNotFoundError`), and each shelf entry counts its brews in `brewCount`, so deleting one that brews reference fails with `ShelfEntryInUseError`, and a replace that would change its `bean_id` fails with `ShelfEntryBeanLockedError` (D14). The replace is one condition on the entry, `beanId` unchanged or `brewCount` 0 (or absent); a brew create is conditional on the bean it read, so a racing brew and bean change never leave a brew under the wrong bean: one of them fails, and a failed brew is retried against the new bean. Brew items also carry `shelfEntryId` and `beanId` for the aggregator.
- **A rejected bean cannot be newly shelved (M1-T11).** `createShelfEntry` and `replaceShelfEntry` check the bean's `META` item in the same transaction with `attribute_exists(pk) AND #status <> :rejected` (`#beanUsable`); an unknown or rejected bean is `BeanNotFoundError` (404), and nothing is written. A shelf entry that already names a bean rejected later keeps working: it is listed and read as before, brews on it are logged (a brew never reads the bean), and a replace that keeps the same `bean_id` passes, so a user can always edit a bag they own. A `ConditionCheck` cannot see the entry, so that replace first fails on the bean check alone; the entry is then read once and, if it names that bean, written again with the bean only required to exist and the entry required to still name it (`#replaceKeepingBean`). If the entry changed its bean in between, that is `WriteConflictError` and the router retries the whole replace; a switch to a rejected bean is 404. The happy path stays one transaction; only a replace on a rejected bean pays one read and a second transaction.
- Values are parsed with the generated contract schemas on write and on read.
- An unverified bean carries `gsi1pk=REVIEW#UNVERIFIED` and `gsi1sk=<createdAt UTC>#<beanId>`; verifying or rejecting it removes both in the same write.
- Bean review (operator only, no API route yet): `verifyBean` and `rejectBean` read the bean first (missing is `ItemNotFoundError`, already reviewed `BeanNotUnverifiedError`) and update it on the condition that it is still unverified. **A reject frees the barcode:** the `BARCODE#` pointer is deleted in the same transaction, on the condition that it still names this bean, so the next scan can submit a fresh entry. The bean's `META` item stays, with status `rejected`, as the operator's record. A pointer that already names another bean is left alone. A pointer that changed between the read and the write, and any write that met a concurrent transaction (`rethrowConflict`, `TransactionConflict`), is `WriteConflictError`. Verifying keeps the pointer.
- `getBeanByBarcode` canonicalises the barcode, reads the pointer, then the bean, whatever its status. A pointer whose bean is missing or has another barcode is `CorruptItemError` (beans are never deleted, and a pointer is only written with its bean).
- **No creator on a bean.** Bean items do not store the sub of the user who created them, so no catalogue response can carry another user's id. If moderation ever needs a creator reference, store it in an internal attribute that `beanOf` never maps into a response, and document it here.
- `table.ts` holds the table's keys, index and stream with no imports. The integration tests create their table from it, and `infra/test/table-schema.test.ts` checks the synthesised CDK table against it.

`npm test` stays unit-only so it runs anywhere in seconds; the DynamoDB Local suite is a separate command because it needs Docker. CI runs both, with DynamoDB Local as a service container.

## The API Lambda

`src/handlers/api.ts` is the one API function (docs/05, Components). `src/api/router.ts` holds a fixed route table and serves only the routes that have landed: list, create, get, replace and delete for `/shelf`, `/brews` and `/recipes` (task M1-T5), which share one implementation (`src/api/resources.ts`), the bean catalogue: `GET /barcodes/{barcode}`, `POST /beans` and `GET /beans/{bean_id}` (task M1-T4a, `src/api/catalogue.ts`), the Open Food Facts lookup `GET /barcodes/{barcode}/open_food_facts` (task M1-T4b, `src/api/open-food-facts.ts`) and the stored catalogue images `GET /catalogue_images/{image_id}` (task M1-T4c, `src/api/catalogue-images.ts`).

For every request, in this order:

1. **Route.** Method and `rawPath` against the table. No match is 404 with no body. That includes contract routes whose tasks have not landed yet (profile, export, account): the contract declares no 501, so they are 404 until their task adds them to the table. `/health` is its own Lambda (ADR 0007). A method a path does not declare is 404 too (the contract has no 405). Matching uses `rawPath`, so the HTTP API must use the `$default` stage.
2. **Caller.** `userIdFromEvent`; none is 401.
3. **Input**, 400 on any failure: path ids (including `{image_id}`) against the contract's `Id` pattern, a `{barcode}` against `Barcode` and its GS1 check digit; the query (only `cursor` and `limit`, each at most once, and only on lists; `limit` is checked against `LimitQuery` by hand because parameters are not generated, and a test compares the two); the body (below).
4. **Operation.** Repository errors map to 404 (not in the caller's partition; a missing shelf entry; a missing bean, or a rejected one named newly by a shelf entry write, M1-T11), 409 (`DELETE /shelf/{id}` while brews reference it, ADR 0012; `PUT /shelf/{id}` that would change `bean_id` while brews reference it, D14; `POST /beans` for a barcode that already points to a bean, `BarcodeTakenError`, or with `open_food_facts_confirmed` but no cached hit, `OpenFoodFactsHitMissingError`) and 500 (including `CorruptItemError`). A write that raced another write (a changed condition, or a transaction cancelled with `TransactionConflict` by a concurrent one on the same shelf entry) is tried up to three times in all, with 10 to 100 ms of random wait.

Every error has no body, so no error echoes input. One log line per request: `operation`, `status`, `request_id` and, on failure, the error class name (the Open Food Facts lookup adds a fixed `reason` code to its 503, and a fixed `image` code to a fetched answer; the catalogue image route adds `reason` `NoSuchKey` or `AccessDenied` to its 404). Never a body, header, query, path parameter (barcode or id), token, user id, Open Food Facts text or image URL.

### Bean catalogue (M1-T4a)

The catalogue is shared: the caller only has to be signed in, and the user id is not used by these routes (nor stored on a bean, see The repository).

| Route | Answers |
| --- | --- |
| `GET /barcodes/{barcode}` | 200 with the `Bean` the canonical EAN-13 points to (UPC-A `036000291452` and EAN-13 `0036000291452` are one product). 404, no body, for an unknown barcode or one whose bean was rejected: the app then asks `GET /barcodes/{barcode}/open_food_facts` (M1-T4b). 400 for anything but 12 or 13 digits with a correct check digit, before the table is read. 400 for a query or a body. |
| `GET /barcodes/{barcode}/open_food_facts` | See Open Food Facts lookup (M1-T4b) below. |
| `POST /beans` | 201 with the new unverified `Bean`: `verified: false`, every value of `attributes` in `picked_attributes` (source "user"), `operator_attributes` `{}`, `barcode` in its 13-digit form; `open_food_facts_match: false` and no `open_food_facts` group, unless `open_food_facts_confirmed: true` copied a cached hit (below). The body is `BeanCreate` (unknown properties rejected) checked against the `vocabulary_version` it sends, so `origin`, `species` and `variety` need version 2; a barcode in the body must have a correct check digit. Bad body or a query: 400. Barcode already taken (either form): 409 (`BarcodeTakenError`), not retried. A raced write (`WriteConflictError`) is retried like the other writes. |
| `GET /beans/{bean_id}` | 200 with the `Bean`, verified or unverified. 404 for an unknown or a **rejected** bean. 400 for a bad id, a query or a body. |

Decisions (task M1-T4a):

- **A rejected bean is 404**, by id and by barcode, as if it did not exist. Rejecting deletes its barcode pointer (The repository), so a barcode lookup finds nothing and a scan can submit a fresh entry; a read that races the reject still sees the rejected status and answers 404. The `META` item stays for the operator.
- **An unverified bean is returned to every signed-in user**: the catalogue is shared, and F1 and ADR 0005 show entries right away while they wait for the operator.
- **`open_food_facts_confirmed: true`** reads the server's Open Food Facts cache (M1-T4b, below). `false` is the same as leaving it out.
- **A pointer to a missing bean is 500** (`CorruptItemError`), not 404: a 404 would send the app to the Open Food Facts lookup and then into a 409 it cannot get out of.

### Open Food Facts lookup (M1-T4b)

`GET /barcodes/{barcode}/open_food_facts` (`src/api/open-food-facts.ts`, docs/05 Barcode lookup, ADR 0005). In this order:

| Step | Answer | Counts against the cap |
| --- | --- | --- |
| Malformed barcode, bad check digit, a query or a body | 400, nothing read | no |
| The barcode points to a bean that is not rejected | 409 | no |
| Cached hit (`BARCODE#<ean>` / `OFF`) | 200 with the stored `OpenFoodFactsProduct` | no |
| Cached miss whose `expires_at` is still ahead | 404 | no |
| No valid `OFF_CONTACT`, or an invalid `OFF_LOOKUP_CAP` | 503, no outbound call | no |
| Caller's cap for the UTC day used up | 429, no outbound call | no (nothing is written) |
| Fetch: a product with a name or brand | front image copied if it has one (below), then cached as a hit, 200 | yes |
| Fetch: a product with only a front image | copied; cached as a hit with only `image_id`, 200. Copy failed transiently (`timeout`, `network`, `server_status`, `store_failed`, `no_store`): 503 `image_unavailable`, nothing cached. Copy failed permanently (`redirect`, `client_status`, `content_type`, `too_large`, `not_jpeg`): cached as a miss, 404 | yes |
| Fetch: no product, or one without name, brand and usable front image | cached as a miss for 30 days, 404 | yes |
| Fetch: timeout, network error, redirect, other status, bad body | 503, nothing cached | yes |

- **The client** (`src/openfoodfacts/client.ts`) uses Node's built-in fetch (no dependency) and one URL shape, `https://world.openfoodfacts.org/api/v2/product/<EAN-13>.json?fields=product_name,brands,image_front_url`, built from a constant origin and the canonical barcode. User-Agent `Cupmark/<version> (<contact>)`, with the version from `package.json` (a test keeps them equal). `redirect: 'manual'`: a 3xx, a response marked redirected or naming another URL is 503, so no other host is reached. A 3 s deadline covers the whole exchange, also a fetch or body that ignores the abort signal; the body is read up to 64 KiB and must be `application/json` and UTF-8. Only `status`, `product_name`, `brands` and `image_front_url` are read; an `image_front_url` that is missing, of another type or not allowed (below) is no image, never an error.
- **Text** (`src/openfoodfacts/text.ts`): NFC; white-space controls (tab, CR, LF, NEL, U+2028, U+2029) become a space; other control characters (Cc), lone surrogates, U+FEFF and the bidi embedding, override and isolate controls are removed; runs of white space become one space; trimmed; cut to 150 (name) and 100 (brand) code points at a grapheme boundary where possible; empty is absent. The brand is the first non-empty entry of `brands`. The text is never logged and never in an error.
- **The cache** (repository `getOpenFoodFactsCache`, `cacheOpenFoodFactsResult`): a hit holds `product` (name, brand, `image_id`; at least one) and `fetchedAt`, and never expires; a miss holds `fetchedAt` and `expires_at` (epoch seconds, now plus 30 days). Reads treat a miss at or past `expires_at` as absent, because the TTL delete comes later. The put is conditional on no item or a miss, so a hit is never overwritten; if it already exists, the stored hit is the answer (two racing fetches answer the same).
- **The cap** (repository `countLookup`): `USER#<sub>` / `LOOKUPS#<YYYY-MM-DD UTC>`, `ADD lookups 1` with the condition `attribute_not_exists(lookups) OR lookups < :cap`, and `expires_at` the start of the day plus 2 days. One write per counted fetch, atomic under parallel calls (tested with 40 at once on DynamoDB Local). Why cache reads and the 400 and 409 are not counted: docs/05, Barcode lookup.
- **`POST /beans` with `open_food_facts_confirmed: true`** reads the cache for the canonical barcode. A hit, with its `image_id`, is copied into the bean's `open_food_facts` group (the group's name is the source of each field in it, D5) with `open_food_facts_match: true`, next to the user's `picked_attributes`. No entry, or a miss (expired or not), is 409 `OpenFoodFactsHitMissingError` and nothing is written. Hits never expire and are never overwritten, so the read and the bean write need no transaction. The repository refuses Open Food Facts data on a bean without a barcode or without the match flag.

### Open Food Facts image copy (M1-T4c)

ADR 0011, D12, docs/05 Barcode lookup ("Image copy"). Only for a hit just fetched (never for a cache answer), before the hit is cached, so each hit's image is copied at most once.

- **Which URL** (`src/openfoodfacts/image-url.ts`). Only `image_front_url`, and only if it is, character for character, `https://images.openfoodfacts.org/images/products/<3>/<3>/<3>/<4>/front[_<lang>].<rev>.<100|200|400|full>.jpg` with the four path parts equal to the canonical EAN-13: https, that host, no userinfo, no port, no query, no fragment, no encoding tricks, and the WHATWG URL parser must agree. Assumed from the known v2 shape (the OFF docs could not be fetched from the build environment); `image_front_url` is the 400-pixel display image. The check runs again inside `fetchImage`, so nothing else can be fetched.
- **The download** (`fetchImage` in `client.ts`, plumbing shared with the lookup in `fetching.ts`): the User-Agent, `accept: image/jpeg`, `redirect: 'manual'` (any 3xx, redirected or foreign response fails), HTTP 200 only, `Content-Type: image/jpeg` only, a 2.5 s deadline over the whole exchange, and at most 1 MiB (`MAX_CATALOGUE_IMAGE_BYTES`) counted on the decoded stream.
- **Validation and stripping** (`src/images/jpeg.ts`, pure TypeScript, no dependency). The marker stream is parsed and written again: SOI; a canonical JFIF APP0 (no thumbnail) if the input had JFIF; a canonical Adobe APP14 with only the colour transform if the input had one (so CMYK and RGB JPEGs keep their colours); DQT, DHT, DRI, the frame and every scan with its entropy-coded data; EOI. Dropped: APP1 to APP15 (EXIF with GPS, XMP, ICC, MPF, IPTC/APP13), COM, the input's own APP0 and APP14 bytes, and everything after EOI. Accepted: one SOF0, SOF1 or SOF2 frame, 8-bit, 1, 3 or 4 components, 1 to 4096 pixels per side, well-formed tables and at least one scan; anything else (lossless, arithmetic, hierarchical, 12-bit, a DNL height, a truncated or broken segment, no EOI) is no image. Without the ICC profile a wide-gamut image is shown as sRGB.
- **The store** (`src/images/catalogue-store.ts`): `PutObject` of `catalogue/<ULID>.jpg` in `PHOTO_BUCKET` with `ContentType: image/jpeg`, no user metadata and a 2 s deadline, through `@aws-sdk/client-s3` (Apache-2.0, provided by the Lambda runtime and kept out of the bundle; the only dependency this task adds, and it passes `scripts/check-licences.mjs`). The cache item, the answer and a confirmed bean carry that ULID as `image_id`.
- **Failure is no image.** No usable `PHOTO_BUCKET` (nothing is downloaded), a refused URL, a failed download, a malformed JPEG or an S3 error: a product with a name or brand is cached as a hit without `image_id` and never retried for its image, because a hit is never overwritten. The lookup log line carries the outcome as a fixed `image` code: `stored`, `none` (no usable URL), `no_store`, `invalid_url`, `redirect`, `client_status` (a 4xx or other non-200), `server_status` (429 or 5xx), `content_type`, `too_large`, `timeout`, `network`, `not_jpeg`, `store_failed`.
- **A product with only an image** (no name and no brand after cleaning) has nothing to show without it, so the failure kind decides (`isTransientCopyFailure` in `image-copy.ts`). Transient (`timeout`, `network`, `server_status`, `store_failed`, `no_store`): 503 with `reason: image_unavailable` and nothing cached, so a temporary outage never caches a 30-day miss and a later lookup tries again. Permanent (`redirect`, `client_status`, `content_type`, `too_large`, `not_jpeg`): cached as a miss, 404. The fetch counts against the caller's cap in both cases, like any other fetch that ends in 503: Open Food Facts did the work, and a retry loop must not be free.
- **A race leaves an orphan.** Two fetches of one new barcode may both copy an image; the hit written first wins, and the other object stays under `catalogue/` unreferenced. That is rare, a few KiB, and accepted (no lifecycle rule removes catalogue objects; an operator can sweep unreferenced ones later).
- **Latency.** The lookup is synchronous: 3 s for the read API, 2.5 s for the image and 2 s for S3 leave room for DynamoDB inside the function's 10 s timeout.

### Catalogue images (M1-T4c)

`GET /catalogue_images/{image_id}` (`src/api/catalogue-images.ts`). Behind the token like every route; the catalogue is shared, so any signed-in user may read any copy.

| Case | Answer |
| --- | --- |
| `image_id` not a contract `Id` (ULID), a query or a body | 400, before S3 is asked |
| No token | 401 |
| No object `catalogue/<image_id>.jpg` (S3 `NoSuchKey`, or `AccessDenied`, which S3 answers for a missing key to a role without `s3:ListBucket`) | 404 |
| No usable `PHOTO_BUCKET` | 404 (the contract has no 503 here; the log says `PhotoBucketNotConfigured`) |
| An object over 1 MiB, of unknown size, or not starting like a JPEG; any other S3 error | 500 |
| Found | 200, the bytes base64-encoded (`isBase64Encoded: true`), `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable` |

The cache header: an id names one stored copy forever (new copies get new ULIDs and objects are never overwritten), so it is immutable for a year. It is `private`, not `public`, because the request carries an Authorization header and the route is meant for signed-in users only: the app's own URL cache may keep it, no shared cache or CDN may. 1 MiB is about 1.4 MB as base64, well under the 6 MB Lambda response limit.

### Body validation

`parseBody` in `src/api/http.ts`: JSON content type; at most 16 KiB (checked on the encoded size before base64 decoding, and again after); valid UTF-8; `JSON.parse`; the generated zod schema (unknown properties rejected); then `conformsToVocabulary` against the `vocabulary_version` of the body; then the method-dependent rules.

`conformsToVocabulary` (`src/vocabulary/check.ts`) walks the value with the bindings in `src/generated/vocabulary.ts`, which come from the contract's `x-vocabulary`, `x-vocabulary-range` (with `x-vocabulary-scale`), `x-vocabulary-keys`, `x-vocabulary-max-items` and `x-vocabulary-version` tags. Each id must be in that version's list, each number in that version's range and on its step, each array within that version's maximum, and every `vocabulary_version` in the value equal to the version checked. A draft or unknown version fails. No list, range or limit is written in the backend: the generator reads `contracts/vocabulary/v<N>/`, takes only versions whose files are all `published` and match their lock byte for byte (it fails otherwise), and emits the data the bindings use. Publishing a version means running `npm run generate`; `npm test` and `npm run check:generated` fail until the result is committed.

**Method-dependent fields.** The spec (F2) says fields depend on the method but defines no mapping, vocabulary v1 has none, and the contract says so on `BrewParameters`. `src/vocabulary/method-rules.ts` is the hook, with an empty rule set for every version: every field is allowed with every method. Rules belong in the vocabulary once defined; the hook should then read them from the generated module. The one cross-field rule the contract does define (`water_temp_c` and `water_temp_special` exclude each other) is not method-dependent and is enforced by the generated schema.

### Cursors

The contract's `Cursor` is HMAC-signed (`src/api/cursor.ts`): `base64url(HMAC-SHA256(key, "cupmark-cursor-v1", list, caller, inner))` (43 characters) followed by the repository's cursor. A cursor from another list, another caller or another key, a changed character, or the repository's unsigned cursor is 400. The repository then checks the inner cursor again.

### Configuration (set by infra, M1-T2: `infra/src/api.ts`)

| Variable | Value |
| --- | --- |
| `TABLE_NAME` | `cupmark-<stage>-main`. Missing: every request is 500. |
| `OFF_CONTACT` | The operator mailbox named in the Open Food Facts User-Agent, an e-mail address (for example a project ops mailbox). Plain configuration, not a secret, never in the repo and not in Secrets Manager. Missing or not an e-mail address: the lookup answers from the cache only, and is 503 with no outbound call otherwise. |
| `OFF_LOOKUP_CAP` | Open Food Facts fetches per user and UTC day. Optional, default 50; a plain integer from 0 (no fetches) to 10000. Anything else: the lookup is 503 before it counts or fetches. |
| `PHOTO_BUCKET` | The photo bucket's name (`cupmark-<stage>-photos-<account>`), for the catalogue image copies under `catalogue/` (M1-T4c). Must start with `cupmark-` (invariant 9). Missing or another name: hits are cached without an image, and `GET /catalogue_images/{image_id}` is 404. |
| `CURSOR_KEY_PARAMETER` | Name of a Parameter Store **SecureString** under `/cupmark/` (for example `/cupmark/<stage>/cursor-key`), holding standard base64 of at least 32 random bytes (for example `openssl rand -base64 32`). Missing, unreadable, not a SecureString or too short: list routes are 500 and no cursor is accepted or issued (fail closed); other routes work. A failed read is retried after 60 s at the earliest. |

**Follow-up for infra (M1-T2, `infra/src/api.ts`):** `OFF_CONTACT` and `OFF_LOOKUP_CAP` are not set by the stack yet, so a deployed lookup answers 503 for every uncached barcode until they are. `PHOTO_BUCKET` is not set yet either (M1-T4c): until it is, no image is copied. The role already has `s3:GetObject` and `s3:PutObject` on `catalogue/*`; without `s3:ListBucket` a missing image reads as `AccessDenied`, which the route also answers as 404. The API function needs outbound HTTPS to `world.openfoodfacts.org` and `images.openfoodfacts.org` (it is not in a VPC, so it has it; no NAT gateway). Its 10 s timeout covers the 3 s lookup, the 2.5 s image download and the 2 s S3 write.

The API role needs `ssm:GetParameter` on exactly that parameter's ARN; the AWS-managed key `alias/aws/ssm` needs no extra grant. The key is read once per cold start and kept in memory only (ADR 0013). Its value is created by a human and never passes through the repo or CI. Tests generate their own key.

## The Apple provider function

`src/handlers/apple-idp.ts` is not part of the API: CloudFormation invokes it only when the stack creates, updates or deletes the custom resource `Custom::CupmarkAppleIdentityProvider` (ADR 0015, infra/README.md). `src/apple-idp/provider.ts` validates the properties (pool in eu-central-1, key parameter `/cupmark/<dev|prod>/apple-sign-in-key`, Apple scopes `name`/`email` only), reads the SecureString with decryption (it must be a SecureString holding a PEM key), and creates or updates the `SignInWithApple` provider; Delete removes it and treats an already missing provider or pool as success. The response is PUT to CloudFormation's presigned HTTPS URL with `NoEcho`. The key is never logged, never in the response, and failure reasons are error class names only. It uses `@aws-sdk/client-cognito-identity-provider` and `@aws-sdk/client-ssm` (Apache-2.0, provided by the Lambda runtime, kept out of the bundle). Tests: `test/apple-idp.test.ts`, with fake clients and a key generated per run.
