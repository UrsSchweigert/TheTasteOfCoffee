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
| `npm test` | Vitest. Includes the same no-drift check as `check:generated`. |
| `npm run build` | Bundle each file in `src/handlers/` into `dist/<name>/index.mjs` (minified, with source map). `dist/` is not committed. |

## Layout

```
src/handlers/          one file per Lambda entry point (each exports `handler`)
src/auth/user-id.ts    the caller's user id, from the token subject only
src/contract/          runtime checks used by the generated schemas (dates, uniqueness)
src/generated/         generated from contracts/; never edit by hand
scripts/codegen/       the OpenAPI-to-zod generator
scripts/               generate, check and build entry points
test/                  Vitest tests
```

## The generated contract

`src/generated/contract.ts` holds a zod schema (`<Name>Schema`) and an inferred type (`<Name>`) for every schema in `components.schemas` of `contracts/openapi.yaml`, plus `componentSchemas` keyed by name. Validate every request body with it.

The generator (`scripts/codegen/zod-from-openapi.ts`) is hand-written for the subset of JSON Schema the contract lint allows. It translates each keyword exactly and throws on anything it does not know, so a constraint can never be dropped silently. Notes:

- Objects are `z.strictObject`: unknown properties are rejected.
- `multipleOf` must be a multiple of 2^-20 (exact in binary, the same rule as the contract lint), and values are checked with `%`, which is exact on doubles. zod's own `multipleOf` allows a small relative tolerance, which the contract does not.
- `format: date` and `format: date-time` are never more lenient than the contract's own checker (`compileComponentSchemas` in `contracts/lib/openapi.mjs`): upper-case `T` and `Z` only, 1 to 9 fraction digits, offset as `+hh:mm`, and no leap second (second 60). The backend is stricter in one way: the day must exist (no 2026-02-29 or 2026-04-31), which the contract's regular expressions do not check.
- `test/differential.test.ts` runs every generated schema next to ajv, set up as `contracts/` sets it up, on the fixtures and thousands of one-step mutations of them, and fails on any disagreement. A test there fails if the contract's date expressions change without the copy in the test.

When `contracts/openapi.yaml` changes, run `npm run generate` and commit the new file in the same pull request. `npm test` and `npm run check:generated` fail until you do.
