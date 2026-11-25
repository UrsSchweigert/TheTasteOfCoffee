# Cupmark iOS app

SwiftUI app, iOS 17 or later, no third-party packages. Builds only on macOS with Xcode 16 or later.

## Layout

```
Cupmark.xcodeproj/        hand-written project (see "Project file")
Config/                   stage configuration: Dev.xcconfig, Prod.xcconfig, Info.plist
Cupmark/                  app target sources and resources
  Generated/Vocabulary.swift   generated from contracts/vocabulary, never edit
  Generated/API.swift          generated from contracts/openapi.yaml, never edit
  Networking/             APIClient, TokenProvider, APIError, CatalogueImageCache
  Vocabulary/             VocabularyStore (runtime loader) and helpers
  Configuration/          StageConfig and the "not configured" screen
  Auth/                   sign-in (M2-T11): AuthModel, AuthSession, PKCE, Keychain, sign-in screen
  Store/                  SwiftData local store, one per account (M2-T15)
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
- From vocabulary v3 on (M2-T3, ADR 0021), two more shapes are generated, and only when the bundled version has them, so the v2 output is unchanged. A grinder's own dial (`ENTRY_RANGES` in `contracts/lib/vocabulary.mjs`) becomes `Vocabulary.Grinder.scale: VocabularyRange?`, nil for a grinder without a scale. The method field rules (`brew.json`, `field_rules`) become a typed table: `Vocabulary.BrewField` (every BrewParameters field of `contracts/openapi.yaml` but `method`, raw value = API property; `scaledBy` names the field whose picked entry's scale a value lies on, `grind_setting` on `grinder`), `Vocabulary.Method.fieldRules`, `allows(_:)` and `allowedFields`. A field without a rule is allowed with every method. The rules are never constants, and generation fails on a rule that names an unknown method or field, or a scale off its step. The app reads scales and rules through these types only; `VocabularyStore.entryRanges` keeps the bundled entry ranges by `<namespace>.<id>.<attribute>` for checks, never in `ranges` and never by index.
- `VocabularyStore.load(from:)` decodes the bundled JSON at runtime and resolves labels with `label(namespace:id:language:)`. Errors are thrown, never trapped.

## API types

`Generated/API.swift` holds the request and response types of `contracts/openapi.yaml`, written by `scripts/generate-ios-api.mjs` (ADR 0022). It needs no Swift package and runs on Linux. Regenerate it after a contract change:

```
(cd contracts && npm ci)
node scripts/generate-ios-api.mjs
```

`node scripts/generate-ios-api.mjs --check` fails if the file is out of date; CI runs it in the `contracts` job. `--file=<path>` checks or writes another file; the script tests use it.

- Every operation the app calls is covered: beans, barcodes, Open Food Facts, catalogue images, label photos, shelf, brews, recipes, profile, export and account. `API.Endpoint` lists them with method, path, success status, request and response schema, and media type (`image/jpeg` for catalogue images, `text/csv` for the export), and the error statuses the contract lists (`documentedErrorStatuses`). Only `GET /health` is left out (`EXCLUDED_OPERATIONS`), because only the deploy smoke test calls it.
- Each object schema is a `Codable`, `Hashable`, `Sendable` struct in `enum API` (`API.Brew`, `API.BrewInput`, ...), conforming to `APIObject`. It has explicit snake_case `CodingKeys` and nothing else, and it never encodes null. `API.Schemas` lists every schema's properties, which the tests use to check encoded JSON.
- Vocabulary values use the generated `Vocabulary.*` enums and `VocabularyLanguage`, so no list exists twice. The generator fails if an `x-vocabulary` enum and the bundled vocabulary disagree.
- `dose_dg` is an integer (`API.DoseDg`, ADR 0004). `doseGrams` reads and sets it in grams, rounding to 0.1 g, and never traps.
- `API.CalendarDate` is a day (`YYYY-MM-DD`) without a time zone. `API.Timestamp` is RFC 3339, sent in UTC with milliseconds (`2026-11-25T08:30:00.123Z`), and held as whole milliseconds, so it survives a JSON round trip exactly.
- `water_temp_c` and `water_temp_special` are one optional `API.WaterTemperature` (`.celsius(94)` or `.special(...)`), so both can never be set. A response with both fails to decode.
- In a page (`ShelfEntryPage`, `BrewPage`, `RecipePage`), each item decodes on its own. An item that fails, for example because it holds an id the bundled vocabulary does not know, is left out of `items` and listed in `undecodableItems`. A single resource that fails throws a `DecodingError`. Nothing traps.

## API client

`Networking/APIClient.swift` (M2-T8) calls the API with `URLSession` and async/await, one method per operation of `API.Endpoint`. It needs no package.

- The base URL is injected (M2-T9). The default session is ephemeral, with no URL cache and no cookies.
- Method, path, success status and `Accept` come from `API.Endpoint`. Path parameters are `ResourceID` (a ULID, checked against the contract's `Id` pattern) or `LookupBarcode` (12 or 13 digits) only, so no path is built from other text. `cursor` and `limit` are checked too.
- Every request carries `Authorization: Bearer <token>` from a `TokenProvider` (`currentAccessToken()`, `refresh()`; `AuthSession` implements it, see Sign-in). No path, query or body names a user (invariant 3). On a 401 the client calls `refresh()` once and sends the request once more; a second 401, a failed refresh or no token is `APIError.unauthorized`, except a refresh that failed in transport, which stays `APIError.transport` (M2-T11).
- Any status other than the route's success status throws `APIError`: `badRequest`, `unauthorized`, `notFound`, `conflict`, `tooManyRequests`, `serviceUnavailable`, `server(status:)`, `unexpectedStatus` (also a 2xx other than the documented one), plus `transport(URLError.Code)`, `undecodable` and `invalidResponse`. Error bodies are not read. The client logs nothing, so no body, token or Open Food Facts text reaches a log (docs/05, Security).
- `allShelfEntries()`, `allBrews()` and `allRecipes()` follow `next_cursor` with `limit=100` until it is absent. Items that do not decode are collected in `undecodableItems`. A repeated or malformed cursor, or more than 1,000 pages (`APIClient.maxPages`), stops with `invalidResponse`.
- Cancelling the calling task throws `CancellationError`, never `transport(.cancelled)`, and nothing is refreshed or retried after it.
- `catalogueImage(_:)` loads `GET /catalogue_images/{image_id}` with the token (never `AsyncImage`), checks that the body is a JPEG and caches it in `Library/Caches/CatalogueImages/<image_id>.jpg` (`CatalogueImageCache`). An image never changes under its id, so a cached one is never fetched again. The cache is bounded at 50 MiB and drops the least recently used files first.
- Label photo bytes are not sent by this client: the presigned S3 POST of `createLabelPhotoUpload` is M2-T24.
- Tests (`APIClientTests`) use a `URLProtocol` stub (`CupmarkTests/Support/StubURLProtocol.swift`), one fake host per server.

## Stage configuration

`Configuration/StageConfig.swift` (M2-T9) holds the endpoints of the backend stage the app was built for. They are not secrets: the Cognito app client is public and has no secret (infra/src/identity.ts).

- `Config/Dev.xcconfig` and `Config/Prod.xcconfig` set `CUPMARK_STAGE`, `CUPMARK_HOSTED_DOMAIN` (`https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com`), `CUPMARK_APP_CLIENT_ID` (stack output `IdentityAppClientId...`), `CUPMARK_API_URL` (stack output `ApiUrl`), `CUPMARK_REDIRECT_URL` (`cupmark://auth`) and `CUPMARK_SIGN_OUT_URL` (`cupmark://signout`). `//` starts a comment in an xcconfig, so URLs are written `https:/$()/...`; `$()` expands to nothing.
- `Config/Info.plist` maps them to the keys `CupmarkStage`, `CupmarkHostedDomain`, `CupmarkAppClientID`, `CupmarkAPIURL`, `CupmarkRedirectURL` and `CupmarkSignOutURL`. Xcode merges it with the generated Info.plist (`GENERATE_INFOPLIST_FILE` stays on, `INFOPLIST_FILE = Config/Info.plist`). It sits outside the synchronized `Cupmark/` folder, so it is not also copied as a resource.
- Debug and Release of the app target both use `Dev.xcconfig` until prod is deployed in M6 (ADR 0023). `Prod.xcconfig` is not referenced yet.
- `StageConfig(info:)` checks every key and throws `StageConfigError.missing`, `.malformed` or `.wrongRegion` with the key, never the value. The hosted domain must be exactly `cupmark-<stage>` in eu-central-1; the API URL must be `https://<10-character api id>.execute-api.eu-central-1.amazonaws.com` with no path; the app client id letters and digits; the two callback URLs exactly the registered ones. Any region but eu-central-1 is `wrongRegion` (invariant 6). Nothing traps.
- `StageConfigLoadState.load(from: .main)` runs at launch. `.notConfigured` shows `NotConfiguredView`, and the app calls no backend. `apiBaseURL` is what `APIClient(baseURL:)` gets.
- Until M2-T10 the dev app client id and API URL are `PLACEHOLDER-SET-IN-M2-T10`, and prod's are `PLACEHOLDER-SET-IN-M6`. Uppercase letters and hyphens are invalid in both ids, so the built app shows "not configured" instead of calling a wrong host. M2-T10 puts the owner's dev outputs in `Dev.xcconfig` and changes `testTheBuiltAppIsNotConfiguredUntilM2T10` to expect `.configured`.
- Tests: `StageConfigTests` (valid, missing, malformed and wrong-region values, and the keys in the built app). `scripts/ios-scripts.test.mjs` checks on Linux that both xcconfigs, `Info.plist`, `identity.ts` and the project agree.

## Barcode scanner

`Scanner/` (M2-T13) implements F1 step 1. It never offers a way to type a barcode (invariant 1).

- `CanonicalBarcode` is pure Swift and matches the backend's `canonicalBarcode` (backend/src/repository/keys.ts) exactly: 13 ASCII digits are kept, 12 get a leading 0 (UPC-A to EAN-13), and the GS1 check digit (weights 1, 3 from the left) must be right. Anything else, including whitespace and non-ASCII digits, is ignored, so no request is made for it. `lookupBarcode` gives the `LookupBarcode` path value for M2-T14.
- `BarcodeScanSession` lets the first valid code through once; every later report, duplicate or not, is ignored.
- `ScannerViewModel` checks a `ScannerEnvironment`, then reads a `BarcodeSource` (an `AsyncStream` of payloads), stops the source at the first valid code and calls `onScanned` once. Tests use `FakeBarcodeSource` and `FakeScannerEnvironment`, without VisionKit.
- `DataScannerView` wraps VisionKit's `DataScannerViewController` with `recognizedDataTypes: [.barcode(symbologies: [.ean13])]`. VisionKit has no UPC-A symbology: a UPC-A code is an EAN-13 with a leading 0 and is reported under `.ean13` as 13 digits. EAN-8 and UPC-E are not read (the contract's `Barcode` is 12 or 13 digits). `LiveScannerEnvironment` uses `DataScannerViewController.isSupported` (false on the simulator) and `isAvailable`, and asks for camera access once if it was never asked.
- When scanning is unsupported, denied or not available, `ScannerScreen` offers the pick-list entry (`onPickListEntry`, connected in M2-T22) and a Settings link (`UIApplication.openSettingsURLString`). `onScanned` is connected to the lookup in M2-T14; until then the root screen's "Scan a bag" row passes placeholders.
- The camera permission prompt is `INFOPLIST_KEY_NSCameraUsageDescription` in the app target's build settings, localised in `Cupmark/InfoPlist.xcstrings` (en, de).
- Only a device can run the camera: unit tests cover the logic, the real scan is checked in M2-T34.

## Local store

`Store/` (M2-T15) is the SwiftData copy of the user's own data (docs/04, Offline). It is not wired into the app yet; M2-T16 to M2-T18 add the outbox, the pull and the screens.

- One store per account (ADR 0020). `StoreAccount` gives the store a stable id, the id token's `sub`. Sign-in adapts its account value with `extension AccountID: StoreAccount { var stableID: String { rawValue } }`. The file is `Library/Application Support/Accounts/<sha-256 hex of the id>.store`, so the raw `sub` is never in a path. An empty id throws. `AccountStore.open(for:)` opens only that file, with CloudKit off; `AccountStore.inMemory()` is a new empty store for tests and previews.
- `CupmarkSchemaV1` (`VersionedSchema` 1.0.0) holds `StoredBean`, `StoredShelfEntry`, `StoredBrew`, `StoredRecipe` and `StoredProfile`; `CupmarkMigrationPlan` has no stages yet. A new version adds `CupmarkSchemaV<N>`, a stage, and moves the `Stored...` type aliases.
- Every model has `localID` (the only `@Attribute(.unique)`), `serverID` (nil until the server has it; the profile has none, the API gives it no id), `vocabularyVersion` and `syncStateRaw`, a `SyncState` raw value (`synced`, `pending_create`, `pending_update`, `pending_delete`). Bean to shelf entry to brew are relationships with inverses.
- Vocabulary values are stored as contract ids (`methodID`, `bagSizeID`, ...) and read through the `Vocabulary` enums: an unknown id reads as nil and is kept. A rating is one JSON blob of ids (`RatingValues`: score by criterion id, level by dimension id, note ids), so no criterion or note list is written in Swift. Converting to an API type (`apiInput()`, `apiParameters()`, `apiRating()`) throws `LocalStoreError.unknownVocabularyID` instead of sending an unknown id, and `missingServerID` while a referenced item has no server id. `apply(_:)` and the `init(_:)` from an API type take server values.
- Writes save at once. A local edit of a synced item makes it `pendingUpdate`; deleting an item the server never had removes it, any other becomes `pendingDelete` and is hidden. A shelf entry with brews cannot be deleted (ADR 0012). Lists: `brewsNewestFirst()` (by `brewed_at`, kept in whole milliseconds), `shelfEntries()` (latest purchase first), `recipes()`.
- `BrewDerivedValues` is the one place for derived values: ratio `water_g / (dose_dg / 10)` (ADR 0004), and days since roast from `roast_date` to the day `brewed_at` falls on in the device calendar's time zone, counted on calendar days, so a daylight saving or time zone change never shifts it by one.
- Tests: `AccountStoreTests`, `StoredValuesTests`, `StoreLocationTests` (including two accounts on disk) and `BrewDerivedValuesTests`, with fixtures in `CupmarkTests/Support/StoreFixtures.swift`.

## Sign-in

`Auth/` (M2-T11, ADR 0024) signs in through the Cognito hosted UI with Sign in with Apple as the only provider. It needs no package, no Sign in with Apple entitlement and no registered URL scheme.

- `SignInView` has one control, `AppleSignInButton`: drawn to Apple's guidelines, not `AuthenticationServices.SignInWithAppleButton`, which always starts the native request (it needs the entitlement and returns a token the hosted UI cannot take). The app asks for no name and no email.
- The button opens `ASWebAuthenticationSession` (`SystemWebAuthenticator`, ephemeral, callback scheme `cupmark`) on `/oauth2/authorize` with `response_type=code`, `client_id`, `redirect_uri=cupmark://auth`, `identity_provider=SignInWithApple`, `scope=openid`, a random `state` and an S256 `code_challenge` (`PKCE`: 32 `SecRandomCopyBytes` bytes, CryptoKit SHA-256, base64url). `AuthorizationRequest.code(fromCallback:redirectURL:)` rejects another URL, a missing, repeated or different `state`, an OAuth `error` and a missing code. Closing the sheet is `AuthError.cancelled`, which shows no error.
- `CognitoTokenEndpoint` posts `application/x-www-form-urlencoded` to `/oauth2/token` (code with `code_verifier`; refresh token) and `/oauth2/revoke`, with `client_id` and no client secret. Only an error body's `error` code is read (`invalid_grant`). A network failure is `APIError.transport`.
- `AuthSession` is an actor and the app's `TokenProvider`. The refresh token and the `AccountID` are one Keychain item (`KeychainCredentialStore`: generic password, service `app.cupmark.Cupmark.auth.<stage>`, account `refresh-token`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). The access token is kept in memory only; the id token is read for its `sub` and dropped. A token is refreshed 120 s before it expires (or at half its lifetime, if shorter) and on a 401 (`refresh()`); concurrent callers share one refresh task, and a caller that asks during a refresh waits for it. `invalid_grant` ends the session (`AuthStatus.sessionExpired`); a transport failure keeps it, so the app works offline, and `APIClient` passes `transport` through instead of `unauthorized`.
- Sign-out clears memory and the Keychain, then revokes the refresh token; a failed revoke still leaves the device signed out.
- `AuthModel` (`@Observable`, main actor) holds the phase (`restoring`, `signedOut`, `signingIn`, `signedIn(AccountID)`) and the note to show. `CupmarkApp` builds it with `AuthModel.live(config:)` when the stage is configured and puts it in the environment; `AuthGate` in `RootView` shows the sign-in screen or the signed-in content and, for now, a sign-out toolbar button.
- **`AccountID` (for M2-T15).** The local store key: the lowercase hex SHA-256 of the id token's `sub`, 64 characters, file-name safe. Read it from `AuthModel.accountID` or from the closure argument of `AuthGate`. It is available offline at launch (saved in the Keychain). It is never sent: the backend takes the user from the access token (invariant 3). The id token's signature is not checked, because the value only picks a local store (ADR 0024).
- Tests: `PKCETests` (RFC 7636 appendix B), `HostedUITests` (authorize URL, callback checks), `TokenEndpointTests` (form bodies, no secret, decoding, errors, with `StubURLProtocol`), `AccountIDTests`, `AuthSessionTests` (single-flight refresh, expiry, offline, sign-out), `AuthModelTests` (the flow with a fake web sheet), and `KeychainCredentialStoreTests`, a real Keychain round trip in the test host app that is skipped if the simulator gives the unsigned build no Keychain. Fakes are in `CupmarkTests/Support/AuthFakes.swift`.
- Only a device run against dev (M2-T34) shows the Apple sheet, the callback and a real token exchange.

## Strings

- Every UI string is a key in `L10n.swift` with English and German in `Localizable.xcstrings`. Vocabulary labels come from `contracts/i18n` and are shown with `Text(verbatim:)`.
- Every catalog entry has `"extractionState" : "manual"`: the catalog is maintained by hand together with `L10n.swift`, and `manual` tells Xcode not to mark an entry stale when its extraction does not find the key in code. Add it to every new entry.
- `node scripts/check-ios-strings.mjs` checks the catalog on Linux: both languages present and translated, `extractionState` manual, no unused or missing key. It also fails on shown text that bypasses `L10n` in any Swift file under `ios/` (comments ignored):
  - a string literal as the first argument of `Text`, `Label`, `Button`, `navigationTitle`, an accessibility modifier or the other calls in `UI_CALLS`, also when the literal is on a later line than the call;
  - any string literal inside `Text(verbatim: ...)`, including a fallback such as `?? "n/a"`;
  - a name bound to a string literal in the same file (`let title = "Hi"`) passed as the first argument of one of those calls.
  Literals that are not shown text, such as `Image(systemName:)` or `systemImage:`, are allowed.
- `InfoPlist.xcstrings` localises the Info.plist permission strings. `check-ios-strings.mjs` checks it with the same rules and requires exactly the `INFOPLIST_KEY_NS...UsageDescription` settings of `project.pbxproj`, with the English value equal to the build setting.
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
