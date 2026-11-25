# 0022 Swift API types come from an in-repo generator

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost either way

## Context

The app needs Swift types for the requests and responses of `contracts/openapi.yaml` before the API client (M2-T8) is built. Writing them by hand would define every field and every list a second time, against invariant 2 in CLAUDE.md. Task M2-T7 asks how they are produced. The app uses no third-party packages (ios/README.md), and Swift builds only on macOS, while most work and the `contracts` CI job run on Linux.

## Decision

- An in-repo Node generator, `scripts/generate-ios-api.mjs`, writes `ios/Cupmark/Generated/API.swift` from `contracts/openapi.yaml`, the same way `scripts/generate-ios-vocabulary.mjs` writes `Vocabulary.swift`. It needs no Swift package and runs on Linux. The `contracts` CI job runs it with `--check`, which fails on drift. Its tests are in `scripts/ios-scripts.test.mjs`. The XCTests run in the macOS `ios` job.
- It covers every operation the app calls: all of them except `GET /health`, which only the deploy smoke test calls. Binary and CSV responses (catalogue images, export) and empty ones get no body type, only an `API.Endpoint` entry with their media type.
- `x-vocabulary` enums become the existing `Vocabulary.*` types, and the generator fails if the contract's ids and the bundled vocabulary's ids differ. `dose_dg` stays an integer with a grams helper (ADR 0004). `CalendarDate` is a day without a time zone; timestamps are RFC 3339 with milliseconds. `water_temp_c` and `water_temp_special` are one enum.
- Unknown ids: a vocabulary value is a plain enum, so an id the bundled vocabulary does not know makes that object fail to decode with a `DecodingError`. In a page, each item decodes on its own: a failed item is left out and reported in `undecodableItems`, and the rest of the page still loads. Nothing traps.
- Shapes the generator does not know (`oneOf`, inline objects or enums, an unlisted `not`) make it fail, so a contract change cannot be dropped silently.

## Alternatives

- **Apple's swift-openapi-generator:** it adds Swift packages (the generator plugin, the runtime and a transport) and a package fetch to every build and CI run, against "no third-party packages". It also runs only where Swift runs, so the drift check could not stay in the Linux `contracts` job, and it does not know the `x-vocabulary` tags, so it would generate a second copy of every list.
- **Hand-written Codable types:** no tooling, but every contract change needs a matching hand edit, and nothing catches drift.

## Consequences

- A contract change needs `node scripts/generate-ios-api.mjs` and a commit of the result; CI fails until then.
- A new schema shape needs a change to the generator first.
- The generated Swift is compiled and tested only on a Mac or in the `ios` CI job.
