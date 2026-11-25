# Backend

The Lambda code of Cupmark: TypeScript (strict, ESM), Node 22, bundled with esbuild for the `nodejs22.x` runtime on arm64. Design: `docs/05-system-design.md`. The API it implements: `contracts/openapi.yaml`.

## Commands

Run in `backend/` with Node `^22.18.0` or 24 and later; `.npmrc` sets `engine-strict` so `npm ci` refuses older versions (the scripts in `scripts/` are TypeScript run directly by Node's type stripping).

| Command | What it does |
| --- | --- |
| `npm ci` | Install exactly what `package-lock.json` pins. |
| `npm run generate` | Regenerate `src/generated/contract.ts` from `contracts/openapi.yaml`, `src/generated/vocabulary.ts` from the published versions in `contracts/vocabulary/` and the contract's `x-vocabulary*` tags, and `src/generated/export.ts` from the `x-csv-columns` and `x-csv-item-types` of `GET /export`. Commit the result. |
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
src/images/            JPEG validation and metadata stripping, the S3 store of catalogue images (M1-T4c) and of label photos (M1-T4d), the deletion of label photo versions (M1-T6)
src/account/           the deletion log in S3 and the Cognito user deletion, for DELETE /account (M1-T6)
src/vocabulary/        checks a request against the vocabulary version it names; method-dependent rules hook
src/auth/user-id.ts    the caller's user id (`UserId`), from the token subject only
src/repository/        the only module that talks to DynamoDB: key builders, typed reads and writes
src/ids/ulid.ts        server-generated ids (ULIDs)
src/contract/          runtime checks used by the generated schemas (dates, uniqueness)
src/generated/         generated from contracts/ (contract.ts, vocabulary.ts, export.ts); never edit by hand
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

`src/generated/export.ts` holds `EXPORT_CSV_COLUMNS` and `EXPORT_CSV_ITEM_TYPES`, the header and row order of the CSV export, taken from the `x-csv-columns` and `x-csv-item-types` extensions on the `text/csv` response of `GET /export` (`scripts/codegen/csv-export.ts`). The generator checks only what the backend relies on (non-empty lists of unique snake_case names, `item_type` first); the contract lint proves the columns match the exported resources.

When `contracts/openapi.yaml` changes, run `npm run generate` and commit the new file in the same pull request. `npm test` and `npm run check:generated` fail until you do.

## The repository

`src/repository/` owns every key format of the data model (`docs/05-system-design.md`, Data model; ADR 0010) and is the only code that reads or writes the table.

- `keys.ts` builds each key and validates every part first: ids must be ULIDs, barcodes 12 or 13 digits with a correct GS1 check digit (stored and keyed as EAN-13, UPC-A with a leading 0), methods and facets vocabulary ids, dates real dates. A bad part throws `InvalidKeyError` and never reaches a key.
- User-scoped functions take a `UserId`. Only `userIdFromEvent` makes one: it is a class with a private field and a module-private constructor token, so neither a string nor a look-alike object passes the type check or the run-time check (`UserId.is`). Reads also check that each returned item lies in the caller's partition.
- Creates are conditional on `attribute_not_exists(pk)`; replaces and deletes on the item existing. Failures surface as `ItemExistsError`, `ItemNotFoundError`, `BarcodeTakenError` and the like (`errors.ts`); their messages never contain input values.
- References are kept in the same transaction as the write (ADR 0012): a shelf entry needs its bean (`BeanNotFoundError`), a brew needs a shelf entry in the caller's partition (`ShelfEntryNotFoundError`), and each shelf entry counts its brews in `brewCount`, so deleting one that brews reference fails with `ShelfEntryInUseError`, and a replace that would change its `bean_id` fails with `ShelfEntryBeanLockedError` (D14). The replace is one condition on the entry, `beanId` unchanged or `brewCount` 0 (or absent); a brew create is conditional on the bean it read, so a racing brew and bean change never leave a brew under the wrong bean: one of them fails, and a failed brew is retried against the new bean. Brew items also carry `shelfEntryId` and `beanId` for the aggregator.
- **A rejected bean cannot be newly shelved (M1-T11).** `createShelfEntry` and `replaceShelfEntry` check the bean's `META` item in the same transaction with `attribute_exists(pk) AND #status <> :rejected` (`#beanUsable`); an unknown or rejected bean is `BeanNotFoundError` (404), and nothing is written. A shelf entry that already names a bean rejected later keeps working: it is listed and read as before, brews on it are logged (a brew never reads the bean), and a replace that keeps the same `bean_id` passes, so a user can always edit a bag they own. A `ConditionCheck` cannot see the entry, so that replace first fails on the bean check alone; the entry is then read once and, if it names that bean, written again with the bean only required to exist and the entry required to still name it (`#replaceKeepingBean`). If the entry changed its bean in between, that is `WriteConflictError` and the router retries the whole replace; a switch to a rejected bean is 404. The happy path stays one transaction; only a replace on a rejected bean pays one read and a second transaction.
- **Every write of a caller checks the account tombstone (M1-T6; ADR 0017, Addendum).** `#transactAs` appends a `ConditionCheck` on `DELETED#<sub>` / `META` (`attribute_not_exists(pk) OR expires_at <= :now`) as the last item of the caller's transaction, so the indices the error handling inspects do not move; a failed check is `AccountDeletedError` (API: 401) and nothing is written. Writes that used to be a single put, update or delete of the caller's items are now one-item transactions with the check: `putProfile`, `deleteShelfEntry`, `createRecipe`, `replaceRecipe`, `deleteRecipe`, the daily counters (`countLookup`, `countLabelPhotoUpload`) and `createPendingLabelPhoto`. That is race-free where a read before the write is not: the deletion writes the tombstone before it reads the partition, so a write either lands before that read (and is deleted) or fails. Cost (pay-per-use): a transaction costs twice the write units of the same writes outside one, and the `ConditionCheck` is one more transactional read (2 read units). So the one-item writes above now cost about twice their write units plus that read, and the multi-item writes that were already transactions add only the read. `createBean` takes the caller as an optional second argument only for this check (never stored); the API always passes it, operator tooling and test setup may not. `discardPendingLabelPhoto` (a delete) has no check; its route checks first (below). Reads need none: after a deletion the partition is empty.
- Values are parsed with the generated contract schemas on write and on read.
- An unverified bean carries `gsi1pk=REVIEW#UNVERIFIED` and `gsi1sk=<createdAt UTC>#<beanId>`; verifying or rejecting it removes both in the same write.
- Bean review (operator only, no API route yet): `verifyBean` and `rejectBean` read the bean first (missing is `ItemNotFoundError`, already reviewed `BeanNotUnverifiedError`) and update it on the condition that it is still unverified. **A reject frees the barcode:** the `BARCODE#` pointer is deleted in the same transaction, on the condition that it still names this bean, so the next scan can submit a fresh entry. The bean's `META` item stays, with status `rejected`, as the operator's record. A pointer that already names another bean is left alone. A pointer that changed between the read and the write, and any write that met a concurrent transaction (`rethrowConflict`, `TransactionConflict`), is `WriteConflictError`. Verifying keeps the pointer.
- `getBeanByBarcode` canonicalises the barcode, reads the pointer, then the bean, whatever its status. A pointer whose bean is missing or has another barcode is `CorruptItemError` (beans are never deleted, and a pointer is only written with its bean).
- **No creator on a bean.** Bean items do not store the sub of the user who created them, so no catalogue response can carry another user's id. If moderation ever needs a creator reference, store it in an internal attribute that `beanOf` never maps into a response, and document it here.
- `table.ts` holds the table's keys, index and stream with no imports. The integration tests create their table from it, and `infra/test/table-schema.test.ts` checks the synthesised CDK table against it.

`npm test` stays unit-only so it runs anywhere in seconds; the DynamoDB Local suite is a separate command because it needs Docker. CI runs both, with DynamoDB Local as a service container.

## The API Lambda

`src/handlers/api.ts` is the one API function (docs/05, Components). `src/api/router.ts` holds a fixed route table and serves only the routes that have landed: list, create, get, replace and delete for `/shelf`, `/brews` and `/recipes` (task M1-T5), which share one implementation (`src/api/resources.ts`), the bean catalogue: `GET /barcodes/{barcode}`, `POST /beans` and `GET /beans/{bean_id}` (task M1-T4a, `src/api/catalogue.ts`), the Open Food Facts lookup `GET /barcodes/{barcode}/open_food_facts` (task M1-T4b, `src/api/open-food-facts.ts`) the stored catalogue images `GET /catalogue_images/{image_id}` (task M1-T4c, `src/api/catalogue-images.ts`), the label photo upload `POST /beans/{bean_id}/label_photos` and `POST /label_photos/{photo_id}/complete` (task M1-T4d, `src/api/label-photos.ts`), and the profile, export and account deletion `GET` and `PUT /profile`, `GET /export` (`src/api/export.ts`) and `DELETE /account` (`src/api/account.ts`) (task M1-T6). That is every operation of the contract except `GET /health`.

For every request, in this order:

1. **Route.** Method and `rawPath` against the table. No match is 404 with no body. `/health` is its own Lambda (ADR 0007). A method a path does not declare is 404 too (the contract has no 405). Matching uses `rawPath`, so the HTTP API must use the `$default` stage.
2. **Caller.** `userIdFromEvent`; none is 401.
3. **Input**, 400 on any failure: path ids (including `{image_id}`) against the contract's `Id` pattern, a `{barcode}` against `Barcode` and its GS1 check digit; the query (only `cursor` and `limit`, each at most once, and only on lists; `limit` is checked against `LimitQuery` by hand because parameters are not generated, and a test compares the two); the body (below).
4. **Operation.** Repository errors map to 404 (not in the caller's partition; a missing shelf entry; a missing bean, or a rejected one named newly by a shelf entry write, M1-T11), 409 (`DELETE /shelf/{id}` while brews reference it, ADR 0012; `PUT /shelf/{id}` that would change `bean_id` while brews reference it, D14; `POST /beans` for a barcode that already points to a bean, `BarcodeTakenError`, or with `open_food_facts_confirmed` but no cached hit, `OpenFoodFactsHitMissingError`) 401 (`AccountDeletedError`: the caller's account tombstone is in force, M1-T6) and 500 (including `CorruptItemError`). A write that raced another write (a changed condition, or a transaction cancelled with `TransactionConflict` by a concurrent one on the same shelf entry) is tried up to three times in all, with 10 to 100 ms of random wait.

Every error has no body, so no error echoes input. One log line per request: `operation`, `status`, `request_id` and, on failure, the error class name (the Open Food Facts lookup adds a fixed `reason` code to its 503, and a fixed `image` code to a fetched answer; the catalogue image route adds `reason` `NoSuchKey` or `AccessDenied` to its 404; the label photo routes add the same to a missing upload, `label_orphaned` when a stripped copy was written but not recorded, `label_deleted` when a completion that raced an account deletion deleted its copy, and `label_cleanup_failed` when it could not). Never a body, header, query, path parameter (barcode or id), token, user id, Cognito username, photo or bean id, S3 key, bucket, user pool id, item or photo count, presigned URL, policy, signature, credential, Open Food Facts text or image URL. Account deletion and the export log fixed codes only (below).

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

### Label photos (M1-T4d)

ADR 0016, docs/04 F1 step 4, D10, D12. Two routes, user-scoped: every item is in the caller's partition, built from the token's subject only. No request field reaches S3 or a key: the photo id and the keys are server-chosen. Label photos are never served by the API; the operator's tooling reads `labels/` later.

`POST /beans/{bean_id}/label_photos` (`createLabelPhotoUpload`), in this order:

| Case | Answer |
| --- | --- |
| Bad `bean_id`, a query or a body | 400, nothing read |
| No token | 401 |
| No usable `PHOTO_BUCKET` | 500 `PhotoBucketNotConfigured` |
| No such bean, or a rejected one | 404 |
| A verified bean | 409 |
| The caller already has 3 completed photos for the bean (`BEANPHOTOS#<beanId>`; pending uploads do not count) | 409 |
| The caller's 20 new uploads for the UTC day are used up | 429 (only requests that got this far count) |
| Otherwise | 201 `LabelPhotoUpload` |

The 201 writes the pending item `USER#<sub>` / `PHOTO_PENDING#<photoId>` (bean id, `expires_at` 1 day ahead, TTL), then presigns with `@aws-sdk/s3-presigned-post`:

- key `uploads/<photoId>.jpg`, field `Content-Type: image/jpeg`, `Expires` 600 s;
- policy conditions: `["eq", "$key", <key>]`, `["content-length-range", 1, 8388608]`, `["eq", "$Content-Type", "image/jpeg"]`, `["eq", "$bucket", <bucket>]` (the presigner adds the exact-match form of every field as well).

The SDK's field names are mapped to the contract's (`key`, `bucket`, `Content-Type` to `content_type`, `Policy` to `policy`, `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Security-Token` and `X-Amz-Signature` to `x_amz_*`). The answer is then checked against the generated `LabelPhotoUpload` schema, and the key, the bucket and the URL (`https://<bucket>.s3.eu-central-1.amazonaws.com/`) against what was signed. Any mismatch, including a field the mapping does not know, is 500 `LabelPhotoUploadInvalid`; a failure to sign is 500 with the error class name. `expires_at` is the server's clock at signing plus 600 s.

`POST /label_photos/{photo_id}/complete` (`completeLabelPhoto`), in this order:

| Case | Answer |
| --- | --- |
| Bad `photo_id`, a query or a body | 400, nothing read |
| No token | 401 |
| No usable `PHOTO_BUCKET` | 500 |
| No pending item of the caller, and no completed `PHOTO#<photoId>` of the caller | 404 (unknown, another caller's, expired, or rejected before: all look the same) |
| No pending item, but the caller completed this photo | 409 |
| The bean is no longer unverified, or the caller has 3 photos for it | 409, before S3 is read |
| No upload (`NoSuchKey`, or `AccessDenied` without `s3:ListBucket`) | 404; the pending item stays, so the app may upload and call again |
| Over 8 MiB (`ContentLength`, checked before the body is read, then the byte count), or not a JPEG `jpeg.ts` accepts (baseline or progressive, 8-bit, at most 4096 px a side) | 400; the pending item is deleted, so every later call is 404 |
| S3 read or write error | 500; nothing recorded, the pending item stays |
| Otherwise | 204 |

The stripped bytes (`stripJpeg`: EXIF, GPS, XMP, ICC, IPTC, comments, thumbnails and trailing data dropped) are written to `labels/<photoId>.jpg` with `ContentType: image/jpeg` and no metadata. Then one transaction (`Repository.completeLabelPhoto`):

1. delete the pending item, if it exists, names this bean and has not expired;
2. put `USER#<sub>` / `PHOTO#<photoId>` {photoId, beanId, createdAt};
3. put `BEAN#<beanId>` / `PHOTO#<photoId>` {photoId, createdAt}, with no user id (D10: verification can drop the link by deleting the user item alone);
4. `ADD photos 1` on `USER#<sub>` / `BEANPHOTOS#<beanId>`, if `photos` is below 3, so parallel completions cannot pass the cap (tested with 4 at once on DynamoDB Local);
5. a ConditionCheck that the bean's `META` still has status `unverified`.

A failed condition is 409 (already completed, bean reviewed meanwhile, cap reached) or 404 (pending item gone); a transaction cancelled by a concurrent one is retried like other writes. If the transaction fails after the S3 write, the `labels/` object is an orphan: no item references it, the operator's tooling follows only `BEAN#` / `PHOTO#` items, and the log says `reason: label_orphaned`. As with catalogue images, that is rare and accepted; an operator can sweep unreferenced objects. Outside account deletion the API deletes nothing in S3: the raw upload under `uploads/` expires by the bucket's lifecycle rule (1 day, its noncurrent version 1 day later).

Since M1-T6 the completion first reads the caller's account tombstone (strongly consistent) and answers 401 if it is in force, before the pending item, the bean or S3 is read, so no `labels/` object is written for an account already being deleted. The transaction checks the tombstone again. A deletion can still start after that read and finish while the completion strips the photo: it deletes `labels/<id>.jpg` before the copy exists and then empties the partition, so the copy written afterwards would be found by nothing. So when the completion's transaction fails and the tombstone is in force (`AccountDeletedError`, or any other failure with the tombstone present on a fresh read), the completion deletes every version of `labels/<id>.jpg` and `uploads/<id>.jpg` itself (`LabelPhotoConfig.cleanup`, the same `PhotoDeletionStore` as account deletion) and answers 401 with `reason: label_deleted`. If that cleanup fails, it records the photo id on the caller's tombstone and answers 500 `LabelCleanupFailed` with `reason: label_cleanup_failed`, so the app retries. On the retry the tombstone check finds the id (on the caller's own tombstone, which proves the photo was the caller's) and deletes the objects again before the 401; a retry of `DELETE /account` deletes the objects of every id on the tombstone too. A tombstone that does not list the photo id is a plain 401 with no S3 call, so no other user's photo can be deleted through this route. Tests interleave the two operations (`test/api/account.test.ts`, `test/integration/account.test.ts`). `POST /beans/{bean_id}/label_photos` needs no read first: its first write (the daily counter) is guarded, so a deleted caller gets 401 before anything is written or signed.

Decisions (task M1-T4d):

- **Daily cap of 20 new uploads per user and UTC day** (`LABEL_PHOTO_DAILY_CAP`, a constant, not configuration): F1 needs at most 3 per bean, and 20 leaves room for a few beans and retries while bounding pending items and S3 writes. Counter `USER#<sub>` / `PHOTO_UPLOADS#<YYYY-MM-DD>`, attribute `uploads`, the same atomic conditional `ADD` as the lookup cap (`countLookup`), `expires_at` the start of the day plus 2 days.
- **The 3-photo cap is a counter**, `BEANPHOTOS#<beanId>`, not a count of `PHOTO#` items: a condition can only test one item, and the counter makes the cap atomic. It never goes down (there is no route that deletes a label photo).
- **Pre-checks at completion.** The bean status and the counter are read before any S3 work, so the common refusals leave no orphan and do not consume the pending item; the transaction checks both again.
- **Without a photo bucket both routes answer 500** (the contract declares no 503 for them), with `PhotoBucketNotConfigured` in the log.

**Export and account deletion (M1-T6)** use these items as described under Export and Account deletion below.

**Dependency and bundling.** `@aws-sdk/s3-presigned-post` 3.1177.0 (Apache-2.0, pinned exact like the other SDK packages; it passes `scripts/check-licences.mjs`). It is **bundled**, not taken from the Lambda runtime: whether the `nodejs22.x` runtime ships it could not be confirmed from the build environment (the base image could not be pulled), and a missing module would fail every route at cold start. `scripts/build.ts` keeps every other `@aws-sdk/*` import external, including its `@aws-sdk/client-s3` import, so it signs with the runtime's S3Client; it bundles the helpers it needs from `@aws-sdk/core` and `@smithy/*` (the API bundle grows by about 27 KB in all against main, label photo code included). The build prefers ES module entries (`mainFields: ['module', 'main']`), because the package's CommonJS entry would `require()` the external client-s3, which throws in an ESM bundle; a guard in the build fails on any `require()` of an external package. The other bundles are unchanged byte for byte. A create that fails at signing (500) has already used one of the caller's 20 daily uploads and left a pending item, which expires by TTL; that is accepted.

### Profile (M1-T6)

`GET /profile` and `PUT /profile`, user-scoped, item `USER#<sub>` / `PROFILE` (D1, ADR 0017).

| Case | Answer |
| --- | --- |
| No token | 401 |
| A query, or a body on GET | 400 |
| `GET` before the first `PUT` | 404, no body (the app runs onboarding and asks for consent) |
| `GET` | 200 with the stored `Profile` (`locale`, `consent.contribute_to_aggregates`) |
| `PUT` with a body that is not exactly a `Profile` (unknown property, a locale outside the list, consent not a boolean, missing field, not JSON) | 400, nothing stored |
| `PUT` while the caller's account tombstone is in force | 401, nothing stored |
| `PUT` | 200 with the stored profile; it replaces locale and consent |

`Profile` has no `vocabulary_version` (locale is a contract enum, consent a boolean), so the body goes through `parseJsonBody` (content type, size, UTF-8, JSON, the generated schema with unknown properties rejected) without the vocabulary step. The repository writes it as an update of `values`, `type`, `updatedAt` and `createdAt` (if not set), so attributes added later (the entitlement, M4) are kept. The transaction returns no item; the answer is the values written.

**For M3 (aggregator; D1, D2).** Consent is opt-in and false until the user agrees. The aggregator must count a brew only if its author's `consent.contribute_to_aggregates` was true when the brew was written. Reading the profile in the aggregator per stream record is one item read; alternatively, copy the flag onto the brew item at write time (an internal attribute, like `beanId`) so the stream's old image carries it for the subtraction too; that is the simpler choice and should be decided in M3 with an ADR. Deleting an account deletes every brew item, and the aggregator subtracts each removed brew from the stream's old image as for any brew delete (D2); it must then only subtract brews it had counted, which a consent flag on the brew item makes possible. Tombstones (`ACCOUNT_TOMBSTONE`) and every other non-brew item in the stream are ignored.

### Export (M1-T6)

`GET /export` (`src/api/export.ts`; ADR 0017, point 5; the contract's `exportData` description is the specification).

- **Format.** `Content-Type: text/csv; charset=utf-8; header=present`, plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. UTF-8 without a byte order mark, RFC 4180, every field (the header too) in double quotes, CRLF after every row including the last. No `Content-Disposition`: the contract declares no response headers for the export, so none is added (the app saves the file itself).
- **Columns and rows.** The header is `EXPORT_CSV_COLUMNS` and the rows come in `EXPORT_CSV_ITEM_TYPES` order (both generated from the contract, see The generated contract), each type sorted by ascending id (`brew_id`, not `brewed_at`). The profile row is left out while there is no profile; a caller with no items, or a deleted one, gets the header only.
- **Flattening.** The contract's rule, applied generically: `values`, `parameters`, `rating` and `consent` add their fields with no prefix; any other object (`scores`, `intensities`) adds them as `<object>_<field>`; an array is its ids joined by `;`; booleans `true` / `false`; numbers in JavaScript's shortest round-trip form, which for the contract's ranges is plain decimal without exponent or trailing zeros. A field that has no column, two fields on one column, a value with `"`, `,`, CR or LF (or `;` inside a list), or a number with an exponent cannot happen with the stored schemas; if it did, the export is 500 `ExportShapeError` rather than a broken file. Label photo rows hold `photo_id` and `bean_id` only.
- **What is read.** `Repository.exportItems`: `PROFILE`, then `begins_with` queries for `SHELF#`, `BREW#`, `RECIPE#` and `PHOTO#` in the caller's partition, all pages, strongly consistent. `BREWID#`, `LOOKUPS#`, `PHOTO_PENDING#`, `BEANPHOTOS#` and `PHOTO_UPLOADS#` are never read (counters and pending uploads are not the user's data). Each item is parsed with its stored schema, and its sort key must match its prefix.
- **Size limit.** The Lambda response limit is 6 MB for the whole response. The CSV may be at most `MAX_EXPORT_BYTES` = 5 MiB, which leaves room for the headers and the JSON envelope. A full brew row is under 400 bytes (a test pins it), so that is more than 13,000 brews: about 35 years of one brew a day, or 9 years of four. Above it the answer is 500 with the fixed code `ExportTooLargeError` and no body. The fix then is an asynchronous export to S3 with a presigned download (a new task and a contract change). Reading 13,000 brews is about 8 MB of items in about 8 query pages, well inside the 10 s timeout.

### Account deletion (M1-T6)

`DELETE /account` (`src/api/account.ts`; ADR 0017 and its Addendum; D2, D10, D11). In this order:

0. **Preconditions**, before anything changes, each 500 with a fixed code: no usable `PHOTO_BUCKET` (`PhotoBucketNotConfigured`), `DELETION_LOG_BUCKET` (`DeletionLogNotConfigured`) or `USER_POOL_ID` (`UserPoolNotConfigured`); no valid `username` claim in the token (`UsernameMissing`). A query or a body is 400; no token 401.
1. **Tombstone** `DELETED#<sub>` / `META` (`markAccountDeleted`): a conditional put of `{deletedAt, expires_at: now + 2 h}`. If one is already in force, it is kept (its `deletedAt`, photo ids and log mark), and only its `expires_at` moves forward to now + 2 h. If one exists but has expired (TTL has not removed it yet), it is replaced by a fresh one.
2. **Label photos** (`accountPhotos`: the `PHOTO#` and `PHOTO_PENDING#` items). A completed photo whose bean is not verified (unverified, rejected, or missing) is deleted in full: its id is added to the tombstone's `photoIds` (a string set) first, then every version and delete marker of `labels/<id>.jpg` and `uploads/<id>.jpg` (`src/images/photo-deletion-store.ts`), then the bean's `BEAN#<beanId>` / `PHOTO#<id>` item. A photo already on the tombstone from an earlier attempt is deleted in full whatever its bean's status is now, so a retry finishes the same set. For a verified bean, the stored photo and the bean's item stay (shared catalogue, D10) and only the raw upload `uploads/<id>.jpg` is deleted, since it still has its metadata; the user-side item goes with the partition, which drops the link to the user. For each pending upload, every version of both keys is deleted (a `labels/` copy exists if a completion wrote it and then failed), and its id is recorded too. So is every id on the tombstone that has no item left (a completion that raced the deletion and could not delete its copy recorded it there, see Label photos). At most 8 photos are handled at a time.
3. **Partition** (`deleteUserPartition`): every key of `USER#<sub>` is read (all pages, strongly consistent, keys only), then deleted with `BatchWriteItem` in pages of 25. Up to 8 pages are in flight at once (`BATCH_WRITE_CONCURRENCY`); after a failure no new page starts. Unprocessed items are sent again after a wait of 25 ms doubling up to 1 s, with jitter, up to 8 attempts per page; anything left then is `DeletionIncompleteError` (500), and the retry finishes. Expected time for the largest partition the export allows (about 13,000 brews, so about 26,000 items with their pointers): reading the keys is about 13 query pages of 1 MB (the limit counts the full items, not the projected keys), about 1 to 2 s; deleting is 1,040 batches, 8 at a time at 20 to 40 ms each, about 3 to 5 s. That fits the 10 s timeout. A table that has never seen that write rate may throttle part of it (unprocessed items, then retries); if the time runs out, the app's retry continues with what is left. This removes the profile, shelf entries, brews and their pointers, recipes, the `PHOTO#`, `PHOTO_PENDING#`, `BEANPHOTOS#` and `PHOTO_UPLOADS#` items and the `LOOKUPS#` counters.
4. **Deletion log** (`src/account/deletion-log.ts`): `PutObject` of `entries/<new ULID>.json` in `DELETION_LOG_BUCKET`, `ContentType: application/json`, body `{"sub", "photo_ids", "deleted_at"}`: the photo ids on the tombstone (sorted) and the tombstone's `deletedAt` (when the deletion began, so a restore that re-applies entries newer than its restore point never misses one). Then the tombstone gets `loggedAt`, so a retry or a repeat writes no second entry (only a failure between the put and that mark, or two calls at once, can write a second identical entry, which a restore simply applies twice). The ULID is never derived from the user.
5. **Cognito** (`src/account/user-pool.ts`): `AdminDeleteUser` on `USER_POOL_ID` with the token's `username` claim; `UserNotFoundException` is success.

204 when every step succeeded. Any failure is 500 with the error class name as the log's `error`; the app retries with the same token and every step is repeated safely. A repeat after the 204 (tombstone present, partition empty, user gone) is 204 and changes nothing.

**The app must retry until it gets a 204.** If step 5 fails and the app never retries, the Cognito user remains. Once the tombstone expires (2 hours after the last call), that user can sign in and write again into a fresh partition, and a later restore from backup, which re-applies the deletion log entry, would delete that new data along with the old. The server cannot finish the deletion on its own (there is no queue or sweep, ADR 0017), so the app (M2) must keep retrying `DELETE /account`, also across launches, until it gets a 204, and only then sign out.

Decisions (task M1-T6, lead's brief and ADR 0014):

- **The username comes from the token's `username` claim** (`cognitoUsernameFromEvent`, a nominal type like `UserId`), never from the request. Cognito access tokens carry the pool username there; for a Sign in with Apple user it is `SignInWithApple_<id>`. Only `[A-Za-z0-9_.@+-]{1,128}` is accepted; anything else is 500 `UsernameMissing` before any change. `sub` is not used for this call, because for a federated user AdminDeleteUser needs the username.
- **"Not verified" instead of "unverified" (D10).** The owner's D10 keeps only photos of *verified* beans and deletes every other photo the user uploaded; the contract says "beans that are not verified yet". A rejected bean is not in the shared catalogue, so its photos are deleted in full like those of an unverified bean, and so are photos whose bean item is missing.
- **Raw uploads of verified-bean photos are deleted too.** `uploads/<id>.jpg` still has the metadata D12 strips, and nothing reads it after completion.
- **The tombstone's expiry moves forward on a retry.** "Keep the earlier one" holds for `deletedAt`, the photo ids and the log mark. Keeping the earlier `expires_at` as well would let the guard lapse when a retry comes more than an hour after the first call (the user still exists in Cognito until step 5 and can get new tokens), so it is extended to now + 2 h. An expired tombstone blocks nothing and is replaced.
- **The tombstone holds the photo ids** deleted in full, so a retry after step 3 (when the user-side `PHOTO#` items are gone) still logs them. It holds ids only and expires with the tombstone.
- **The guard is a condition in the write's own transaction**, not a read before it, for every table write of the caller (The repository). The one read before is in `POST /label_photos/{photo_id}/complete`, which writes to S3 before its transaction.
- **A presigned POST issued before the deletion stays valid for up to 10 minutes.** An upload made with it after the deletion lands in `uploads/` with no pending item, is never processed, and expires by the lifecycle rule within 2 days. The account deletion cannot prevent that; it is accepted and noted for the privacy policy (M6).
- **Timing.** Each S3 call has a 2 s deadline and the Cognito call 3 s. A typical user has a few photos; a user with 60 photos needs about 240 S3 calls, 8 at a time, which is a few seconds. The partition step is timed in step 3 above. All within the 10 s timeout; past it the app's retry continues where it stopped.

**IAM the API function needs (infra, M1-T6):** on the photo bucket, `s3:ListBucketVersions` with an `s3:prefix` condition of `labels/*` or `uploads/*` (the list's `Prefix` is always the exact key `labels/<id>.jpg` or `uploads/<id>.jpg`), and `s3:DeleteObject` plus `s3:DeleteObjectVersion` on `labels/*` and `uploads/*` (each delete names a `VersionId`, which S3 authorises as `s3:DeleteObjectVersion`); `s3:PutObject` on the deletion log bucket's `entries/*`; `cognito-idp:AdminDeleteUser` on the stage's pool; and, on the table, `dynamodb:BatchWriteItem` (for step 3; not in `API_TABLE_ACTIONS` of `infra/src/api.ts` as of this task, while the boundary already allows it) besides the actions it has. The tombstone checks need nothing new: `ConditionCheckItem` is granted, and the table ARN covers the `DELETED#` partition. Nothing to read the deletion log.

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
| `PHOTO_BUCKET` | The photo bucket's name (`cupmark-<stage>-photos-<account>`), for the catalogue image copies under `catalogue/` (M1-T4c) and the label photos under `uploads/` and `labels/` (M1-T4d). Must start with `cupmark-` (invariant 9). Missing or another name: hits are cached without an image, `GET /catalogue_images/{image_id}` is 404, and both label photo routes are 500. |
| `DELETION_LOG_BUCKET` | The deletion log bucket (`cupmark-<stage>-deletion-log-<account>`, ADR 0017), checked like `PHOTO_BUCKET` (a `cupmark-` bucket name). Missing or invalid: `DELETE /account` is 500 `DeletionLogNotConfigured` before it changes anything; every other route works. |
| `USER_POOL_ID` | The stage's Cognito user pool id, `^eu-central-1_[A-Za-z0-9]{1,55}$`. Missing or invalid: `DELETE /account` is 500 `UserPoolNotConfigured` before it changes anything; every other route works. `DELETE /account` also needs `PHOTO_BUCKET` (500 `PhotoBucketNotConfigured` without it). |
| `CURSOR_KEY_PARAMETER` | Name of a Parameter Store **SecureString** under `/cupmark/` (for example `/cupmark/<stage>/cursor-key`), holding standard base64 of at least 32 random bytes (for example `openssl rand -base64 32`). Missing, unreadable, not a SecureString or too short: list routes are 500 and no cursor is accepted or issued (fail closed); other routes work. A failed read is retried after 60 s at the earliest. |

**Follow-up for infra (M1-T2, `infra/src/api.ts`):** `OFF_CONTACT` and `OFF_LOOKUP_CAP` are not set by the stack yet, so a deployed lookup answers 503 for every uncached barcode until they are. `PHOTO_BUCKET` is not set yet either (M1-T4c): until it is, no image is copied. The role already has `s3:GetObject` and `s3:PutObject` on `catalogue/*`; without `s3:ListBucket` a missing image reads as `AccessDenied`, which the route also answers as 404. The API function needs outbound HTTPS to `world.openfoodfacts.org` and `images.openfoodfacts.org` (it is not in a VPC, so it has it; no NAT gateway). Its 10 s timeout covers the 3 s lookup, the 2.5 s image download and the 2 s S3 write.

**Label photos (M1-T4d).** The API role needs, on the photo bucket: `s3:PutObject` on `uploads/*` (S3 checks the signer's permission when the app's POST arrives, so this is what makes the presigned POST work), `s3:GetObject` on `uploads/*` and `s3:PutObject` on `labels/*`. Nothing else: no delete, no `s3:ListBucket` (a missing upload then reads as `AccessDenied`, answered 404 like `NoSuchKey`), no `s3:PutObjectTagging` or ACL actions (the POST sets neither). The bucket needs the lifecycle rule that expires `uploads/` after 1 day (ADR 0016). The completion reads up to 8 MiB and writes the stripped copy within the function's 10 s timeout (4 s and 3 s deadlines).

The API role needs `ssm:GetParameter` on exactly that parameter's ARN; the AWS-managed key `alias/aws/ssm` needs no extra grant. The key is read once per cold start and kept in memory only (ADR 0013). Its value is created by a human and never passes through the repo or CI. Tests generate their own key.

## The Apple provider function

`src/handlers/apple-idp.ts` is not part of the API: CloudFormation invokes it only when the stack creates, updates or deletes the custom resource `Custom::CupmarkAppleIdentityProvider` (ADR 0015, infra/README.md). `src/apple-idp/provider.ts` validates the properties (pool in eu-central-1, key parameter `/cupmark/<dev|prod>/apple-sign-in-key`, Apple scopes `name`/`email` only), reads the SecureString with decryption (it must be a SecureString holding a PEM key), and creates or updates the `SignInWithApple` provider; Delete removes it and treats an already missing provider or pool as success. The response is PUT to CloudFormation's presigned HTTPS URL with `NoEcho`. The key is never logged, never in the response, and failure reasons are error class names only. It uses `@aws-sdk/client-cognito-identity-provider` and `@aws-sdk/client-ssm` (Apache-2.0, provided by the Lambda runtime, kept out of the bundle). Tests: `test/apple-idp.test.ts`, with fake clients and a key generated per run.
