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
src/handlers/          one file per Lambda entry point (each exports `handler`): api, health
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
- References are kept in the same transaction as the write (ADR 0012): a shelf entry needs its bean (`BeanNotFoundError`), a brew needs a shelf entry in the caller's partition (`ShelfEntryNotFoundError`), and each shelf entry counts its brews in `brewCount`, so deleting one that brews reference fails with `ShelfEntryInUseError`. Brew items also carry `shelfEntryId` and `beanId` for the aggregator.
- Values are parsed with the generated contract schemas on write and on read.
- An unverified bean carries `gsi1pk=REVIEW#UNVERIFIED` and `gsi1sk=<createdAt UTC>#<beanId>`; verifying or rejecting it removes both in the same write.
- `table.ts` holds the table's keys, index and stream with no imports. The integration tests create their table from it, and `infra/test/table-schema.test.ts` checks the synthesised CDK table against it.

`npm test` stays unit-only so it runs anywhere in seconds; the DynamoDB Local suite is a separate command because it needs Docker. CI runs both, with DynamoDB Local as a service container.

## The API Lambda

`src/handlers/api.ts` is the one API function (docs/05, Components). `src/api/router.ts` holds a fixed route table and serves only the routes that have landed: list, create, get, replace and delete for `/shelf`, `/brews` and `/recipes` (task M1-T5). The three resources share one implementation (`src/api/resources.ts`).

For every request, in this order:

1. **Route.** Method and `rawPath` against the table. No match is 404 with no body. That includes contract routes whose tasks have not landed yet (barcodes, beans, profile, export, account): the contract declares no 501, so they are 404 until their task adds them to the table. `/health` is its own Lambda (ADR 0007). A method a path does not declare is 404 too (the contract has no 405). Matching uses `rawPath`, so the HTTP API must use the `$default` stage.
2. **Caller.** `userIdFromEvent`; none is 401.
3. **Input**, 400 on any failure: path ids against the contract's `Id` pattern; the query (only `cursor` and `limit`, each at most once, and only on lists; `limit` is checked against `LimitQuery` by hand because parameters are not generated, and a test compares the two); the body (below).
4. **Operation.** Repository errors map to 404 (not in the caller's partition; a missing bean or shelf entry), 409 (`DELETE /shelf/{id}` while brews reference it, ADR 0012) and 500. A write that raced another write (a changed condition, or a transaction cancelled with `TransactionConflict` by a concurrent one on the same shelf entry) is tried up to three times in all, with 10 to 100 ms of random wait.

Every error has no body. One log line per request: `operation`, `status`, `request_id` and, on failure, the error class name. Never a body, header, query, token or user id.

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

