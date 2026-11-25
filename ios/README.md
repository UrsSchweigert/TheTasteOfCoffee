# Cupmark iOS app

SwiftUI app, iOS 17 or later, no third-party packages. Builds only on macOS with Xcode 16 or later.

## Layout

```
Cupmark.xcodeproj/        hand-written project (see "Project file")
Cupmark/                  app target sources and resources
  Generated/Vocabulary.swift   generated from contracts/, never edit
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
- `VocabularyStore.load(from:)` decodes the bundled JSON at runtime and resolves labels with `label(namespace:id:language:)`. Errors are thrown, never trapped.

## Strings

- Every UI string is a key in `L10n.swift` with English and German in `Localizable.xcstrings`. Vocabulary labels come from `contracts/i18n` and are shown with `Text(verbatim:)`.
- `node scripts/check-ios-strings.mjs` checks the catalog on Linux: both languages present and translated, no unused or missing key, and no string literal passed straight to `Text`, `Label`, `Button` or an accessibility modifier.
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

CI runs the same on `macos-15` with Xcode 16.4 (job `ios` in `.github/workflows/ci.yml`).
