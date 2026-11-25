# Backend

The Lambda code of Cupmark: TypeScript (strict, ESM), Node 22, bundled with esbuild for the `nodejs22.x` runtime on arm64. Design: `docs/05-system-design.md`. The API it implements: `contracts/openapi.yaml`.

## Commands

Run in `backend/` with Node `^22.18.0` or 24 and later; `.npmrc` sets `engine-strict` so `npm ci` refuses older versions (the scripts in `scripts/` are TypeScript run directly by Node's type stripping).

| Command | What it does |
| --- | --- |
| `npm ci` | Install exactly what `package-lock.json` pins. |
| `npm run generate` | Regenerate `src/generated/contract.ts` from `contracts/openapi.yaml`. Commit the result. |
| `npm run check:generated` | Regenerate into a temporary directory and fail if the committed file differs. |
| `npm run lint` | ESLint (typescript-eslint, strict type-checked, `any` banned) and `tsc --noEmit`. |
| `npm test` | Vitest, unit tests only (no Docker needed). Includes the same no-drift check as `check:generated`. |
| `npm run dynamodb:start` / `dynamodb:stop` | Start or stop DynamoDB Local in Docker on `127.0.0.1:8000` (`amazon/dynamodb-local:3.3.2`, pinned by digest, in memory). |
| `npm run test:integration` | The repository against DynamoDB Local (`test/integration/`). Skips with a message if it is not reachable; with `REQUIRE_DYNAMODB_LOCAL=1` (CI) it fails instead. `DYNAMODB_ENDPOINT` overrides the endpoint, which must be a local `http://` address. |
| `npm run build` | Bundle each file in `src/handlers/` into `dist/<name>/index.mjs` (minified, with source map). `dist/` is not committed. |

## Layout

```
src/handlers/          one file per Lambda entry point (each exports `handler`)
src/auth/user-id.ts    the caller's user id (`UserId`), from the token subject only
src/repository/        the only module that talks to DynamoDB: key builders, typed reads and writes
src/ids/ulid.ts        server-generated ids (ULIDs)
src/contract/          runtime checks used by the generated schemas (dates, uniqueness)
src/generated/         generated from contracts/; never edit by hand
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
- Values are parsed with the generated contract schemas on write and on read.
- An unverified bean carries `gsi1pk=REVIEW#UNVERIFIED` and `gsi1sk=<createdAt UTC>#<beanId>`; verifying or rejecting it removes both in the same write.
- `table.ts` holds the table's keys, index and stream with no imports. The integration tests create their table from it, and `infra/test/table-schema.test.ts` checks the synthesised CDK table against it.

`npm test` stays unit-only so it runs anywhere in seconds; the DynamoDB Local suite is a separate command because it needs Docker. CI runs both, with DynamoDB Local as a service container.
