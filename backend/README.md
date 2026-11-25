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

`src/handlers/api.ts` is the one API function (docs/05, Components). `src/api/router.ts` holds a fixed route table and serves only the routes that have landed: list, create, get, replace and delete for `/shelf`, `/brews` and `/recipes` (task M1-T5), which share one implementation (`src/api/resources.ts`), and the bean catalogue: `GET /barcodes/{barcode}`, `POST /beans` and `GET /beans/{bean_id}` (task M1-T4a, `src/api/catalogue.ts`).

For every request, in this order:

1. **Route.** Method and `rawPath` against the table. No match is 404 with no body. That includes contract routes whose tasks have not landed yet (the Open Food Facts lookup, catalogue images, profile, export, account): the contract declares no 501, so they are 404 until their task adds them to the table. `/health` is its own Lambda (ADR 0007). A method a path does not declare is 404 too (the contract has no 405). Matching uses `rawPath`, so the HTTP API must use the `$default` stage.
2. **Caller.** `userIdFromEvent`; none is 401.
3. **Input**, 400 on any failure: path ids against the contract's `Id` pattern, a `{barcode}` against `Barcode` and its GS1 check digit; the query (only `cursor` and `limit`, each at most once, and only on lists; `limit` is checked against `LimitQuery` by hand because parameters are not generated, and a test compares the two); the body (below).
4. **Operation.** Repository errors map to 404 (not in the caller's partition; a missing shelf entry; a missing bean, or a rejected one named newly by a shelf entry write, M1-T11), 409 (`DELETE /shelf/{id}` while brews reference it, ADR 0012; `PUT /shelf/{id}` that would change `bean_id` while brews reference it, D14; `POST /beans` for a barcode that already points to a bean, `BarcodeTakenError`, or with `open_food_facts_confirmed`, `OpenFoodFactsHitMissingError`) and 500 (including `CorruptItemError`). A write that raced another write (a changed condition, or a transaction cancelled with `TransactionConflict` by a concurrent one on the same shelf entry) is tried up to three times in all, with 10 to 100 ms of random wait.

Every error has no body, so no error echoes input. One log line per request: `operation`, `status`, `request_id` and, on failure, the error class name. Never a body, header, query, path parameter (barcode or id), token or user id.

### Bean catalogue (M1-T4a)

The catalogue is shared: the caller only has to be signed in, and the user id is not used by these routes (nor stored on a bean, see The repository).

| Route | Answers |
| --- | --- |
| `GET /barcodes/{barcode}` | 200 with the `Bean` the canonical EAN-13 points to (UPC-A `036000291452` and EAN-13 `0036000291452` are one product). 404, no body, for an unknown barcode or one whose bean was rejected: the app then asks `GET /barcodes/{barcode}/open_food_facts` (M1-T4b). 400 for anything but 12 or 13 digits with a correct check digit, before the table is read. 400 for a query or a body. |
| `POST /beans` | 201 with the new unverified `Bean`: `verified: false`, every value of `attributes` in `picked_attributes` (source "user"), `operator_attributes` `{}`, `open_food_facts_match: false`, no `open_food_facts` group, `barcode` in its 13-digit form. The body is `BeanCreate` (unknown properties rejected) checked against the `vocabulary_version` it sends, so `origin`, `species` and `variety` need version 2; a barcode in the body must have a correct check digit. Bad body or a query: 400. Barcode already taken (either form): 409 (`BarcodeTakenError`), not retried. A raced write (`WriteConflictError`) is retried like the other writes. |
| `GET /beans/{bean_id}` | 200 with the `Bean`, verified or unverified. 404 for an unknown or a **rejected** bean. 400 for a bad id, a query or a body. |

Decisions (task M1-T4a):

- **A rejected bean is 404**, by id and by barcode, as if it did not exist. Rejecting deletes its barcode pointer (The repository), so a barcode lookup finds nothing and a scan can submit a fresh entry; a read that races the reject still sees the rejected status and answers 404. The `META` item stays for the operator.
- **An unverified bean is returned to every signed-in user**: the catalogue is shared, and F1 and ADR 0005 show entries right away while they wait for the operator.
- **`open_food_facts_confirmed: true` is 409** for now, before the table is touched: the server has no Open Food Facts cache until M1-T4b, so there is never a cached hit to copy, which is the contract's 409 case. `false` is the same as leaving it out. M1-T4b replaces this with a cache read.
- **A pointer to a missing bean is 500** (`CorruptItemError`), not 404: a 404 would send the app to the Open Food Facts lookup and then into a 409 it cannot get out of.

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
| `CURSOR_KEY_PARAMETER` | Name of a Parameter Store **SecureString** under `/cupmark/` (for example `/cupmark/<stage>/cursor-key`), holding standard base64 of at least 32 random bytes (for example `openssl rand -base64 32`). Missing, unreadable, not a SecureString or too short: list routes are 500 and no cursor is accepted or issued (fail closed); other routes work. A failed read is retried after 60 s at the earliest. |

The API role needs `ssm:GetParameter` on exactly that parameter's ARN; the AWS-managed key `alias/aws/ssm` needs no extra grant. The key is read once per cold start and kept in memory only (ADR 0013). Its value is created by a human and never passes through the repo or CI. Tests generate their own key.

## The Apple provider function

`src/handlers/apple-idp.ts` is not part of the API: CloudFormation invokes it only when the stack creates, updates or deletes the custom resource `Custom::CupmarkAppleIdentityProvider` (ADR 0015, infra/README.md). `src/apple-idp/provider.ts` validates the properties (pool in eu-central-1, key parameter `/cupmark/<dev|prod>/apple-sign-in-key`, Apple scopes `name`/`email` only), reads the SecureString with decryption (it must be a SecureString holding a PEM key), and creates or updates the `SignInWithApple` provider; Delete removes it and treats an already missing provider or pool as success. The response is PUT to CloudFormation's presigned HTTPS URL with `NoEcho`. The key is never logged, never in the response, and failure reasons are error class names only. It uses `@aws-sdk/client-cognito-identity-provider` and `@aws-sdk/client-ssm` (Apache-2.0, provided by the Lambda runtime, kept out of the bundle). Tests: `test/apple-idp.test.ts`, with fake clients and a key generated per run.
