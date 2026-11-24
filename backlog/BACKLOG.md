# Backlog

The work queue. The master agent owns it and may re-order, split, add or drop tasks to reach the current goal. `/next-task` takes the first task with `status: todo` whose dependencies are `done`.

Status values: `todo`, `in-progress`, `done`, `blocked`, `needs-mac-verification`.

Owners: `contract-keeper`, `backend-engineer`, `infra-engineer`, `ios-engineer`, `planner`, `master`.

`needs: access Ax` points to an item in `ACCESS.md`. It is the only reason a task waits for the owner.

**Current goal: iteration 1** (`docs/08-iteration-1.md`). Iteration 2 tasks below it are not started until iteration 1 is on the phone.

---

## Iteration 1: the app on a phone (local-first)

### I1-T1 Vocabulary v1
- status: todo
- owner: contract-keeper
- depends: none
- implements: docs/04-specification.md, sections Input model, F1, F2, F3
- acceptance:
  - `contracts/vocabulary/v1/` holds methods, criteria, intensities, water types, milk types, processes, varieties, roast levels, origins, bag sizes, price bands, numeric ranges, a starter roaster list, a starter grinder list and flavour notes (two levels, about 80 terms).
  - `contracts/i18n/en.json` and `de.json` have a label for every id; a test fails when one is missing.
  - A JSON Schema validates every vocabulary file; a test runs it.
  - The master approves the lists and marks version 1 `published` (ADR).

### I1-T2 iOS project skeleton
- status: todo
- owner: ios-engineer
- depends: I1-T1
- needs: access A1, A2 (to verify; the code can be written without)
- acceptance:
  - `ios/project.yml` generates the Xcode project with XcodeGen: app and test targets, iOS 17, SwiftUI, String Catalog with German and English, `Local.xcconfig` for signing.
  - The vocabulary is bundled and loaded through generated Swift types.
  - A unit test loads every vocabulary file and resolves every label in both languages.
  - `scripts/ios-test.sh` generates the project and runs the tests on a simulator.

### I1-T3 Local data model
- status: todo
- owner: ios-engineer
- depends: I1-T2
- implements: docs/05-system-design.md, Data model (the user's own items)
- acceptance:
  - SwiftData models for bean, shelf entry, brew with rating, and recipe, storing vocabulary ids and the vocabulary version.
  - Every record has a stable id and timestamps so iteration 2 can sync it unchanged.
  - Tests cover create, edit, delete, and ratio and days-since-roast calculations.

### I1-T4 App shell and navigation
- status: todo
- owner: ios-engineer
- depends: I1-T3
- acceptance:
  - Tabs for Shelf, Log and Stats; a prominent scan button; empty states.
  - Reusable input components: chip picker, indexed long list with recents (no search field), half-step score slider, numeric stepper, timer.
  - Each component has an accessibility label and supports Dynamic Type.

### I1-T5 Barcode scan
- status: todo
- owner: ios-engineer
- depends: I1-T4
- implements: docs/04-specification.md, F1 steps 1 to 3
- acceptance:
  - VisionKit scanner reads EAN-13 and UPC-A; camera permission is requested with a clear reason.
  - A barcode already on the device opens its bean. An unknown one is looked up in Open Food Facts with a descriptive User-Agent; a hit is shown for confirmation, with attribution.
  - The scanner is behind a protocol so tests can stub it.

### I1-T6 Bean entry by pick lists
- status: todo
- owner: ios-engineer
- depends: I1-T4
- implements: docs/04-specification.md, F1 step 4
- acceptance:
  - Roaster (or "not listed"), origin, process, variety and roast level by pick lists; optional label photo stored on the device.
  - Reachable from a failed lookup and from "no barcode".

### I1-T7 Shelf
- status: todo
- owner: ios-engineer
- depends: I1-T5, I1-T6
- implements: docs/04-specification.md, F1 step 5
- acceptance:
  - Add a purchase with purchase date, roast date, bag size and price band; list, edit, finish and delete shelf entries.

### I1-T8 Brew log and recipes
- status: todo
- owner: ios-engineer
- depends: I1-T7
- implements: docs/04-specification.md, F2
- acceptance:
  - Brew form whose fields depend on the method, with all ranges from the vocabulary; built-in timer.
  - Save a brew as a recipe; repeat a recipe with one tap.

### I1-T9 Rating
- status: todo
- owner: ios-engineer
- depends: I1-T8
- implements: docs/04-specification.md, F3
- acceptance:
  - Eight criteria in half steps, three intensities, up to five flavour notes from the two-level list, buy again.
  - The repeat-brew path (open app, pick recipe, rate, save) takes at most 8 taps; a UI test counts them.

### I1-T10 History and personal statistics
- status: todo
- owner: ios-engineer
- depends: I1-T9
- acceptance:
  - Brew history per bean and overall; average per criterion; best method per bean; taste profile from the most-picked notes.

### I1-T11 Build checks
- status: todo
- owner: infra-engineer
- depends: I1-T2
- acceptance:
  - `.github/workflows/ci.yml` runs on pull requests: contract tests and `scripts/check-no-free-text.sh` on Linux; iOS build and tests on a macOS runner only when `ios/` changed.
  - Actions are pinned; the workflow has read-only permissions.

### I1-T12 On the phone
- status: todo
- owner: master
- depends: I1-T10
- needs: access A1, A3, A4
- acceptance:
  - `scripts/install-on-phone.sh` builds a signed build and installs it on the connected iPhone.
  - `docs/run-on-phone.md` explains the one-time setup and the one command.
  - `docs/test-script-iteration-1.md` gives a 10-minute test script.
  - All exit criteria in `docs/08-iteration-1.md` are met and ticked there.

---

## Iteration 2: backend, sign-in and sync

Not started until iteration 1 is on the phone. The master re-plans this with `/plan-milestone` using what the phone test showed.

### M0 Backend foundations
Scope: OpenAPI definition with the no-unconstrained-string lint; `backend/` TypeScript workspace with generated zod schemas; `infra/` CDK app for dev and prod in eu-central-1 with a forbidden-resource test; CI for both. Needs access A7.

### M1 Personal log, backend
Scope: DynamoDB table and buckets with pinned safety properties; Cognito (Lite plan, Sign in with Apple only) and HTTP API with JWT authorizer; repository module; bean catalogue and barcode routes; shelf, brew and recipe routes; profile, consent, export and deletion; deploy pipeline to dev. Needs access A6, A7, A8.

### M2 Sign-in and sync in the app
Scope: Sign in with Apple, sync outbox from the local store, shared bean catalogue, label photo upload, CSV export, account deletion, onboarding with consent.

## Iteration 3: the paid tier

### M3 Aggregation
Scope: stream aggregator, rater markers, recipe histogram buckets, nightly rankings job, 5-rater threshold, one-rating-per-user-bean-day rule, weekly export to S3.

### M4 Subscription and Explore
Scope: StoreKit 2 purchase and restore, transaction verification, App Store Server Notifications route, entitlement, paid API routes, Explore screens, paywall, give-to-get teaser.

## Iteration 4: launch

### M5 Hardening
Scope: App Attest, per-user write caps, budgets and alarms, operator CLI for catalogue curation, restore drill, privacy review, performance against the 300 ms target.

### M6 Launch
Scope: App Store listing, privacy labels, privacy policy and terms, TestFlight round, production deployment (owner approves), launch checklist.
