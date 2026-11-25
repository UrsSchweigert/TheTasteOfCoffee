# Cupmark iOS app

SwiftUI app, iOS 17 or later, no third-party packages. Builds only on macOS with Xcode 16 or later.

## Layout

```
Cupmark.xcodeproj/        hand-written project (see "Project file")
Cupmark/                  app target sources and resources
  Generated/Vocabulary.swift   generated from contracts/vocabulary, never edit
  Generated/API.swift          generated from contracts/openapi.yaml, never edit
  Vocabulary/             VocabularyStore (runtime loader) and helpers
  L10n.swift              keys of the String Catalog
  Localizable.xcstrings   String Catalog, English (source) and German
CupmarkTests/             XCTest unit tests (hosted in the app)
```

## Vocabulary

- The app bundles `contracts/vocabulary/v<N>/` and `contracts/i18n/` through two Xcode folder references (bundle paths `v<N>/` and `i18n/`). Nothing is copied into `ios/`.
- `Generated/Vocabulary.swift` holds one enum per list (raw value = contract id), the ranges, the constants and the label languages. Regenerate it after a vocabulary change:

  ```
  (cd contracts && npm ci)
  node scripts/generate-ios-vocabulary.mjs
  ```

  `node scripts/generate-ios-vocabulary.mjs --check` fails if the file is out of date or if the project bundles a different version. CI runs it on Linux.
- When a new vocabulary version is published, the check fails until the folder reference in `project.pbxproj` points at the new `v<N>` directory and the Swift file is regenerated.
- Raw values are always the contract ids. Case names are the ids in lowerCamelCase, with one exception: an id that would read as `Optional.none` or `Optional.some` is named after its list, so `none` in `milk_types` is `Vocabulary.MilkType.noMilk` (raw value `"none"`). `.none` on an optional vocabulary value therefore always means nil.
- A region in `origins` names its country (ADR 0011). The generator emits that as a typed property, `Vocabulary.Origin.country: Vocabulary.Origin?` (`.sumatra.country == .indonesia`, nil for a country), not as a string. Lists with the same id in different namespaces, such as `java` in `origins` and `varieties`, are separate enums (`Vocabulary.Origin.java`, `Vocabulary.Variety.java`).
- `VocabularyStore.load(from:)` decodes the bundled JSON at runtime and resolves labels with `label(namespace:id:language:)`. Errors are thrown, never trapped.

## API types

`Generated/API.swift` holds the request and response types of `contracts/openapi.yaml`, written by `scripts/generate-ios-api.mjs` (ADR 0022). It needs no Swift package and runs on Linux. Regenerate it after a contract change:

```
(cd contracts && npm ci)
node scripts/generate-ios-api.mjs
```

`node scripts/generate-ios-api.mjs --check` fails if the file is out of date; CI runs it in the `contracts` job.

- Every operation the app calls is covered: beans, barcodes, Open Food Facts, catalogue images, label photos, shelf, brews, recipes, profile, export and account. `API.Endpoint` lists them with method, path, success status, request and response schema, and media type (`image/jpeg` for catalogue images, `text/csv` for the export). Only `GET /health` is left out (`EXCLUDED_OPERATIONS`), because only the deploy smoke test calls it.
- Each object schema is a `Codable`, `Hashable`, `Sendable` struct in `enum API` (`API.Brew`, `API.BrewInput`, ...), conforming to `APIObject`. It has explicit snake_case `CodingKeys` and nothing else, and it never encodes null. `API.Schemas` lists every schema's properties, which the tests use to check encoded JSON.
- Vocabulary values use the generated `Vocabulary.*` enums and `VocabularyLanguage`, so no list exists twice. The generator fails if an `x-vocabulary` enum and the bundled vocabulary disagree.
- `dose_dg` is an integer (`API.DoseDg`, ADR 0004). `doseGrams` reads and sets it in grams, rounding to 0.1 g, and never traps.
- `API.CalendarDate` is a day (`YYYY-MM-DD`) without a time zone. `API.Timestamp` is RFC 3339, sent in UTC with milliseconds (`2026-11-25T08:30:00.123Z`), and held as whole milliseconds, so it survives a JSON round trip exactly.
- `water_temp_c` and `water_temp_special` are one optional `API.WaterTemperature` (`.celsius(94)` or `.special(...)`), so both can never be set. A response with both fails to decode.
- In a page (`ShelfEntryPage`, `BrewPage`, `RecipePage`), each item decodes on its own. An item that fails, for example because it holds an id the bundled vocabulary does not know, is left out of `items` and listed in `undecodableItems`. A single resource that fails throws a `DecodingError`. Nothing traps.

## Strings

- Every UI string is a key in `L10n.swift` with English and German in `Localizable.xcstrings`. Vocabulary labels come from `contracts/i18n` and are shown with `Text(verbatim:)`.
- Every catalog entry has `"extractionState" : "manual"`: the catalog is maintained by hand together with `L10n.swift`, and `manual` tells Xcode not to mark an entry stale when its extraction does not find the key in code. Add it to every new entry.
- `node scripts/check-ios-strings.mjs` checks the catalog on Linux: both languages present and translated, `extractionState` manual, no unused or missing key. It also fails on shown text that bypasses `L10n` in any Swift file under `ios/` (comments ignored):
  - a string literal as the first argument of `Text`, `Label`, `Button`, `navigationTitle`, an accessibility modifier or the other calls in `UI_CALLS`, also when the literal is on a later line than the call;
  - any string literal inside `Text(verbatim: ...)`, including a fallback such as `?? "n/a"`;
  - a name bound to a string literal in the same file (`let title = "Hi"`) passed as the first argument of one of those calls.
  Literals that are not shown text, such as `Image(systemName:)` or `systemImage:`, are allowed.
- `scripts/check-no-free-text.sh` fails on any control that accepts typed text.

## Project file

`Cupmark.xcodeproj` is written by hand, using Xcode 16 synchronized folders (`PBXFileSystemSynchronizedRootGroup`, object version 77): every file under `Cupmark/` and `CupmarkTests/` belongs to its target without a per-file entry. Adding a Swift file needs no project change, so it can be done without a Mac. XcodeGen was not used because CI would have to download an unpinned or separately verified binary.

Signing: bundle id `app.cupmark.Cupmark`, automatic signing, no team id. Simulator and CI builds pass `CODE_SIGNING_ALLOWED=NO`. A device build needs the developer's own team, set locally and not committed.

## Build and test

```
cd ios
xcodebuild test -project Cupmark.xcodeproj -scheme Cupmark \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

CI runs the same on `macos-15` with Xcode 16.4 (job `ios` in `.github/workflows/ci.yml`). On a pull request the job runs only when the `changes` job finds a changed path under `ios/`, `contracts/vocabulary/`, `contracts/i18n/`, or a change to `contracts/openapi.yaml`, `contracts/lib/vocabulary.mjs`, `contracts/lib/lock.mjs`, `contracts/lib/openapi.mjs`, `scripts/generate-ios-vocabulary.mjs`, `scripts/generate-ios-api.mjs`, `scripts/check-ios-strings.mjs` or `ci.yml`: the app and every input the iOS generators read. `scripts/check-workflows.test.mjs` derives those inputs from the generator scripts and fails if `IOS_PATHS` in `ci.yml` lacks one. Pushes to `main` always run it, and so does any run where the diff cannot be computed. `ci-ok` accepts a skipped `ios` only when `changes` said `ios=false`.
