# Backlog

The work queue for the agent team. `/next-task` takes the first task with `status: todo` whose dependencies are `done`.

Status values: `todo`, `in-progress`, `done`, `blocked`, `needs-mac-verification`.

Owners: `contract-keeper`, `backend-engineer`, `infra-engineer`, `ios-engineer`, `planner`, `human`.

Milestones M0 to M2 are broken into tasks. M3 to M6 are planned with `/plan-milestone` when their turn comes, so the plan can use what was learned before.

---

## M0 Foundations

Goal: the repo builds, tests and checks itself; the shared contract exists.

### M0-T1 Vocabulary v1
- status: done
- owner: contract-keeper
- depends: none
- implements: docs/04-specification.md, sections Input model, F2, F3
- acceptance:
  - `contracts/vocabulary/v1/` holds methods, criteria, intensities, water types, milk types, processes, roast levels, bag sizes, price bands, numeric ranges and flavour notes (two levels, about 80 terms, marked `draft` until the owner approves).
  - `contracts/i18n/en.json` and `de.json` have a label for every id; a test fails when one is missing.
  - A JSON Schema validates every vocabulary file; a test runs it.

### M0-T2 OpenAPI skeleton
- status: done
- owner: contract-keeper
- depends: M0-T1
- implements: docs/05-system-design.md, Data model
- acceptance:
  - `contracts/openapi.yaml` defines the routes for barcode lookup, bean create, shelf, brews, recipes, profile, export and delete account.
  - A lint test fails on any string property without `enum`, `pattern` or `format`, and on any number without bounds.

### M0-T3 Backend workspace
- status: done
- owner: backend-engineer
- depends: M0-T2
- acceptance:
  - `backend/` is a strict TypeScript project with Vitest, ESLint and an esbuild bundle script.
  - zod schemas and types are generated from `contracts/`; generation is checked in CI (no drift).
  - A health handler with a passing test exists.

### M0-T4 Infra workspace
- status: done
- owner: infra-engineer
- depends: M0-T3
- acceptance:
  - `infra/` is a CDK v2 app with `dev` and `prod` stages in eu-central-1 that synthesises.
  - An assertion test fails if the template contains a forbidden resource type (see CLAUDE.md, invariant 5).

### M0-T5 Continuous integration
- status: done
- owner: infra-engineer
- depends: M0-T3, M0-T4
- acceptance:
  - `.github/workflows/ci.yml` runs on pull requests: contract tests, backend tests and lint, `cdk synth`, infra tests, `scripts/check-no-free-text.sh`.
  - Third-party actions are pinned; the workflow has read-only permissions.

### M0-T6 iOS project skeleton
- status: done
- owner: ios-engineer
- depends: M0-T1
- acceptance:
  - `ios/` holds an Xcode project (iOS 17, SwiftUI) with app and test targets, a String Catalog with German and English, and the vocabulary bundled and loaded through generated types.
  - A unit test loads every vocabulary file and resolves every label in both languages.
  - A macOS CI job builds and tests the app.

### M0-T7 Accounts and secrets
- status: blocked
- owner: human
- needs: human
- depends: none
- acceptance:
  - Apple Developer Program membership active (done, 2026-11-25). App ID `app.cupmark.Cupmark` with Sign in with Apple and the App Store Connect app record created (done, 2026-11-25). Services ID `app.cupmark.signin` and the Sign in with Apple key created (done, 2026-11-25). The owner holds the `.p8`, and stores it in Parameter Store as a SecureString when M1-T2 is deployed.
  - In the shared AWS account (ADR 0009), checked read-only by the owner on 2026-11-25:
    - root MFA is on (done);
    - `CupmarkBoundary` and `CupmarkCfnExecution` match `scripts/aws/*.json` (done);
    - `CDKToolkit-cupmark` is bootstrapped with qualifier `cupmark`, version 34 (done);
    - the GitHub OIDC provider exists, so `reference` is used (done);
    - `CupmarkGitHubDeploy` exists, created by hand (done);
    - `cupmark-github-oidc` (M1-T9) has been deployed once by hand, importing that role (open).
  - Branch protection on `main` requires `ci-ok` (done).
  - Repository secrets set for the Claude GitHub workflow.


### M0-T8 Harden the existing workflows
- status: done
- owner: infra-engineer
- depends: M0-T5
- acceptance:
  - `claude.yml` and `aws-oidc-check.yml` pin every action to a commit SHA with a version comment, set top-level permissions, keep job-level write scopes only where the action needs them, and use `persist-credentials: false`. Both are added to `STRICT_FILES` in `scripts/check-workflows.mjs`.
  - From the M0-T5 review:
    - the version-comment check covers every `uses:` line, not only the first occurrence;
    - the ci.yml concurrency comment, or the push group, matches GitHub's single-pending-run behaviour.
  - A Dependabot config for `github-actions` keeps the pinned SHAs current.


### M0-T9 Harden the iOS checks
- status: done
- owner: ios-engineer
- depends: M0-T6
- acceptance:
  - `scripts/check-ios-strings.mjs` also catches `Text(verbatim:)` with a literal, literals on the line after the call, and literals passed through a variable. Tests show each case failing.
  - The generator renames the milk id `none` to a Swift case that cannot be confused with `Optional.none`, for example `noMilk`, while the raw value stays `none`.
  - `Localizable.xcstrings` entries carry `extractionState: manual`, so Xcode does not mark them stale.
  - The `ios` CI job is skipped on changes that cannot affect the app, and `ci-ok` still passes when it is skipped.


### M0-T10 Licence allowlist in CI
- status: done
- owner: infra-engineer
- depends: M0-T8
- acceptance:
  - A CI step checks every package in the contracts, backend and infra lockfiles against an allowlist of permissive licences, plus the MPL-2.0 dev-only exception from ADR 0008, and fails on anything else, including an unknown licence.
  - A test shows the check failing on a lockfile entry with a GPL or unknown licence.
  - This guards the Dependabot npm updates from M0-T8, which can bring in new transitive dependencies.

---

## M1 Personal log, backend

Goal: a signed-in user can store and read their own shelf, brews and recipes through the API, in the dev account.

### M1-T1 Table, buckets and safety properties
- status: done
- owner: infra-engineer
- depends: M0-T4
- implements: docs/05-system-design.md, Data model, Persistence and recovery
- acceptance:
  - The DynamoDB table and both buckets exist in the stack with the properties in the design doc.
  - Assertion tests pin: on-demand billing, PITR, deletion protection, stream enabled, RETAIN, public access blocked, versioning, TLS-only policy.

### M1-T2 Identity and API shell
- status: done
- owner: infra-engineer
- depends: M1-T1, and the Apple items of M0-T7 (done 2026-11-25). The repository secrets in M0-T7 are needed only for M1-T7.
- implements: docs/05-system-design.md, Components, Security
- acceptance:
  - Cognito user pool (Lite plan, Sign in with Apple only) and an HTTP API with JWT authorizer and throttling are in the stack.
  - A test asserts every route except the App Store notifications route has the authorizer.
  - The Cognito domain prefixes are exactly `cupmark-dev` and `cupmark-prod`, and the Apple identity provider uses the Services ID `app.cupmark.signin`. The Sign in with Apple key id is `3WKKAZFM6M`. The Apple Team ID is `2F695PTZC6`. This is configuration, not a secret; the `.p8` private key goes only into a Parameter Store SecureString created by the owner. The owner registered both in Apple's portal with the return URL `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`. A test pins the prefixes.
  - From the M1-T1 review: the user pool is RETAIN with `DeletionProtection: ACTIVE`, and `AWS::Cognito::UserPool` joins the stateful guard. Losing the pool would orphan every `USER#<sub>` partition.
  - From M1-T8: the API Lambda gets outbound HTTPS to the Open Food Facts image host as well as its API, and `s3:GetObject` and `s3:PutObject` on `catalogue/*` in the photo bucket. infra/README.md notes that the photo bucket also holds catalogue images that never expire.
  - From the M1-T5 review (ADR 0013):
    - the HTTP API uses the `$default` stage, because the router matches on `rawPath`;
    - the API Lambda gets `TABLE_NAME` and `CURSOR_KEY_PARAMETER=/cupmark/<stage>/cursor-key`, plus `ssm:GetParameter` on exactly that parameter ARN;
    - the owner creates the SecureString by hand (at least 32 random bytes, base64), because CloudFormation cannot create a SecureString, and the README gives the exact command. Done for dev and prod on 2026-11-25, together with the Apple key parameters.
  - From the M1-T8 review: the table gets `TimeToLiveSpecification` on a named attribute (`expires_at`), docs/05 names it, and the "no TTL" assertion in `infra/test/data.test.ts` changes accordingly. The API Lambda gets outbound HTTPS to Open Food Facts, with no VPC and no NAT.
  - From the M1-T1 review: a test snapshots the logical ids of the table, the buckets and the pool, so a construct rename that would replace them fails at test time.

### M1-T3 Repository module
- status: done
- owner: backend-engineer
- depends: M0-T3
- implements: docs/05-system-design.md, Data model
- acceptance:
  - One module builds every key format in the data model and exposes typed reads and writes.
  - Tests against DynamoDB Local cover each item type and prove one user cannot address another user's partition.
  - Unverified bean `META` items set the sparse index keys documented in `infra/README.md`: `gsi1pk=REVIEW#UNVERIFIED`, and `gsi1sk=<createdAt>#<beanId>` with `createdAt` always fixed-width UTC (`toISOString()`). Verifying or rejecting a bean removes both.

### M1-T4a Bean catalogue and barcode lookup
- status: done
- owner: backend-engineer
- depends: M1-T3, M1-T8
- implements: docs/04-specification.md, F1
- acceptance:
  - `GET /barcodes/{barcode}` looks up the canonical EAN-13. `POST /beans` creates an unverified bean from pick-list attributes (including origin, species and variety from vocabulary v2), with the source tagged per field. `GET /beans/{bean_id}` returns it. All three follow the contract.
  - Tests cover known, unknown and malformed barcodes, and a bad check digit.
  - `createBean` can throw `WriteConflictError`, so the route retries it like the other writes. Operator verify and reject also use `rethrowConflict` (from the M1-T5 review).
  - Rejecting a bean frees its barcode: the `BARCODE#` pointer is removed in the same write, so the next scan can submit a fresh entry. The rejected bean stays recorded for the operator (owner decision, 2026-11-25).
  - `POST /beans` with `open_food_facts_confirmed` returns 409 until M1-T4b provides the cache.

### M1-T11 Rejected beans on shelves; catalogue contract wording
- status: done
- owner: contract-keeper, then backend-engineer
- depends: M1-T4a
- implements: follow-ups from the M1-T4a review; decided by the lead under ADR 0014
- acceptance:
  - Creating or replacing a shelf entry with a rejected bean answers 404 (`BeanNotFoundError`). The condition is `status <> rejected`, in the same transaction. Shelf entries that already reference a bean rejected later keep working. Unit and DynamoDB Local tests cover both cases.
  - `contracts/openapi.yaml`: `NotFound` no longer says "in the caller's partition" for the shared catalogue routes (it also covers a rejected bean), and `BadRequest` mentions a bad barcode check digit. No schema change.

### M1-T4b Server-side Open Food Facts lookup
- status: done
- owner: backend-engineer
- depends: M1-T4a
- implements: docs/decisions/0005, docs/05 Barcode lookup
- acceptance:
  - `GET /barcodes/{barcode}/open_food_facts` fetches with User-Agent `Cupmark/<version> (<contact>)`, with the contact taken from a Lambda environment variable, never Secrets Manager.
  - Results are cached in `BARCODE#<ean>`/`OFF`, and a miss expires by TTL (`expires_at`). A per-user daily cap in `USER#<id>`/`LOOKUPS#<date>` returns 429, and the route returns 409 or 503 as the contract says. Whether a 409 or 400 counts against the cap is decided, and docs/05 matches it. Repository keys exist for both items.
  - Name and brand are trimmed and cut in code points, and never logged.
  - `POST /beans` with `open_food_facts_confirmed` copies from the cache, and returns 409 when there is no cached hit.
  - Tests use a stubbed HTTP client; no test calls Open Food Facts.

### M1-T4c Open Food Facts image copy
- status: done
- owner: backend-engineer
- depends: M1-T4b
- implements: docs/decisions/0011, D12
- acceptance:
  - The server follows only an Open Food Facts image-host URL for the same canonical EAN-13. It copies the image once to `catalogue/<image_id>.jpg` in the photo bucket: JPEG only, size-limited, all metadata stripped. If the copy fails, the hit is cached without an image.
  - `GET /catalogue_images/{image_id}` serves the bytes with `X-Content-Type-Options: nosniff` and long-lived caching, under the Lambda response limit.
  - Any metadata-stripping dependency has a permissive licence and passes the licence check.

### M1-T4d Label photo upload
- status: done
- owner: backend-engineer
- depends: M1-T4a
- implements: docs/04-specification.md, F1; D10 to D12
- acceptance:
  - A presigned upload URL for a label photo, limited in size and content type.
  - The uploader of each photo is recorded, so account deletion (M1-T6) can find that user's photos. Metadata is stripped before the photo is stored for review or shown (D12).
  - A contract change, if one is needed, goes to contract-keeper first.

### M1-T5 Shelf, brew and recipe routes
- status: done
- owner: backend-engineer
- depends: M1-T3, M0-T2
- implements: docs/04-specification.md, F2, F3
- acceptance:
  - Create, list, update and delete for shelf entries, brews with ratings, and recipes.
  - Every field is validated against the vocabulary version sent with the request; unknown properties are rejected.
  - Tests cover range limits, half-step scores and the five-note maximum. The method-dependent rule hook exists and is tested, but holds no rules until the spec defines them (D13). Acceptance reworded by the owner on 2026-11-25.

### M1-T6 Profile, consent, export and deletion
- status: done
- owner: backend-engineer
- depends: M1-T5
- implements: docs/05-system-design.md, Security; docs/07-open-questions.md D1, D2
- acceptance:
  - Profile holds consent and locale; export returns all of a user's items as CSV; delete removes the whole user partition and the label photos.
  - From M1-T4b: the user partition also holds `LOOKUPS#<day>` counters (the daily Open Food Facts lookup cap). Deletion removes them with the partition. Export leaves them out: they are rate-limit state, not the user's data.
  - From M1-T4d (ADR 0016, D10): export lists `PHOTO#` items (photo id and bean id). Deletion removes `PHOTO#`, `PHOTO_PENDING#`, `BEANPHOTOS#` and `PHOTO_UPLOADS#`. For photos of unverified beans, it also removes the bean-side `PHOTO#` item and every version of `labels/<id>.jpg` and `uploads/<id>.jpg`. See backend/README.md.
  - Tests prove nothing of the user remains after deletion.
  - From the M1-T2 review: deleting the account also deletes the Cognito user (`cognito-idp:AdminDeleteUser` on the stage pool). That needs a boundary change, and the owner re-applies the guardrails.
  - Deleting photos removes every object version, not just adding a delete marker, and a test asserts no version remains (see D10).
  - The boundary policy lacks `s3:DeleteObject`, `s3:DeleteObjectVersion` and `s3:ListBucketVersions` on the photo bucket. The policy change goes into `scripts/aws/`, and the owner re-applies it before deploy.

### M1-T7 Deploy pipeline to dev
- status: done (the owner approved and ran the first dev deploy on 2026-11-26; `cupmark-dev-core` is up, `GET /health` answers 200 and `scripts/smoke/post-deploy-checks.sh dev` passes; infra/README.md, "If the first deploy fails", records what the first deploy taught)
- owner: infra-engineer
- depends: M1-T2, M0-T5, M1-T9
- needs: human (approve the first deployment)
- acceptance:
  - A workflow deploys to dev through OIDC on merge to `main`, and to prod only through a manually approved environment.
  - From M1-T9 review (ADR 0018): the deploy jobs declare the GitHub environments `dev` and `prod` (the role `CupmarkGitHubDeploy` trusts only `environment:dev` and `environment:prod`; both environments are limited to `main`). The prod job requires the owner's approval (required reviewer on `prod`). The stage stacks are named explicitly (`-c stage=<stage>`, `cupmark-<stage>-core`), never `--all`. `scripts/check-workflows.mjs` fails a job that runs `configure-aws-credentials` without the literal environment `dev` or `prod`; the deploy workflow is added to its strict files.
  - A smoke test calls the health route after deploy.
  - From M1-T4b: the API function gets `OFF_CONTACT` (the operator's mailbox, as a plain environment variable) and optionally `OFF_LOOKUP_CAP`. Without them, uncached Open Food Facts lookups answer 503.
  - From M1-T4b review: after the first deploy to dev, look up one known barcode and one unknown one, and check that the answers match the response shape the client expects (`status`, `product.product_name`, `product.brands`). A shape mismatch answers 503 and caches nothing.
  - From M1-T4c review: in the same check, a known barcode with a front image must return `image_id`, and `GET /catalogue_images/{image_id}` must serve it. A hit is never overwritten, so a missing or wrong `PHOTO_BUCKET` would leave every new hit without an image for good.
  - From M1-T4d: in the same check, call `POST /beans/{bean_id}/label_photos` for an unverified bean, upload a small JPEG to the presigned POST and complete it. The presigner is bundled (3.1177.0) and signs with the runtime's S3 client, so a 500 here would point to version skew.
  - From M1-T9 review: add `.github/workflows/<deploy>.yml` to `STRICT_FILES` in `scripts/check-workflows.mjs`, so the environment rule fails the build there. Add the provider audience check (`ClientIDList` contains `sts.amazonaws.com`) to `scripts/aws/check-github-deploy-role.sh`.

### M1-T8 Contract update for D7 to D9
- status: done
- owner: contract-keeper
- depends: M0-T3
- implements: docs/decisions/0005, 0006, 0007
- acceptance:
  - Vocabulary v2 adds `origins` and `varieties` (with `other` and `unknown`, labels in en and de), follows the publishing steps in `contracts/README.md`, and is locked. v1 is unchanged.
  - `contracts/openapi.yaml`:
    - bean requests take origin and variety from v2;
    - bean responses carry the Open Food Facts name, brand and image reference as response-only, length-limited fields with their source;
    - `GET /health` is declared with `security: []`.
  - The OpenAPI lint allows response-only Open Food Facts text and the one health route as explicit, documented exceptions. Any other text field or route without the bearer token still fails, and tests prove both.
  - docs/05 Barcode lookup describes the server-side lookup (User-Agent, catalogue cache, per-user cap), and docs/04 F1 step 3 matches it.
  - The backend regenerates its schemas, and the no-drift check passes.
  - Status: done on 2026-11-25 in two parts. Part 1: D7 and D9, plus draft v2. Part 2: v2 published and locked with the owner's ADR 0011 amendments; origin, species and variety bound in the contract; Open Food Facts images referenced by `image_id`; health route and raw-body lint hardened; backend and iOS on v2.

### M1-T9 GitHub OIDC deploy stack and IAM policy guards
- status: done
- owner: infra-engineer
- depends: M0-T4
- implements: docs/decisions/0009
- acceptance:
  - A separate stack `cupmark-github-oidc` creates the role `CupmarkGitHubDeploy`, which GitHub Actions in this repository may assume, and the prod stage only from `main`. The role may assume only the `cdk-cupmark-*` bootstrap roles.
  - The context flag `cupmark:githubOidcProvider` is `create` or `reference`, and the committed default is `reference`, because the provider already exists in the shared account. With `create`, the stack makes the provider for `token.actions.githubusercontent.com`. With `reference`, it trusts the existing provider by ARN and never modifies it. Tests cover both modes.
  - The role `CupmarkGitHubDeploy` already exists (created by hand on 2026-11-25). Its trust is the existing provider, `aud` `sts.amazonaws.com`, and `sub` set to this repository's `environment:dev` and `ref:refs/heads/main`. Its inline policy `AssumeCdkBootstrapRoles` allows `sts:AssumeRole` on the four `cdk-cupmark-*` roles. It has no boundary and no tags.
    - The stack defines this role so that it matches what exists, and it is imported with `cdk import` and a resource mapping file. This is the owner's preferred option, because it keeps the role ARN.
    - The README documents the import. Any drift the import would cause, such as adding the boundary or tags, is listed for the owner before the deploy. Deleting the role instead needs the owner. The stack never creates a second role under another name. A test pins the role name and its trust policy.
  - `scripts/aws/apply-guardrails.sh` step 3 (`put-role-policy` on `CupmarkGitHubDeploy`) is reconciled with ADR 0009, because the stack owns the role and the script must no longer write its policy.
  - The stack deploys with the caller's credentials, not through `CupmarkCfnExecution`. The README gives the one-time manual deploy steps, including how to check whether a provider or a role named `CupmarkGitHubDeploy` already exists.
  - The guards add the M0-T4 review findings: IAM policies with `*` actions or resources, or with ARNs outside `cupmark-`, fail, and so do stateful resources without RETAIN. Tests show each guard failing.


### M1-T10 Block changing the bean of a shelf entry that has brews
- status: done
- owner: contract-keeper, then backend-engineer
- depends: M1-T5
- implements: docs/07-open-questions.md D14
- acceptance:
  - `contracts/openapi.yaml`: `PUT /shelf/{shelf_entry_id}` documents a 409 response when `bean_id` would change while brews reference the entry. The lint and drift tests pass.
  - The backend replaces the entry conditionally, so a `bean_id` change fails when `brewCount` > 0 and the API answers 409 with no body. Any other change, and a `bean_id` change with no brews, still succeeds.
  - Unit and DynamoDB Local tests cover both cases, plus the race with a concurrent brew create.

---

## M2 Personal log, iOS

Goal: scan, shelf, brew, rate and personal statistics work offline and sync.

Scope: Sign in with Apple, barcode scanner, Open Food Facts lookup, pick-list bean entry with label photo, shelf, brew form per method, timer, rating screen, recipes and one-tap repeat, local store and sync outbox, personal statistics, CSV export, account deletion, onboarding with consent, accessibility pass.

Planning notes (planned 2026-11-25):

- **Order.** Contract and backend first (M2-T2 to M2-T5), then CI (M2-T6), then iOS. The iOS tasks follow the vertical slice sign in (T11), scan and lookup (T13, T14), store and sync (T15 to T17), shelf (T18), brew (T19), rate (T20). Everything else builds on that slice.
- **Backend gaps.** The only contract and backend change M2 needs is D13 (M2-T2 to M2-T5). The app needs no review-queue listing route: the review queue belongs to the operator (D3, M5 CLI), and the app reads its own unverified beans with `GET /beans/{bean_id}`, which carries `verified`. Paging already exists on `/shelf`, `/brews` and `/recipes` (`cursor`, `limit` up to 100), and that is enough for a full pull. Possible additions are listed in the M2 plan report and are not in this backlog.
- **Mac verification.** The CI job `ios` (macos-15, Xcode 16.4, iOS Simulator, signing off) builds the `Cupmark` scheme and runs its tests: `CupmarkTests`, plus `CupmarkUITests` from M2-T33. On a pull request it runs only when a path under `ios/`, `contracts/vocabulary/` or `contracts/i18n/` changes, or `scripts/generate-ios-vocabulary.mjs`, `scripts/check-ios-strings.mjs` or `ci.yml`. From M2-T6 on, `contracts/openapi.yaml` and `scripts/generate-ios-api.mjs` trigger it as well. Every iOS task below proves its acceptance with tests in that scheme, so it can end `done` when `ci-ok` passes with `ios` = success. The exceptions are the parts no simulator can check: the real sign-in (M2-T11), Xcode Cloud and TestFlight (M2-T12), the camera scanner (M2-T13), camera capture (M2-T23) and the real S3 upload (M2-T24). Those tasks end `needs-mac-verification` until the owner's checks in M2-T12 or M2-T34 pass.
- **ADRs due in M2.** They are taken by the lead under ADR 0014 and none of them adds cloud cost: the local-only log (T1), D13 (T2), the Swift API generator (T7), the build stage (T9), Xcode Cloud (T12), the sync rules (T16), the personal statistics set (T28), and deletion when the token cannot be refreshed (T31).

### M2-T1 Decide: optional local-only log without sign-in
- status: done (ADR 0020, D16: not in M2; sign-in required)
- owner: planner (the lead decides under ADR 0014)
- depends: none
- implements: docs/03-project-brief.md, In scope ("Sign in with Apple only"); docs/04-specification.md, Input model ("Identity comes from Sign in with Apple"); raised by the owner earlier
- acceptance:
  - An ADR records the lead's decision as "decided by: lead (ADR 0014)", and docs/07 gets an answered row for it (next free id, D16).
  - Cloud cost: none. A local-only log keeps everything on the device and calls no route. The ADR states this and also what follows from it. Every route except `GET /health` needs a token, so without sign-in there is no barcode lookup, no Open Food Facts hit, no catalogue bean, no label photo, no CSV export through the API, and no sync or backup.
  - The ADR answers these questions:
    - Is a local-only mode offered at all?
    - If so, what works without sign-in? At most: pick-list beans kept on the device, shelf, brew, timer, rating, recipes and statistics.
    - What happens on a later sign-in? Either the local items are uploaded (their pick-list beans then become new unverified beans) or they stay apart.
    - Consent stays opt-in (D1).
  - The lead's default, if nothing else is decided before M2-T15 starts: sign-in is required, as docs/03 says, and local-only is a later addition. If the answer is yes, the planner adds the tasks, and M2-T15 (the store keyed by account) and M2-T29 (onboarding) change before they start.

### M2-T2 Vocabulary v3 draft: method-dependent brew fields, grinders and grind setting (D13)
- status: done
- owner: contract-keeper
- depends: none
- implements: docs/04-specification.md, F2 (Grinder, Grind setting, "Fields depend on the method"); docs/07-open-questions.md D13; ADR 0004
- acceptance:
  - The lead records the D13 decision under ADR 0014 in this pull request: an ADR, and the D13 row in docs/07 answered. The recommended default below is the starting point.
  - `contracts/vocabulary/v3/` is copied from v2, with `"version": 3` and `"status": "draft"`. v1, v2 and their locks are unchanged, and the lock test passes.
  - v3 adds:
    - a `grinders` list. Each entry names its own scale (a range `{ minimum, maximum, multipleOf }`) or none. It includes `pre_ground` (no scale) and, as recommended, `other` (no scale).
    - the method field rules: for each brew field that only some methods allow, the methods that allow it.
  - Both use a shape that `contracts/README.md`, "File shapes", allows. If a new attribute shape is needed, the README, the schemas, `lib/vocabulary.mjs` and their tests are extended, as was done for `country` (ADR 0011).
  - Every new id has a label in `en.json` and `de.json`, and the existing missing-label test covers them.
  - New tests:
    - every rule names a known method and a known `BrewParameters` field (never `method`);
    - every grinder scale sits on its step, and the step is exact in binary floating point (ADR 0004);
    - `pre_ground` and `other` have no scale.
  - `vocabulary/CHANGELOG.md` has a v3 (draft) entry. `openapi.yaml` does not change yet, because a draft is not in the API.
  - Recommended default (from F2; the lead may change it). A field not allowed for a method must be absent, and the server answers 400 (M2-T5):
    - `water_temp_special` (`cold`): `cold_brew` only. `cold_brew` does not allow `water_temp_c`, because its range starts at 80 °C.
    - `water_temp_c`: every method except `cold_brew`, `moka_pot` and `cezve`. On the stove the water heats in the pot, so a set temperature means nothing, and it would skew the temperature ranges of top recipes (F4).
    - `grinder` and `grind_setting`: every method except `fully_automatic`, because its grinder is built in and F2 lists no machine models. `grind_normalised` stays allowed with every method, so a fully automatic brew still records coarseness.
    - `grind_setting` needs a `grinder` that has a scale, and must lie on that grinder's scale. It is absent for `pre_ground` and `other`.
    - `dose_dg`, `water_g`, `brew_time_s`, `water_type` and `milk`: every method. For `espresso`, the app labels `water_g` "yield" (F2: "Water or yield"); that is an app string, not a rule.
    - Grinders: a curated list of common home hand and electric grinders, each with the numbers on its own dial as its scale, in steps of 1 or 0.5. The contract-keeper proposes the list, and the owner approves it when v3 is published (M2-T4).

### M2-T3 Swift vocabulary generator: grinders and method field rules
- status: done (verified by the macOS `ios` job in its pull request; the v3 Swift output is first compiled at M2-T4)
- owner: ios-engineer
- depends: M2-T2
- implements: docs/04-specification.md, F2; CLAUDE.md invariant 2; ios/README.md, Vocabulary
- acceptance:
  - From the M2-T2 review: the generator today throws on v3 (`grinders.<id>.scale is neither a scalar nor an id list`) and would turn `field_rules` into Bool constants. Handle both explicitly: `Vocabulary.Grinder` with an optional `scale`, and a typed method-rules table. The Swift `VocabularyStore` would record scales under index paths such as `brew.grinders.0.scale`; the app reads scales through the generated types only. Reuse `ENTRY_RANGES`, `SCALED_FIELDS` and `isExactStep` from `contracts/lib/vocabulary.mjs`.
  - `scripts/generate-ios-vocabulary.mjs` emits:
    - `Vocabulary.Grinder` with a typed `scale: VocabularyRange?`;
    - the method field rules as a typed lookup, for example `Vocabulary.Method.allows(_: Vocabulary.BrewField) -> Bool`.
  - Both are read from the vocabulary files. No list is written in the script.
  - `scripts/ios-scripts.test.mjs` runs the generator on the v3 draft. The tests fail on a rule that names an unknown method or field, and on a scale off its step.
  - The output for the bundled v2 is unchanged (`--check` passes). The app keeps bundling v2 until M2-T4.
  - Mac: the script tests run on Linux, and the `ios` job runs because the generator changed.

### M2-T4 Publish vocabulary v3 and follow it in the API
- status: done (merged in #68; the v3 Swift and the pbxproj folder reference compiled and passed in the macOS `ios` job)
- owner: contract-keeper
- needs: human (the owner approves the v3 draft, in particular the grinder list and the method field rules; contracts/README.md, Publishing a version, step 3)
- depends: M2-T2, M2-T3
- implements: contracts/README.md, Publishing a version; docs/04-specification.md, F2; ADR 0004
- acceptance:
  - From M2-T22 (lead, ADR 0014): v2 does not offer `other` and `unknown` in every bean list (roast levels have neither, processes lack `unknown`, species lack `other`). The app treats "Not set" as unknown, which is enough. When reviewing the v3 draft, decide whether processes gain `unknown` and species gain `other` for consistency; roast level stays a scale without either.
  - From the M2-T2 review, for the owner's check before publishing: the uncertain scales in the CHANGELOG; the three grinders without a scale (Fellow Ode Gen 2, Fellow Opus, Eureka Mignon); a 0.5 step for `df64`; the `sage_` ids (the EU brand name, permanent once published). Also make `checkFieldRules` run for every version from 3 on, and share one exact-step helper between `lib/vocabulary.mjs` and `lib/openapi.mjs`.
  - After the owner approves, every v3 file is set to `published`, and `npm run lock -- 3` writes `v3.lock.json`.
  - `openapi.yaml` 0.6.0 adds:
    - a `Grinder` enum (`x-vocabulary: grinders`);
    - optional `grinder` and `grind_setting` in `BrewParameters`. `grind_setting` is bounded by the widest grinder scale, with a step that is exact or scaled per ADR 0004, and has `dependentRequired: { grind_setting: [grinder] }`;
    - the v3 rules in the `BrewParameters` description, replacing "not defined in vocabulary v1 yet";
    - `VocabularyVersion.maximum: 3`;
    - the export columns `grinder` and `grind_setting` in `x-csv-columns`, the description list and the table. The lint keeps all three in step.
  - The lint and drift tests pass. Tests that used 3 as an unpublished version now use 4.
  - `backend/` is regenerated (`npm run check:generated` passes). Rules and export are M2-T5, but any minimal backend change needed to keep its tests green goes in this pull request.
  - The Xcode folder reference moves to `vocabulary/v3`, and `Generated/Vocabulary.swift` is regenerated (`--check` passes). The `ios` job passes.

### M2-T5 Backend: method field rules and grinder scales from v3
- status: done (rules read from the generated v3 data; backend tests pass; the backend CI job is the final check)
- owner: backend-engineer
- depends: M2-T4
- implements: docs/04-specification.md, F2; docs/07 D13; the M1-T5 rule hook (`backend/src/vocabulary/method-rules.ts`)
- acceptance:
  - `methodRulesFor(3)` reads the rules from `src/generated/vocabulary.ts`, and no list is written in the backend. Versions 1 and 2 still have no rules, so existing brews and recipes stay valid.
  - `POST` and `PUT` on `/brews` and `/recipes` answer 400 for:
    - a field the method does not allow under v3;
    - `grind_setting` outside the grinder's own scale or off its step;
    - `grind_setting` with a grinder that has no scale;
    - `grinder` with `vocabulary_version` 1 or 2.
  - Unit tests cover every rule with an allowed and a disallowed method.
  - `GET /export` writes `grinder` and `grind_setting`. The export test pins the header against the contract.

### M2-T6 CI: run the ios job when the API contract changes
- status: done
- owner: infra-engineer
- depends: none
- implements: CLAUDE.md, Definition of done; M0-T9 (path filter)
- acceptance:
  - `IOS_PATHS` in `.github/workflows/ci.yml` gains `contracts/openapi.yaml` and `scripts/generate-ios-api.mjs`, the Swift API generator of M2-T7. Without them, a contract change that the app is generated from would skip the `ios` job.
  - A test in `scripts/check-workflows.test.mjs` fails if `IOS_PATHS` lacks any of the paths the iOS generators read.
  - ios/README.md, "Build and test", lists the new paths.

### M2-T7 Swift API types generated from the contract
- status: done (built and tested by the macOS `ios` job in its pull request; merged only with that job green)
- owner: ios-engineer
- depends: M2-T6
- implements: docs/05-system-design.md, Components (client); CLAUDE.md invariant 2 and Style; ADR 0004
- acceptance:
  - From M2-T6: the test `IOS_PATHS covers every path the iOS generators read` follows the generator's imports. If `scripts/generate-ios-api.mjs` imports `contracts/lib/openapi.mjs`, add it to `IOS_PATHS` in `.github/workflows/ci.yml` and to ios/README.md in the same pull request.
  - From the M2-T6 review: every iOS generator, and every module it imports, exports each path it reads as a `*_DIR` or `*_FILE` constant; literal paths are not detected by the coverage test.
  - An ADR (lead, ADR 0014) records the choice.
    - Chosen: an in-repo Node generator, `scripts/generate-ios-api.mjs`, writes `ios/Cupmark/Generated/API.swift` from `contracts/openapi.yaml`. It needs no Swift package and runs on Linux, like the vocabulary generator.
    - Rejected: Apple's swift-openapi-generator, because it adds Swift packages and a package fetch to CI against the README's "no third-party packages".
  - The generated file holds:
    - Codable types for every request and response schema the app uses;
    - `x-vocabulary` enums mapped to the existing `Vocabulary.*` types, so no list exists twice;
    - `dose_dg` as an integer with a grams helper;
    - `CalendarDate` as a day without a time zone, and timestamps as RFC 3339 with fractional seconds;
    - the water temperature as one enum, so `water_temp_c` and `water_temp_special` cannot both be set.
  - The contracts CI job runs `node scripts/generate-ios-api.mjs --check`, which fails on drift. Script tests are in `scripts/ios-scripts.test.mjs`.
  - XCTests:
    - a JSON round trip for every generated type;
    - 18.5 g encodes as `dose_dg` 185;
    - no unknown property is ever encoded;
    - a response item with an id that the bundled vocabulary does not know fails to decode as that item only, never as a trap.
  - Mac: the `ios` job.

### M2-T8 API client
- status: done (verified by the macOS `ios` job in its pull request)
- owner: ios-engineer
- depends: M2-T7
- implements: contracts/openapi.yaml 0.5.0 (0.6.0 after M2-T4); docs/05-system-design.md, Security
- acceptance:
  - From the M2-T7 review: cache the `ISO8601DateFormatter`s used by `API.Timestamp` (one per format), and add a script test that `generate-ios-api.mjs --check` exits 1 on a stale file.
  - `APIClient` (async/await, URLSession, no packages) has one method per operation the app uses. The base URL is injected; M2-T9 provides it.
  - Every call sends the bearer token from a `TokenProvider`. No call puts a user id in a path, query or body (invariant 3).
  - Each route's documented statuses (400, 401, 404, 409, 429, 503, 5xx) map to typed errors. Error bodies are not parsed, and no response body is logged, so Open Food Facts text is never logged (docs/05).
  - On a 401 the client asks the token provider to refresh once and retries once.
  - A paging helper follows `next_cursor` with `limit=100` until it is absent.
  - `GET /catalogue_images/{image_id}` is loaded with the token, not through `AsyncImage`, and cached on disk by id (the image is immutable).
  - Tests use a `URLProtocol` stub. They check each route's method, path, headers and body; every listed status; refresh and retry once; and paging over three pages.
  - Mac: the `ios` job.

### M2-T9 Stage configuration
- status: done (built and tested by the macOS `ios` job in #57)
- owner: ios-engineer
- depends: M2-T8
- implements: docs/05-system-design.md, Components, Security; infra/src/identity.ts (`cupmark://auth`, `cupmark://signout`); infra/README.md (stack outputs)
- acceptance:
  - `ios/Config/Dev.xcconfig` and `Prod.xcconfig` set:
    - the hosted domain `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com`;
    - the app client id;
    - the API URL;
    - the redirect `cupmark://auth` and the sign-out URL `cupmark://signout`.
  - The values reach the app through Info.plist keys and are read into a typed `StageConfig`. They are not secrets: the app client is public and has no secret (infra/src/identity.ts). Until M2-T10 they are placeholders.
  - An ADR (lead, ADR 0014) records that Debug builds and the TestFlight builds of M2 use dev, until prod is deployed in M6.
  - Missing or malformed values, or any region other than eu-central-1 (invariant 6), show a "not configured" screen and never crash. Tests cover valid, missing, malformed and wrong-region values.
  - Mac: the `ios` job.

### M2-T10 Dev stage values in the app
- status: done (merged in #77; the `ios` job runs `StageConfigTests` against the built app with the dev values)
- owner: ios-engineer
- needs: human (after the first dev deploy, the owner reads the outputs `AppClientId`, `ApiUrl` and `HostedDomain` of `cupmark-dev-core` and posts them on the task's issue)
- depends: M1-T7, M2-T9
- implements: infra/README.md, stack outputs
- acceptance:
  - `Config/Dev.xcconfig` holds the owner's values, and the `StageConfig` tests accept them.
  - Nothing else changes. The values are configuration, not secrets (invariant 8 holds).

### M2-T11 Sign in with Apple through the Cognito hosted UI with PKCE
- status: needs-mac-verification (unit tests pass in the `ios` job in #58; the real sign-in against dev is verified in M2-T34)
- owner: ios-engineer
- depends: M2-T8, M2-T9
- implements: docs/03-project-brief.md (Sign in with Apple only); docs/05-system-design.md, Security (60-minute access tokens, refresh token in the Keychain); infra/src/identity.ts (public client, `openid`, `cupmark://auth`)
- acceptance:
  - The sign-in screen has one control, a Sign in with Apple button in Apple's style. There is no other input.
  - The button opens `ASWebAuthenticationSession` on `/oauth2/authorize` with:
    - `identity_provider=SignInWithApple`, `response_type=code`, `scope=openid`;
    - `redirect_uri=cupmark://auth`, and the callback scheme `cupmark`;
    - an S256 code challenge and a random `state`.
  - The code is exchanged at `/oauth2/token` with the verifier, and no client secret is sent. The web flow goes through the Services ID, so the app needs no Sign in with Apple entitlement.
  - Token storage:
    - the refresh token goes in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`);
    - the access and id tokens are kept in memory only;
    - refreshing is single-flight, before expiry and on a 401.
  - Sign-out revokes the refresh token at `/oauth2/revoke` and clears the Keychain.
  - The app reads no name and no email. It uses the token's `sub` only on the device, to key the local store (M2-T15), and never sends it.
  - Tests:
    - the RFC 7636 appendix B test vector;
    - the authorize URL's parameters;
    - a state mismatch, a missing code and a user cancel are rejected;
    - token response decoding;
    - a single refresh when two callers ask at once;
    - a Keychain round trip.
  - Mac: the unit tests run in the `ios` job. The task ends `needs-mac-verification` until the real sign-in against dev passes in M2-T34.

### M2-T12 Development team and TestFlight through Xcode Cloud
- status: todo
- progress (2026-11-26, lead): the first Xcode Cloud build (1) was refused with ITMS-90022 and ITMS-90713, both because the app had no icon. Done in the app-icon PR: `Assets.xcassets/AppIcon.appiconset` with one 1024-point icon (a placeholder bean, to be replaced by a real design) and `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`. Also done there: `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO` and `PrivacyInfo.xcprivacy` (no tracking; collected data: user id, other user content, photos, all linked and for app functionality; file timestamp API, reason C617.1). Still to do here: the team setting, the build number, the README and the ADR (Release uses Dev.xcconfig on purpose: the internal TestFlight build talks to the dev stage).
- owner: ios-engineer
- needs: human. On the owner's Mac, in Xcode: Integrate, then Create Workflow. Grant Xcode Cloud access to the GitHub repository. Pick team `2F695PTZC6` and the App Store Connect app of `app.cupmark.Cupmark`. Create an internal TestFlight group. Start the first build and report its build number once it is installed from TestFlight.
- depends: M2-T11
- implements: docs/03-project-brief.md, Suggested order of work (docs/07, step 4: ship to TestFlight); M0-T7 (Team ID)
- acceptance:
  - From the M2-T11 review: before the first App Review submission, check the hand-drawn Sign in with Apple button against Apple's guidelines for custom buttons (Apple's downloadable logo artwork and title-to-height proportions), not only the `apple.logo` symbol.
  - `project.pbxproj` sets `DEVELOPMENT_TEAM = 2F695PTZC6` on the app and test targets, with automatic signing. The Team ID is configuration, not a secret, and M1-T2 already names it. CI keeps `CODE_SIGNING_ALLOWED=NO` and still passes. The ios/README.md "Signing" section no longer says the team is set only locally.
  - The upload is accepted by App Store Connect:
    - `ITSAppUsesNonExemptEncryption` is `NO` (system HTTPS only);
    - `PrivacyInfo.xcprivacy` declares no tracking and the required-reason APIs the app uses, for example `UserDefaults`.
  - The build number comes from Xcode Cloud (`CI_BUILD_NUMBER`), either through `ios/ci_scripts/ci_pre_xcodebuild.sh` or through Xcode Cloud's managed versioning, as documented.
  - ios/README.md, "TestFlight (Xcode Cloud)", documents the workflow:
    - start condition: manual, or a tag on `main`;
    - action: Archive iOS, scheme `Cupmark`, Release;
    - post-action: TestFlight internal testing;
    - stage: dev (M2-T9);
    - no secrets in the workflow or the repository.
  - ADR due (lead, ADR 0014): Xcode Cloud is the TestFlight route, and GitHub Actions stays the CI. Apple builds from the repository with read access that the owner grants. There is no AWS cost, and the compute is within the hours included in the Developer Program membership.
  - Mac: ends `needs-mac-verification` until the owner reports a TestFlight build installed on a device.

### M2-T13 Barcode scanner
- status: needs-mac-verification (unit tests passed in the `ios` job in #57; the camera scan is verified on a device in M2-T34)
- owner: ios-engineer
- depends: M0-T6
- implements: docs/04-specification.md, F1 step 1, Input model (camera scan, EAN-13 and UPC-A)
- acceptance:
  - The scanner wraps VisionKit's `DataScannerViewController` for SwiftUI. It reads EAN-13 and UPC-A only, and runs on the device only.
  - `NSCameraUsageDescription` is localised in en and de through `InfoPlist.xcstrings`.
  - When scanning is not supported or not available (no camera, the simulator, permission denied), the screen offers the pick-list entry (M2-T22) and a link to Settings. It never offers a text field.
  - Normalisation: UPC-A becomes 13 digits with a leading 0, and the check digit is checked before any request. Invalid codes are ignored.
  - After the first valid code the scan stops, and it reports the code once.
  - Tests use a fake barcode source and cover valid and invalid codes, 12 and 13 digits, non-digits and duplicate reports.
  - Mac: the unit tests run in the `ios` job. The task ends `needs-mac-verification` until camera scanning passes on a device in M2-T34.

### M2-T14 Lookup and confirm flow
- status: done (built and tested by the macOS `ios` job in #59)
- owner: ios-engineer
- depends: M2-T8, M2-T11, M2-T13
- implements: docs/04-specification.md, F1 steps 2 and 3; docs/05-system-design.md, Barcode lookup; ADR 0005, ADR 0011
- acceptance:
  - A known barcode (`GET /barcodes/{barcode}`) shows the bean:
    - its verified state;
    - picked and operator attributes, with the operator's value winning;
    - the Open Food Facts name, brand and image, if present.
  - A 404 leads to `GET /barcodes/{barcode}/open_food_facts`. A 200 there shows:
    - name and brand as plain text (`Text(verbatim:)`, never markup);
    - the image through `GET /catalogue_images/{image_id}`;
    - a localised Open Food Facts attribution (ODbL).
  - Confirming sends `POST /beans` with the barcode, `open_food_facts_confirmed: true`, optional picks and the bundled `vocabulary_version`. Rejecting leads to the pick-list entry (M2-T22).
  - Other answers:
    - Open Food Facts 404: pick-list entry.
    - 409 from either route: `GET /barcodes/{barcode}` again, and use that bean.
    - 429: a localised "daily lookup limit reached" message, and pick-list entry offered.
    - 503: retry later, or pick-list entry.
  - The app never contacts Open Food Facts. A test asserts that the stub transport sees only the API host.
  - Tests cover every path with a stubbed client. Until M2-T18 the flow ends at the bean; from M2-T18 on it continues to the shelf entry.
  - Mac: the `ios` job.

### M2-T15 SwiftData local store
- status: done (built and tested by the macOS `ios` job in #58)
- owner: ios-engineer
- depends: M2-T1, M2-T7
- implements: docs/04-specification.md, Non-functional (Offline: "the device holds a full copy of the user's own data"); docs/05-system-design.md, Components (SwiftData local store)
- acceptance:
  - `@Model` types for cached beans, shelf entries, brews with ratings, recipes and the profile. Each holds:
    - a local id and an optional server id;
    - its `vocabulary_version`;
    - a sync state: synced, or pending create, update or delete;
    - its values as vocabulary ids, decoded through the `Vocabulary` types.
  - There is one store per account, keyed on the device by the token's `sub`. One account never sees another's data.
  - A `VersionedSchema` starts at 1, so later migrations are explicit.
  - The derived values are computed in one place:
    - ratio: `water_g` / (`dose_dg` / 10);
    - days since roast: from `roast_date` to `brewed_at`, in the device calendar.
  - Tests use an in-memory `ModelContainer`. They cover create, update, delete, brews newest first, ratio and days since roast across a time-zone change.
  - Mac: the `ios` job.

### M2-T16 Sync outbox and conflict rules
- status: done (built and tested by the macOS `ios` job in #59)
- owner: ios-engineer
- depends: M2-T8, M2-T11, M2-T15
- implements: docs/04-specification.md, Non-functional (Offline, Durability); ADR 0012 (brew counts, `WriteConflictError`); docs/07 D14; ADR 0017, Addendum
- acceptance:
  - An ADR (lead, ADR 0014) records the rules below, and docs/05 gets a short "Client sync" paragraph.
  - Every local write adds an outbox operation in the same SwiftData save. Operations go out in order, one at a time per account. That also avoids two of the user's own brew writes racing on one shelf entry (ADR 0012).
  - An operation that names a local id (a shelf entry's bean, a brew's shelf entry) waits until the referenced item has its server id, and is then rewritten with that id.
  - How each answer is handled:
    - 2xx: the server id and values are stored, and the operation is removed.
    - Network failure, 429 or 5xx: retried with exponential backoff and jitter.
    - 401: one refresh, then a retry. If the refresh fails, the user is asked to sign in, and the operations are kept.
    - 400: the operation is parked as failed and the item is flagged. It is never retried.
    - 404 on `DELETE`: counts as done.
    - 404 on `PUT`: the item is gone on the server, and the local item is removed.
    - 409 on a shelf `DELETE`: brews still reference the entry, so it is restored locally.
    - 409 on a shelf `PUT`: the bean change is reverted (D14).
  - Two devices editing the same item: the last write to reach the server wins, because `PUT` replaces the whole item and the contract carries no version. The next pull (M2-T17) shows the winner.
  - A create that fails ambiguously (sent, then no answer) is checked before it is retried. The client lists the resource and adopts a matching server item that has no local counterpart:
    - a brew: the same `shelf_entry_id` and `brewed_at`;
    - a shelf entry: the same bean and values;
    - a recipe: the same parameters.
    So a retry does not create a duplicate, with no contract change.
  - Sign-out stops the outbox. Nothing is sent with another account's token.
  - Tests cover each status rule, ordering, the rewrite across bean, shelf entry and brew, the adoption after an ambiguous create, and an outbox that survives a restart.
  - Mac: the `ios` job.

### M2-T17 Pull and reconcile
- status: done (built and tested by the macOS `ios` job in #60)
- owner: ios-engineer
- depends: M2-T16
- implements: docs/04-specification.md, Non-functional (Offline); docs/05-system-design.md, Persistence and recovery ("each phone keeps a full copy")
- acceptance:
  - A pull runs on sign-in, when the app comes to the foreground and after the outbox drains. It fetches, to the last page:
    - `GET /shelf`, `/brews` and `/recipes`;
    - `GET /profile`;
    - `GET /beans/{bean_id}` for each shelf bean that is not cached, and again for each unverified one.
  - The merge:
    - a server item with no local item is inserted;
    - a synced local item that the server no longer has is removed (deleted on another device);
    - an item with a pending operation keeps its local values until that operation is answered.
  - On a new device, an empty store ends with a full copy. The test uses 250 brews over three pages.
  - An item that fails to decode, for example one with an id from a newer vocabulary, is skipped and counted, not fatal.
  - Mac: the `ios` job.

### M2-T18 Shelf
- status: done (built and tested by the macOS `ios` job in #61)
- owner: ios-engineer
- depends: M2-T14, M2-T17
- implements: docs/04-specification.md, F1 step 5; docs/07 D14; ADR 0012
- acceptance:
  - From the M2-T14 and M2-T16 reviews: a 401 in the lookup flow shows a sign-in message instead of a generic retry; a parked or flagged item (400, 404-then-200, a reverted bean change, a restored delete, a rejected delete that is still `pendingDelete`) is shown with a way to redo or discard it; screens edit drafts and write through `AccountStore`; add a test that `BeanAttributeField` covers `API.BeanAttributes.propertyNames`; tighten the node check so Open Food Facts `name` and `brand` reach views only through `Text(verbatim:)`.
  - After a bean is found or confirmed, the user adds a shelf entry, which is saved locally and through the outbox. Its fields:
    - purchase date: a date picker, default today;
    - roast date: optional;
    - bag size and price band: pick lists.
  - The shelf list comes from the local store and works offline. Each row shows the bean (the Open Food Facts name and brand, or else its picked attributes), the roast date, days since roast and the brew count.
  - While brews reference an entry, its bean cannot be changed (D14) and the entry cannot be deleted. Both controls are disabled, with a localised reason.
  - Tests cover the mapping to `ShelfEntryInput`, the disabled states while the brew count is above 0, and days since roast.
  - Mac: the `ios` job.

### M2-T19 Brew form per method
- status: done (built and tested by the macOS `ios` job in #62)
- owner: ios-engineer
- depends: M2-T18
- implements: docs/04-specification.md, F2
- acceptance:
  - A brew is started from a shelf entry. The fields:
    - method: a pick list, required;
    - dose: a stepper from 5.0 to 100.0 g in steps of 0.1 g, sent as `dose_dg`;
    - water or yield: a stepper from 10 to 1,500 g;
    - temperature: a stepper from 80 to 100 °C, or `cold`, never both;
    - water type and milk: pick lists;
    - normalised grind: a stepper from 1 to 10 in half steps.
  - Everything except the method is optional. Every range comes from `Vocabulary.Ranges`, and none is written in the view.
  - The form shows the ratio and days since roast as values change. `brewed_at` is recorded on the device, and a save works offline through the outbox.
  - Tests cover the mapping to `BrewInput`, 18.5 g as 185, the exclusive temperature, the ratio formatting, and `vocabulary_version` equal to the bundled version. `scripts/check-no-free-text.sh` passes.
  - Mac: the `ios` job.

### M2-T20 Rating screen
- status: done (built and tested by the macOS `ios` job in #63; decisions in ADR 0026)
- owner: ios-engineer
- depends: M2-T19
- implements: docs/04-specification.md, F3
- acceptance:
  - Eight sliders from 1 to 10 in half steps, each with its criterion's question from contracts/i18n. A rating is saved only when all eight are set, because `Scores` requires them.
  - Optional intensity of acidity, body and bitterness, each low, medium or high (segmented).
  - Flavour notes in two levels, category then note. Up to `flavour_notes.max_picks` (5) can be picked, read from the vocabulary; further picks are disabled.
  - A buy-again toggle.
  - A brew can be rated straight after it is brewed, or later from the brew list (`PUT /brews/{brew_id}` through the outbox).
  - Tests cover the mapping to `Rating`, half-step snapping, the limit from the vocabulary constant, and that an incomplete set of scores cannot be saved.
  - Mac: the `ios` job.

### M2-T21 Brew timer
- status: done (built and tested by the macOS `ios` job in #64)
- note: from the review, the start instant lives only in memory, so a long timing (cold brew) is lost if iOS ends the app or the phone restarts. Persisting a wall-clock start is a possible follow-up after the M6 TestFlight round.
- owner: ios-engineer
- depends: M2-T19
- implements: docs/04-specification.md, Input model (Timer), F2 (brew time)
- acceptance:
  - Start, stop and reset. The elapsed time is measured from the start instant, so it keeps counting while the app is in the background or the phone is locked.
  - Stop fills `brew_time_s`, clamped to its vocabulary range.
  - The readout follows Dynamic Type, and VoiceOver announces start and stop and reads the elapsed time.
  - Tests use an injected clock: 30 s in the background counts as 30 s, and the clamp and reset work.
  - Mac: the `ios` job.

### M2-T22 Pick-list bean entry
- status: done (built and tested by the macOS `ios` job in #60)
- owner: ios-engineer
- depends: M2-T14
- implements: docs/04-specification.md, F1 step 4; ADR 0006, ADR 0011
- acceptance:
  - From the M2-T13 review: when the pick-list screen is pushed over the scanner, the camera must stop. Today a cancelled `.task` returns without `source.stop()`, so the camera would keep running off screen. Stop the source on cancellation (`withTaskCancellationHandler`) or in `.onDisappear`, with a test.
  - Pick lists for origin, species, process, variety and roast level (segmented). All are optional, and `other` and `unknown` are offered. In the origin list, regions are grouped under their country through `Vocabulary.Origin.country`.
  - There is no roaster list (ADR 0006) and no search field (`.searchable` is typed text, invariant 1).
  - Saving sends `POST /beans` with the bundled `vocabulary_version`, and the barcode if one was scanned.
    - 409: the app looks up the barcode's bean and uses it.
    - 400: shown as an error and not retried.
  - Tests cover the body with no picks and with all picks, with and without a barcode, and the region grouping.
  - Mac: the `ios` job.

### M2-T23 Label photo: JPEG on the device
- status: needs-mac-verification (the encoder tests pass in the `ios` job in #61; a real HEIC capture is verified on a device in M2-T34)
- owner: ios-engineer
- depends: M2-T22
- implements: docs/04-specification.md, F1 step 4; ADR 0016 (HEIC to JPEG on the device, at most 4096 px a side and 8 MiB); D12
- acceptance:
  - The label is photographed with the camera.
  - The capture is converted to a baseline JPEG through ImageIO:
    - the orientation is applied to the pixels;
    - the longest side is at most 4096 px;
    - the file is at most 8 MiB, lowering the quality until it fits;
    - it carries no EXIF, GPS or XMP properties.
    The server strips all metadata again (D12).
  - Tests draw their images in code:
    - 4032 × 3024 keeps its size;
    - 5000 × 3000 becomes 4096 px on its longest side;
    - the output starts with `FFD8` and is at most 8 MiB;
    - `CGImageSource` finds no EXIF or GPS dictionary;
    - an input with orientation 6 comes out rotated.
  - Mac: the conversion is tested in the `ios` job. The task ends `needs-mac-verification` until a real HEIC capture passes on a device in M2-T34.

### M2-T24 Label photo: presigned upload and completion
- status: needs-mac-verification (the unit tests pass in the `ios` job in #62; a real upload to dev is verified in M2-T34)
- owner: ios-engineer
- depends: M2-T23
- implements: ADR 0016; contracts/openapi.yaml, `createLabelPhotoUpload`, `completeLabelPhoto`
- acceptance:
  - For an unverified bean, the user adds up to 3 photos. Each one runs these steps:
    1. `POST /beans/{bean_id}/label_photos`.
    2. A `multipart/form-data` POST to `upload.url`, with every field under its S3 form field name (`key`, `bucket`, `Content-Type`, `Policy`, `X-Amz-*`) and `file` last.
    3. `POST /label_photos/{photo_id}/complete`.
  - The app uploads only to a URL that matches the contract's pattern (a `cupmark-` bucket in eu-central-1).
  - How each case is handled:
    - `expires_at` passed, or a 404 on completion: a new upload is started.
    - 400 on completion: the photo was rejected, and a retake is offered.
    - 409: no more photos for this bean.
    - 429: a "try again tomorrow" message.
  - After the 204 the photo file is deleted from the device. In this task an upload needs the network; queuing offline follows in M2-T25.
  - Tests cover the multipart layout (field names, `file` last, the boundary) and every status path, with a stub transport.
  - Mac: the unit tests run in the `ios` job. The task ends `needs-mac-verification` until a real upload to dev passes in M2-T34.

### M2-T25 Offline scan and pending beans
- status: done (built and tested by the macOS `ios` job in #63; decisions in the ADR 0025 addendum)
- owner: ios-engineer
- depends: M2-T18, M2-T24
- implements: docs/04-specification.md, Non-functional (Offline: "Scan, brew and rate work offline and sync later")
- note: from the M2-T24 review, `LabelPhotoUploadJob` must become `Codable` and live in the per-account outbox; a sign-out today deletes the account's not-yet-uploaded photos, which queued jobs must survive. Point the SyncHost tests at a temporary `LabelPhotoFolders` root.
- acceptance:
  - A barcode scanned offline is kept as a pending bean. It can be put on the shelf, and brews can be logged against it, at once.
  - When the device is back online, the outbox resolves the pending bean:
    - A barcode is looked up with `GET /barcodes/{barcode}`, then Open Food Facts.
    - A known bean is used, and a bean entered offline from pick lists is created, without asking.
    - An Open Food Facts hit needs the user's confirmation. The app asks the next time it is opened, and the operations that depend on the bean wait.
  - Label photos taken offline are queued, and upload once the bean has a server id.
  - Tests cover offline scan, shelf and brew, followed by each lookup result (known, hit confirmed, hit rejected, miss). In every case the brew ends up on the server under the right shelf entry.
  - Mac: the `ios` job.

### M2-T26 Brew form: method fields and grinder (vocabulary v3)
- status: done (merged in #74; the `ios` job built it and ran the schema migrations and the method rules tests)
- owner: ios-engineer
- depends: M2-T4, M2-T5, M2-T19
- implements: docs/04-specification.md, F2; the D13 decision (M2-T2)
- acceptance:
  - The form shows only the fields that the method allows under the generated rules (M2-T3). Changing the method clears fields that are no longer allowed.
  - A grinder pick list, including `pre_ground`. A grind setting stepper on the grinder's own scale, with the range and step from the vocabulary. The stepper is hidden for a grinder without a scale, and the normalised grind stays.
  - Editing an old brew keeps its `vocabulary_version`, unless the edit sets a field that only v3 has.
  - Tests:
    - for every method, the visible fields match the generated rules;
    - `BrewInput` never holds a disallowed field;
    - the grind setting stays within each grinder's scale.
  - Mac: the `ios` job.

### M2-T27 Recipes and one-tap repeat
- status: done (built and tested by the macOS `ios` job in #65; ADR 0028, ADR 0026 addendum M2-T27)
- owner: ios-engineer
- depends: M2-T20, M2-T21
- implements: docs/04-specification.md, F2 ("A brew can be saved as a recipe and repeated with one tap"); docs/03-project-brief.md, Goals (a repeat brew in under 30 seconds)
- acceptance:
  - A brew's parameters can be saved as a recipe (`POST /recipes`). Recipes can be listed, replaced and deleted, offline through the outbox.
  - A recipe has no name (invariant 1). It is shown by method, dose, ratio, temperature and grind.
  - One tap on a recipe, or on "repeat last brew", opens a new brew for the chosen shelf entry, prefilled and with the timer ready. Saving it goes on to the rating.
  - Tests:
    - a repeat gives a `BrewInput` with the recipe's parameters, a new `brewed_at` and the chosen shelf entry;
    - in the flow model, a repeat can be saved without any further input.
  - Mac: the `ios` job.

### M2-T28 Personal statistics
- status: done (built and tested by the macOS `ios` job in #65; the set is in ADR 0027)
- owner: ios-engineer
- depends: M2-T20
- implements: docs/03-project-brief.md, Tiers ("Own statistics and taste profile"); docs/04-specification.md, F2 and F3
- acceptance:
  - Before the task starts, the lead confirms the set of statistics under ADR 0014, because the spec does not list it.
  - The default set uses the F4 measures on the user's own brews:
    - brews in total and per week;
    - the mean per criterion, overall and per method (the taste profile);
    - the most-picked flavour notes;
    - the best-rated method and bean, by mean overall score;
    - the share of buy again.
  - The statistics are computed on the device from the local store and work offline. No new route.
  - Tests with fixture data cover the means, the empty state, and that unrated brews are excluded.
  - Mac: the `ios` job.

### M2-T29 Onboarding with consent (D1)
- status: done (built and tested by the macOS `ios` job in #66; ADR 0025 addendum M2-T29)
- owner: ios-engineer
- depends: M2-T1, M2-T11, M2-T16
- implements: docs/07 D1; ADR 0017 (opt-in); docs/03-project-brief.md, Risks ("Plain consent at onboarding; an opt-out that keeps the personal log working"); contracts `Profile`
- acceptance:
  - After the first sign-in, a 404 from `GET /profile` starts onboarding. It is a few intro screens, then a consent screen with a plain explanation and an explicit agree control. Not agreeing is the default, and skipping sends false.
  - Onboarding ends with `PUT /profile`, through the outbox when offline. It carries:
    - `locale`: de if the preferred language is German, else en;
    - `consent.contribute_to_aggregates`.
  - Onboarding is not shown again once a profile exists, locally or on the server.
  - Settings has the consent toggle. Turning it off keeps every personal feature working.
  - If M2-T1 decides for a local-only mode, onboarding offers it as decided there.
  - Tests cover a 404 leading to onboarding and a 200 skipping it, the false default, the locale mapping, and the toggle sending `PUT`.
  - Mac: the `ios` job.

### M2-T30 CSV export
- status: done (#67; built and tested by the macOS `ios` job. The share sheet and the temporary file are checked on a device in M2-T34)
- owner: ios-engineer
- depends: M2-T16
- implements: docs/03-project-brief.md, Tiers (export own data); docs/05-system-design.md, Security (Export); ADR 0017
- acceptance:
  - From the M2-T16 review: after an account is deleted on another device, this device keeps that account's store and outbox. Remove a store whose account can no longer sign in (for example on the tombstone 401), or offer it in a "remove local data" setting.
  - Settings, then Export:
    1. The app tries to drain the outbox. If changes are still pending, it says they are not in the file.
    2. It calls `GET /export`.
    3. It writes the bytes unchanged to a temporary `cupmark-export-<YYYY-MM-DD>.csv` and offers it with `ShareLink`.
    4. The file is deleted afterwards.
  - A 500 (an export over 5 MiB) and being offline each show a localised message.
  - Tests cover the request, the file name, the bytes written unchanged, and the error states.
  - Mac: the `ios` job.

### M2-T31 Account deletion
- status: done (#79; the macOS `ios` job built it and ran the deletion tests; a real `DELETE /account` against dev and the Keychain on a device are checked in M2-T34; ADR 0031)
- owner: ios-engineer
- depends: M2-T16
- implements: docs/04-specification.md, Non-functional (account deletion in the app); ADR 0017 and its Addendum; contracts `deleteAccount`
- note: from the M2-T24 and M2-T25 reviews, account deletion must also remove the account's `Application Support/LabelPhotos/<account>` folder, including its `Queued` label photos, together with the store.
- acceptance:
  - From the M2-T16 review: a 401 from the ADR 0017 tombstone signs the user out without a reason. Give `AuthModel` a way to show "this account was deleted or its session ended" when sync asks for sign-in.
  - Settings, then Delete account. Two steps confirm with buttons only, and they say what is deleted: the data, the label photos of unverified beans, and the sign-in.
  - The outbox stops, and nothing more is sent. The app refreshes the token, then calls `DELETE /account`.
  - 500, 429 and network failures are retried with backoff until a 204. The state "deletion in progress" is persisted and resumed after a restart. Until the 204, the user stays signed in.
  - Never sign out or discard tokens before a 204 (ADR 0017).
  - After the 204, the app deletes the local store, the outbox, the Keychain items and cached images, then signs out.
  - If the token cannot be refreshed before a 204, the user is asked to sign in again, and the deletion is retried with the new token. If Cognito had already deleted the user, the new sign-in is a new, empty account; deleting it again answers 204 and leaves nothing. The lead records this rule (ADR 0014).
  - Tests:
    - three 500s, then a 204: the app signs out exactly once, and the store is empty;
    - no sign-out on a 500;
    - the deletion resumes after a restart;
    - the refresh-failure path.
  - Mac: the `ios` job.

### M2-T32 Localisation pass (en, de)
- status: done (merged in #81; the macOS `ios` job ran the formatter, language rule and localisation tests; the timer readout is m:ss, h:mm:ss from an hour: decided and pinned; the German strings still want a native read in M2-T34)
- owner: ios-engineer
- depends: M2-T25, M2-T26, M2-T27, M2-T28, M2-T29, M2-T30, M2-T31
- implements: docs/04-specification.md, Non-functional (Localisation); docs/03-project-brief.md, In scope (German and English)
- note: from the M2-T19 review, the ratio's `1:` prefix is written in `BrewFormat.ratio`; move it to a catalogue format key if a locale writes ratios differently.
- acceptance:
  - `scripts/check-ios-strings.mjs` also checks `InfoPlist.xcstrings`: both languages, and `extractionState` manual. A test shows it failing on a missing language.
  - Numbers, units, dates and durations go through Foundation formatters in the device locale. Tests check "18,5 g" in de and "18.5 g" in en, the ratio, dates, and the timer as mm:ss.
  - Vocabulary labels use the same language rule as the profile locale (M2-T29), with en as the fallback.
  - A test resolves every `L10n` key in both languages.
  - Mac: the `ios` job.

### M2-T33 Accessibility pass
- status: done (#83; the macOS `ios` job passed on ca89c18, the audit findings are reported, not gated; M2-T34 reads the `AUDIT-ISSUE` lines in the job log and judges them on a device)
- owner: ios-engineer
- depends: M2-T32
- implements: docs/04-specification.md, Non-functional (Accessibility: Dynamic Type and VoiceOver on every control)
- acceptance:
  - A UI test target, `CupmarkUITests`, is in the `Cupmark` scheme's test action, so the `ios` job runs it.
  - The app has a launch argument, compiled only in Debug, that starts it with an in-memory store, fixture data and a stub API.
  - `performAccessibilityAudit()` runs at the default text size and the largest accessibility size on these screens: sign-in, scanner fallback, lookup result, pick-list entry, shelf, brew form, timer, rating, recipes, statistics, onboarding and settings. It reports its findings in the log (`AUDIT-ISSUE` lines) and does not fail the build: the owner decided on 2026-11-26 that the app needs the essentials (labels, values, 44-point targets, text that scales and nothing cut off), not a full accessibility certification. The remaining findings are judged on a device in M2-T34.
  - Every slider, stepper and pick list has a VoiceOver label and value, for example "Aroma, 7.5 of 10". Scores and steppers support the adjustable action.
  - Mac: the `ios` job. The VoiceOver walk-through on a device is in M2-T34.

### M2-T34 Device run against dev
- status: todo
- owner: human
- needs: human. On a device, with a TestFlight build (M2-T12) or a build from Xcode, and a test Apple ID, the owner runs the flow below and reports the result on the task's issue.
- depends: M1-T7, M2-T10, M2-T12, M2-T33
- implements: docs/03-project-brief.md, Goals; docs/04-specification.md, F1 to F3 and Non-functional
- acceptance:
  - From the M2-T13 review: confirm the camera starts on the first appearance of the scanner (`startScanning()` is called from `updateUIViewController`), and that UPC-A bags arrive as 13 digits under `.ean13`.
  - The flow passes:
    1. Sign in.
    2. Scan one known and one unknown barcode, and confirm an Open Food Facts hit.
    3. Enter a bean from pick lists with a camera label photo.
    4. Add a shelf entry.
    5. Brew with the timer, then rate the brew.
    6. Repeat a recipe.
    7. Log a brew in flight mode, then let it sync.
    8. Export the data.
    9. Delete the account. The app signs out only after the deletion succeeds, and signing in again shows an empty account.
  - A VoiceOver and largest-text walk-through of the main flow passes.
  - When their parts pass, M2-T11, M2-T13, M2-T23 and M2-T24 move from `needs-mac-verification` to `done`.

### M2-T38 Companion page: overview, tester call, terms and privacy (draft in the repo)
- status: done (the draft is in `site/`; publishing is M2-T39)
- owner: lead
- depends: M2-T29
- implements: docs/07-open-questions.md D1, D2, D10, D11, D12; issue #37
- acceptance:
  - `site/index.html` (English) and `site/de/index.html` (German) with the sections overview, become a tester, privacy policy and terms of use, and `site/style.css`.
  - Static only: no script, no form, no font or file loaded from another host, no analytics (invariant 7). A test (`scripts/site.test.mjs`) keeps it so, and keeps the two languages in step.
  - The privacy text follows the decisions: opt-in contribution (D1), subtraction on deletion (D2), photo deletion (D10), backups of 35 days and about 13 months with the deletion log (D11), metadata stripped (D12), EU region, no name and no email, no tracking, two weeks of server logs. It is marked as a draft.
  - Open items are marked `TODO` in the page and listed in M2-T39: operator name and address, contact email, publication date, TestFlight link, governing law and Impressum.

### M2-T39 Publish the companion page at derschweigert/cupmark
- status: blocked (needs the owner)
- owner: human
- needs: human. The page lives on the owner's existing DerSchweigert site, which this repo must not touch (CLAUDE.md invariant 9: no change to any resource this repo did not create, no new Route 53 zone). So the owner copies `site/` into the DerSchweigert site themselves, from their own checkout, and deploys it there.
- depends: M2-T38
- acceptance:
  - The owner fills in every `TODO` of the page (operator name and address, contact email, publication date, TestFlight link, what the host of the page logs, governing law, Impressum) and has a lawyer review the privacy text and the terms, in particular the liability clause (issue #37, issue #38 for the Open Food Facts licence).
  - The page is reachable at derschweigert/cupmark with its German version. The relative links `de/` and `../` still work at that path.
  - The URL (with `#privacy`) is entered as the privacy policy URL in App Store Connect before App Review. TestFlight external testing also asks for it.
  - If the owner would rather have a Cupmark-owned site (S3 and CloudFront named `cupmark-`), that is a cost and DNS decision: ask first, record an ADR.
  - When M4 adds the paid tier, its terms are added to the page first.

### M2-T40 Back from a brew's rating shows an empty screen with a warning triangle
- status: needs-mac-verification (found on a device by the owner; the fix and its UI test first run in the `ios` job)
- owner: ios-engineer
- depends: M2-T20
- acceptance: the brew list is pushed and the rating is pushed with destinations registered at the stack root; back from a rating shows the brew list; a UI test covers it; no other pushed destination registers a value destination inside a pushed view.
- Mac: the `ios` job; the owner re-checks on the device in M2-T34.

### M2-T41 The coffee look: palette, named colours and warmer headings
- status: done (#89; the macOS `ios` job passed on d8015e3, including the contrast tests; the look on a device is judged by the owner)
- owner: ios-engineer
- depends: M2-T40
- implements: owner decision of 2026-11-26 ("the taste looks good"); docs/04-specification.md, Non-functional (Accessibility: Dynamic Type); docs/03-project-brief.md, Goals
- note: the owner accepted the lead's proposal: a warm espresso-brown accent colour (a lighter caramel variant in dark mode), cream backgrounds behind forms and lists in light mode and a dark-roast brown in dark mode, rating sliders and scores in the accent colour, slightly warmer heading styles on system fonts. The app icon stays the placeholder bean; it is redrawn later and is not part of this task. If this task turns out larger than one pull request, split the colour sets and the ADR from the screen changes.
- acceptance:
  - An ADR (lead, ADR 0014) records the palette: each colour's name, its light and dark value, and the contrast ratio it was checked at. Text on its background passes WCAG AA (4.5:1; 3:1 for large text and for the slider track and thumb). The ADR is written before the colour sets.
  - All colours are named colour sets in `ios/Cupmark/Assets.xcassets`, each with a light and a dark (`appearances`) value: at least `AccentColor` (espresso brown; caramel in dark), `FormBackground` and `ListBackground` (cream; dark-roast brown in dark), and any surface or secondary colour the ADR names. The set names are the only place a colour is defined.
  - Screens read colours only through these names (the asset's generated symbols or one `Theme` file). No `Color(red:`, `Color(white:`, `UIColor(red:`, hex literal or system colour used as a brand colour remains in a screen. A static check in `scripts/` (run by the `ios` job and `npm test` alongside the other script checks) fails on such a literal outside the `Theme` file, with a test that shows it failing on a fixture that has one.
  - Forms and lists use the cream and dark-roast backgrounds (`scrollContentBackground(.hidden)` with the named background). Rating sliders, scores and the selected state of pick lists use the accent colour. Headings use a slightly warmer style by weight and design (for example `.rounded` design for titles) on system fonts only: no bundled or downloaded font, so Dynamic Type works unchanged.
  - A unit test reads each named colour set from the asset catalogue JSON and checks the contrast of every text and background pairing the ADR lists, in both appearances, against 4.5:1 (3:1 where the ADR says large text or a control). It fails when a value is changed to a failing one.
  - The accessibility static checks (`scripts/check-ios-accessibility.mjs`) still pass. The UI test audits (M2-T33) still run on every screen at both text sizes and still only report; this task does not turn them into a gate. The findings count in the job log does not rise compared with the previous run on `main`.
  - No new dependency, no third-party SDK (invariant 7), no text typed by the user (invariant 1).
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes; the look on a device is judged by the owner in M2-T34.

### M2-T42 Brew photos: the local model, the files and their deletion
- status: done (#90; the macOS `ios` job passed, including the migration from a real version 3 store)
- owner: ios-engineer (run on the opus model: it touches `ios/Cupmark/Store`)
- depends: M2-T40, M2-T31, M2-T23
- implements: owner decision of 2026-11-26 (brew photos stay on the device); docs/05-system-design.md, Security and Data (local store); docs/04-specification.md, Non-functional (account deletion in the app); ADR 0030 (how a local schema version is added); ADR 0031 (the account deletion cleanup, point 6); invariants 1 and 6
- note: from the owner's decision: stored on the device only. Nothing is uploaded, nothing goes to the CSV export, there is no cloud cost and no change to the App Privacy answers. No captions or any typed text (invariant 1): a photo has no title, no note. No endpoint, no contract change, no outbox operation. If this task turns out larger than one pull request, split the schema and the store API from the cleanup paths.
- acceptance:
  - An ADR (lead, ADR 0014, like 0030) records: local schema version 4 with one new model, `StoredBrewPhoto`; a lightweight stage from version 3; photos are files in `Application Support/BrewPhotos/<account id>/` (next to `LabelPhotos`, one folder per account like the store, ADR 0020); a photo is linked to its brew by the brew's `localID` (a `UUID` attribute, no SwiftData relationship, so `StoredBrew` and its hash do not change); an iCloud device backup includes the files, so they are not excluded from backups, in contrast to the label photos, and the privacy text says nothing contrary; files are written with `.completeFileProtection` like the label photos.
  - `CupmarkSchemaV4` lists version 3's models unchanged plus `StoredBrewPhoto` (`localID` unique, `brewLocalID`, `fileName`, `createdAt`; no `serverID`, no sync state, no `vocabularyVersion` since it holds no vocabulary value). `CupmarkMigrationPlan` gets the lightweight stage 3 to 4, and the typealiases move. `StoredBrewPhoto` is not part of any API type, the outbox or the CSV export.
  - A brew holds up to 6 photos (`BrewPhotoLimits.maxPerBrew = 6`). Adding a seventh is refused with a typed error and writes no file and no record.
  - Metadata is stripped on the device by reusing `LabelPhotoEncoder` (orientation applied to the pixels, a fresh bitmap, only the allowed JPEG segments). It is called with its own `Limits` value for local photos (a smaller longest side and file size than the upload limits, named in the ADR). A test encodes a fixture with EXIF, GPS and TIFF segments and checks that none of them is in the stored file.
  - `AccountStore+BrewPhotos`: `addBrewPhoto(to:jpeg:)` (writes the file, then the record in one `write { }`; a failed save removes the file), `brewPhotos(of:)` newest first, `allBrewPhotos()` newest first, `deleteBrewPhoto(_:)` (record and file), and a file URL lookup by record. A photo whose file is missing is reported, not a crash.
  - Deleting a brew deletes its photos: every path that removes a `StoredBrew` from the device (the user's delete, a pull that drops a brew deleted on another device, discarding a sync issue that removes the brew) also deletes its records and files. A test per path.
  - An orphan sweep at store open: records whose brew is gone, and files in the account's folder that no record lists, are deleted. Tests cover both.
  - Account deletion removes all of them: the cleanup after the 204 (ADR 0031, point 6) also deletes `BrewPhotos/<account>/` for each listed account, before the sign-out, and is safe to repeat. "Remove Data of Other Accounts" (M2-T30) removes the other accounts' brew photo folders. A test proves that after a deletion run, with brews that hold photos, no file and no folder of `BrewPhotos` is left for the account, and a second run changes nothing. Signing out alone keeps the photos with the account's store, as it keeps the store (ADR 0020).
  - Tests: the migration from a real version 3 store file to version 4 keeps every brew and adds an empty photo list (in `StoreMigrationTests`); the limit of 6; delete one photo; delete a brew; the sweep; the account cleanup; the encoder strips metadata. `StoreFixtures` ids stay valid ULIDs.
  - Privacy manifest: any file API the new code uses is checked against the required-reason list. File timestamps are already declared with C617.1; the task states in the ADR whether anything else (disk space, user defaults, system boot time) is used, and adds an entry only if it is. `scripts/check-no-free-text.sh` passes.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T42b Brew photos: take or pick a photo on a brew
- status: done (#93; the macOS `ios` job passed on 579be04, including the UI tests; the real camera and picker are checked on a device in M2-T34)
- owner: ios-engineer
- depends: M2-T42
- implements: owner decision of 2026-11-26 (brew photos); docs/04-specification.md, F2 (brew log); invariants 1 and 7
- acceptance:
  - On a brew (the rating screen from M2-T20 and the brew list's detail), a "Photos" section shows the brew's photos as small thumbnails with a control to add one. Two ways, both optional: take a picture with the camera (reusing `LabelPhotoCamera` and its availability check; the step is hidden without a camera, and a denied permission shows the Settings link as for label photos), or pick one from the photo library with the system picker (`PhotosPicker`, out of process, so no photo library permission and no `NSPhotoLibraryUsageDescription`). No captions or any text field (invariant 1). No third-party SDK.
  - A capture or a pick is encoded off the main actor by the M2-T42 store API (metadata stripped). A failure (unreadable image, too large, the limit of 6) shows a localised message and keeps the brew as it was. When the brew has 6 photos the add control is disabled and says why.
  - A photo can be deleted from the brew's section with a confirmation; deleting it deletes the file.
  - The camera usage description in `InfoPlist.xcstrings` (en and de) and the matching `INFOPLIST_KEY_NSCameraUsageDescription` in `project.pbxproj` also say that the camera photographs a brew. `scripts/check-ios-strings.mjs` still passes. The ADR of M2-T42 or a short note records that the photo picker needs nothing else and that the privacy manifest needs no change (checked against the required-reason APIs).
  - The companion page (`site/index.html` and `site/de/index.html`) gets one added sentence in the privacy text: brew photos stay on the device and are never uploaded. `scripts/site.test.mjs` is updated so that the sentence is required in both languages and the two pages stay in step. The page remains a draft owned by the owner for publishing (M2-T39); this task only edits the repo files.
  - Every control has a VoiceOver label and value through the localisation catalogue (for example "Brew photos, 2 of 6"), and the 44-point targets and Dynamic Type hold; the static accessibility checks pass.
  - Tests: unit tests of the section's model with a fake camera environment and a fake picker result (add, limit, failure, delete with confirmation); a UI test with the harness (M2-T33) that adds a fixture photo to a brew through a debug-only stub of the picker, sees the thumbnail, and deletes it.
  - Mac: the `ios` job; the camera and the real picker are checked on a device in M2-T34. Marked `needs-mac-verification` until the job passes.

### M2-T43 Brew photo gallery from the shelf, with pick-list filters
- status: done (#97; the macOS `ios` job passed on 1e9ab07, including the gallery UI test and the strengthened navigation test)
- owner: ios-engineer
- depends: M2-T42
- implements: owner decision of 2026-11-26 (photo browsing); docs/04-specification.md, F2; M2-T40 (the route registration rule); invariant 1 (no search box)
- note: M2-T42b is where photos are added in the app; the gallery is built and tested with fixture photos, so it does not wait for it, but merging it first lets the owner try both together.
- acceptance:
  - A toolbar button (or a row) on the shelf screen opens the gallery: a grid of all brew photos of the account, newest first (the store's `allBrewPhotos()`), with an empty state. The grid uses adaptive columns (`GridItem(.adaptive(minimum:))`) so Dynamic Type and the width change the column count; at the largest accessibility size it is one column.
  - Filters are pick lists only: method (from the vocabulary) and bag (the user's shelf entries, shown by bean attributes and purchase date like the rest of the app). No search box and no text field (invariant 1). A filter can be cleared. Filtering changes the grid and its count in the VoiceOver value.
  - Each photo's accessibility label is built from method, bag and date through the localisation catalogue with formatters (no typed text), for example "Espresso, Ethiopia washed bag, 12 Nov 2026". `scripts/check-ios-strings.mjs` passes (en and de).
  - Navigation: the gallery is reached by a value route registered at the stack root with the other routes in `ShelfScreen.swift` (or a file added to the allow-list on purpose, with the reason in a comment). Photos load as downsampled thumbnails off the main actor, not the full file in the grid.
  - From the M2-T40 review: strengthen the static test for navigation destinations. Every type `X` used in `NavigationLink(value: X(...))` anywhere in `ios/Cupmark` must have a matching `navigationDestination(for: X.self)` in the allowed files. A test of the check shows it failing on a fixture with a link whose type has no destination, and passing when the destination exists. The allow-list stays `Shelf/ShelfScreen.swift` and `Brew/BrewRoutes.swift`, plus a file added here only on purpose.
  - Tests: unit tests of the gallery model (order, each filter alone and both, clear, empty, photos of another account never shown, the VoiceOver label parts in en and de); a UI test with the harness (M2-T33) that opens the gallery from the shelf with fixture photos, applies a method filter, and sees the count change.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T43b Brew photo viewer: details, links back and delete
- status: done (#98; the macOS `ios` job passed on 79f7e05, including the viewer unit and UI tests)
- owner: ios-engineer
- depends: M2-T43
- implements: owner decision of 2026-11-26 (photo browsing); docs/04-specification.md, F2; M2-T20 (the rating screen), M2-T27 (recipes and `AccountStore.recipe(matching:)`)
- acceptance:
  - Tapping a photo in the gallery opens a viewer by a value route registered at the stack root with the others (the static test of M2-T43 passes). It shows the photo full size and the brew's key details: method, dose, ratio, temperature, grind, and the overall score if rated, formatted in the device locale.
  - Links from the viewer:
    - to the brew: its rating screen from M2-T20 (`BrewRatingRoute`), which the brew list also uses;
    - to its bag: the shelf entry screen (`ShelfEntryRoute`); no link when the brew has no shelf entry;
    - to the recipe: a brew does not store which recipe it came from, so the link shows the saved recipe whose parameters equal the brew's, found with `AccountStore.recipe(matching:)` (parameters conformed to the method rules, as for saving a recipe). When no saved recipe has those parameters the link is not shown; there is no "create recipe" here.
  - A photo can be deleted from the viewer, after a confirmation with buttons only. It deletes the file and the record, returns to the gallery, and the grid updates. Deleting does not touch the brew.
  - VoiceOver: the image has the same label as in the grid; the links and the delete button have labels; the viewer works at the largest text size (the details scroll), and a drag or pinch is not the only way to anything.
  - Tests: unit tests of the viewer model (details, the three links present and absent, the recipe match by parameters and no match, delete); UI tests with the harness for each link (brew, bag, recipe) landing on the right screen, and for delete with its confirmation.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T44 My averages for one coffee: the dimensions over all my brews of it
- status: done (#100; the macOS `ios` job passed on 6e65d8d, including the averages unit and UI tests)
- owner: ios-engineer
- depends: M2-T28, M2-T40
- implements: owner request of 2026-11-26 ("if I click on a coffee, I want to see the averages of all my brews, the dimensions, for that coffee, and later also the community ones"); docs/04-specification.md, F2 and F3; ADR 0027 (personal statistics, computed on the device)
- note: ADR 0027 gives the taste profile overall and per method, but not per shelf entry. This task adds that view. "A coffee" is a line item on the user's shelf (a shelf entry, one bag), as the owner clarified on 2026-11-26, so the averages cover the brews of that one entry, not every bag of the same bean. The screen says how many rated brews it rests on. No cloud cost: computed on the device from the local store, offline, like the other statistics. The community numbers come with M4 and are not part of this task, but the screen is laid out so they can sit next to the user's own. Note for M4: community aggregates are per bean, so they sit next to the user's averages as "this bean, all raters" while the user's own numbers are for this bag. A view of all of the user's bags of one bean can be added later if wanted (not part of this task).
- acceptance:
  - Tapping a line item on the shelf opens its screen (the shelf entry screen, as today, with Brews, the bean and the bag); it gains a "My brews of this coffee" section: the mean of each rating criterion (the dimensions from the vocabulary, in their vocabulary order) over the rated, not removed brews of that shelf entry, plus the mean overall score and the number of rated brews. One decimal, device locale. An optional breakdown by method, shown once a method has at least 2 rated brews (the same threshold as ADR 0027).
  - The rule set is added to ADR 0027 as an addendum (lead, ADR 0014) and to docs/04 and ios/README.md: which brews count (rated, not removed, of this shelf entry), the threshold, the rounding, the empty state ("Rate a brew to see your averages here", no zeros), and what a single rated brew shows (the values, labelled as one brew, no "average").
  - The averages come from one function in the statistics code (`StatisticsRules`), with tests on fixtures: brews of two shelf entries of the same bean (each entry counts only its own brews); a removed brew; an unrated brew excluded; a brew rated with an older vocabulary version (read-only, still counted); one rated brew; none; the order of the dimensions; the method breakdown threshold.
  - The view shows the dimensions as rows with the value and a simple bar (no chart library; SwiftUI shapes in the theme's accent colour). VoiceOver reads "Aroma, 7.5 of 10" through the existing value formatting; 44-point targets and Dynamic Type hold; strings through the catalogue (en and de).
  - The layout leaves room for a second value per dimension (the community mean and its number of raters, M4): the row's model has an optional community value and the view hides it while it is nil. No server call and no contract change here.
  - Tests: unit tests of the rules and the row model; a UI test with the harness (M2-T33) that opens a shelf entry with brews and sees the dimension rows and the count.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T45 A setting: include brew photos in the device backup
- status: done (#99; the macOS `ios` job passed on acac882, including the resource-value tests)
- owner: ios-engineer
- depends: M2-T42, M2-T42b
- implements: owner decision of 2026-11-26 ("the iCloud backup should include the photos if the user wishes, to be toggled in the options"); ADR 0033 (brew photos on the device; its first version left them in the backup, as iOS does by default); invariant 6 and the privacy policy (nothing leaves the device on our initiative)
- decision (lead, ADR 0014, no cloud cost; the owner can flip the default in one line): the default is OFF. The app's promise is that brew photos stay on the device, and an iCloud device backup copies them to Apple. The user turns it on in Settings, with a footer that says what each state means. The setting is per device and is not synced to the server (it is not part of the profile, so no contract change).
- acceptance:
  - Settings gets a toggle "Include brew photos in the device backup" (en and de, through the catalogue) with a footer: off, brew photos stay on this phone only and are not restored from a backup when the phone is replaced; on, they are included in the backup of this phone that the user already has with Apple (iCloud or a computer). Default off. 44-point target, a VoiceOver label and value (on, off), the theme's accent tint on the toggle.
  - The setting is applied by `isExcludedFromBackup` on the per-account `BrewPhotos/<account>/` folder (and every file inside, so a photo that moved or was written earlier follows), set again whenever a folder is created, when the setting changes, and at store open (so a restored install or an older folder that was backed up before the setting existed is corrected). Excluded is the default state for a new folder. A test with a temporary folder checks the resource value for both states, for a new photo written after the change, and that the sweep and the account deletion are unaffected.
  - Where the setting is stored: the simplest robust choice for a per-device flag (for example `UserDefaults` with its required-reason entry `CA92.1` added to `PrivacyInfo.xcprivacy`, with the privacy manifest test of #84 extended, or a field in the local store if that is cleaner; say which in the ADR addendum). Not in the profile and not sent to the server.
  - ADR 0033 gets an addendum: the default off, what the backup contains in each state, and that nothing changes for the other app data (the store and label photos keep their current backup behaviour, unchanged by this task).
  - The companion page (`site/index.html` and `site/de/index.html`) says in the privacy text: brew photos stay on the device and are not uploaded; if the user turns on the backup setting, Apple includes them in the backup of that phone (iCloud or a computer), which is Apple's service under Apple's terms. `scripts/site.test.mjs` requires the sentence in both languages. docs/04 gets a line.
  - Tests: unit tests of the setting and its application; a UI test with the harness (M2-T33) that opens Settings and flips the toggle, seeing its value change.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T46 Reference recipes: the dataset from the owner's table
- status: done (the set and its converter are in the repo; tests run in CI)
- owner: lead
- depends: M2-T4 (vocabulary v3)
- implements: owner request of 2026-11-26 (a table of recipes as the basis for the community section); ADR 0034
- acceptance:
  - `scripts/reference-recipes/convert.mjs` reads the owner's table (not in the repo) and writes `contracts/reference/recipes.v1.json`: method ids and the numeric v3 parameters, `inferred` lists, typical ranges per method; no name, link, text, bean, flavour or rating.
  - Rules as in ADR 0034: only the methods the vocabulary has, unclear water bases and out-of-range rows dropped, duplicates collapsed, missing numbers from the method's median and marked inferred, grind words mapped, no jitter, no ratings.
  - `scripts/reference-recipes.test.mjs` (in CI) tests the rules on synthetic rows and the committed set against vocabulary v3.

### M2-T47 Starting-point recipes in the recipe list
- status: done (#101; the macOS `ios` job passed on 32071f3, including the starting-point unit and UI tests; the owner confirms the rights to the compiled table before a release)
- owner: ios-engineer
- depends: M2-T46, M2-T27
- implements: ADR 0034 (reference recipes), ADR 0028 (recipes); owner request of 2026-11-26
- needs: human before a release: the owner confirms the rights to the compiled table (ADR 0034, point 3). Development and TestFlight builds can use the set.
- acceptance:
  - The recipe list gets a "Starting points" section (reference recipes, bundled as a resource from `contracts/reference/recipes.v1.json`, no network, no cost), by method, labelled as reference recipes from published sources, never as community data and never counted as raters. The wording is in the catalogue (en and de).
  - Tapping a starting point shows its numbers (dose, water, ratio, temperature, time, grind) with the inferred ones marked; one action copies it into the user's own recipes (the existing save path of M2-T27, no name, one tap to brew from it). A copied recipe is an ordinary recipe and syncs like one.
  - Only starting points of methods the user can brew are offered, and a recipe whose fields the method's rules do not allow is not shown (the same field rules as the brew form).
  - Typical ranges per method are available to the app for the paid Explore screens (M4) with the label "reference"; not shown to free users in this task.
  - The bundled set is checked in CI against vocabulary v3 (the Node test of M2-T46) and by a unit test that decodes it in the app; a newer vocabulary version needs a regenerated set.
  - VoiceOver labels and values, 44-point targets, Dynamic Type, theme colours, no free text.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

### M2-T48 Averages in context: markers on the rating sliders, a summary at the top of the coffee, averages on the brew list
- status: done (#103; macOS run green, reviewer approved)
- owner: ios-engineer
- depends: M2-T44, M2-T20
- implements: owner feedback of 2026-11-26 after testing the TestFlight build ("I would want the community ratings and my ratings to be visible as an indication on the slider or right next to where I look at my things, rather than having to scroll down and lose the context"); M2-T44 (the averages of one coffee), ADR 0027 addendum
- decisions (owner, 2026-11-26): the averages appear (1) on the rating sliders, (2) at the top of the coffee's screen, (3) on the brew list rows; on the sliders the marker is shown only after the user has moved that slider (so the average does not anchor the rating); it is for comparison afterwards.
- note: the community numbers do not exist before M3 and are paid beyond the overall score (M4); this task shows the user's OWN averages and leaves the community slot (optional value, hidden while nil) where M4 attaches the community mean. Anchoring is the reason for "after the slider has been moved".
- acceptance:
  - **Rating sliders** (`RatingScreen`): each criterion slider gets a marker (a small tick or diamond in a Theme colour distinct from the thumb, never the system blue) at the mean of the user's OTHER rated, not removed brews of the same shelf entry (the brew being rated is left out), with its number next to the slider ("Your average for this coffee 7.5"), only once the user has set a score for that criterion in this rating, and only when at least one other rated brew has that criterion. Editing an existing rating shows the markers at once (the score is set). The marker updates when the user moves the slider no further (it is a fixed average, not the live score). It never changes the slider's value or behaviour.
  - A community marker slot: the same row model gets an optional community value (mean and number of raters), drawn as a second marker with its own label while non-nil and hidden while nil (M4; free users see only the overall, ADR 0027 addendum and M4 scope). No server call, no contract change here.
  - **Top of the coffee screen** (`ShelfEntryEditorScreen`): a compact summary row at the very top for a stored entry with rated brews: the mean overall score and the number of rated brews ("Overall 7.4, rated brews 3"), a tap scrolls to or expands the dimension section of M2-T44 (which stays as it is). Empty and one-brew states as in M2-T44, no zeros.
  - **Brew list rows** (`BrewListScreen`): each rated row shows its own overall score and, next to it, the coffee's average overall ("avg 7.4") so a brew is read against the others at a glance; unrated rows show neither; one rated brew shows no average.
  - All numbers come from the existing pure function `StatisticsRules.coffeeAverages` (extend it with an "excluding this brew" parameter; no second implementation) and are tested with fixtures: the brew being rated is excluded; a removed brew; an unrated brew; an older vocabulary version; two bags of the same bean (each own brews only); one other rated brew; none.
  - VoiceOver: the slider keeps its label and value ("Aroma, 7 of 10"); the marker is one extra element or the slider's hint, read as "Your average for this coffee, 7.5 of 10", available after the score is set; the summary row and the brew list averages have labels and values; 44-point targets, Dynamic Type (marker labels stack or move under the slider at accessibility sizes), colours only from Theme, strings through the catalogue in en and de (no plural forms), no typed text.
  - Tests: unit tests of the pure function change and of the rating model's marker state (hidden before the score is set, shown after, shown when editing, excluded brew); UI tests with the harness (M2-T33, Debug-only) for the marker after moving a slider, for the summary row, and for the brew list averages. The strengthened navigation test stays green.
  - Mac: the `ios` job. Marked `needs-mac-verification` until it passes.

## M3 Aggregation

Goal: aggregates per bean and per method stay correct under create, edit, delete and replay. Not yet planned.

Scope: stream aggregator, rater markers, recipe histogram buckets, nightly rankings job, 5-rater threshold, one-rating-per-user-bean-day rule, weekly export to S3, load test of the aggregator with replayed records.

## M4 Paid tier

Goal: subscribers see Explore; free users see the give-to-get teaser. Not yet planned.

Scope: StoreKit 2 purchase and restore, transaction verification, App Store Server Notifications route, entitlement on the profile, paid API routes, Explore screens (bean page, method breakdown, top recipes, rankings), paywall; the community mean and number of raters per dimension appear next to the user's own averages on the shelf entry screen of M2-T44, labelled as the bean's community numbers and as a second marker on the rating sliders of M2-T48 (shown after the user has set their own score, so it does not anchor the rating) (free users see the community overall only for beans they rated, the rest is paid); the privacy manifest gains a purchase-history entry when StoreKit 2 lands (from the review of #84).

## M5 Hardening

Goal: ready for strangers. Not yet planned.

Scope: App Attest, per-user write caps, budgets and alarms, operator CLI for the review queue and catalogue curation, restore drill from point-in-time recovery and from the S3 export, privacy review, performance against the 300 ms target, Swift 6 readiness (about 55 warnings today, mostly SwiftData `#Predicate` key paths that are not `Sendable`, plus test and sync isolation warnings).

From M1-T4d (ADR 0016, D10): the operator CLI reads label photos from `labels/<photo_id>.jpg` (it needs `s3:GetObject` on `labels/*`) by following the bean's `PHOTO#` items. On verification it copies the photo to `verified/`, where it expires after 90 days, and removes the user-side `PHOTO#` link, so the verified photo is no longer tied to the user.

## M6 Launch

Goal: TestFlight, then App Store. Not yet planned. Mostly human tasks.

Scope: App Store listing, screenshots, privacy nutrition labels, privacy policy and terms, TestFlight round with the persona interviews, production deployment, launch checklist.

### M2-T35 Failed saves put edited fields back
- status: done (built and tested by the macOS `ios` job in #64; ADR 0025 addendum M2-T35)
- owner: ios-engineer
- depends: M2-T25
- implements: docs/04-specification.md, Non-functional (Durability: no loss of a confirmed write, and no write sent that was not confirmed); ADR 0025
- acceptance:
  - From PR #63: `ModelContext.rollback()` does not restore an attribute changed on a model that was already saved. The rating write now keeps a `BrewRatingSnapshot` and puts the fields back itself.
  - Do the same at every other `rollback()` after an edit of a saved model: `ShelfEntryEditorModel`, `BrewFormModel`, `SyncIssuesModel` (redo, discard), `Puller` and `AccountStore.save()`. Otherwise a failed edit stays in memory with no operation queued, and the next unrelated save stores it without ever sending it.
  - From the M2-T25 round 2 review, the M2-T25 sites too: `describePendingBean` and `skipDescription` (AccountStore+PendingBeans.swift), the existing-bean branch of `addOfflineBean`, `settleQuestion`, and `askForDescription` (SyncEngine.swift). Today a failed describe leaves `create` in memory, and a retry deletes the queued photo and reports success. Correct the comment in PendingBeanConfirmation.swift that says `save()` rolled the change back.
  - Also from that review:
    - moving the last shelf entry off a pending bean (ShelfEntryEditorModel) drops the bean as `markDeleted` does, so a bean waiting for an answer cannot stay in the outbox forever;
    - `BeanEntryModel` never calls `createBean` while `describing` is set, even without an offline store;
    - add tests that a failed `.addScanned` save leaves nothing behind and that a parked dependency does not loop.
  - From PR #63: some `StoreFixtures` ids are not valid contract ids (`shelfEntryID` has an `L`, `recipeID` an `I`), so the engine parks any operation that names them. Make every fixture id a valid ULID.
  - Prefer one shared mechanism in `AccountStore` (for example, a write that snapshots the changed models' sync state and fields and restores them on failure) over a snapshot per screen.
  - Each site has a test like `RatingTests.testAFailedSaveLeavesNothingBehind`: a write that throws after changing a saved model leaves the model as it was and queues nothing.
  - Mac: the `ios` job.

### M2-T36 Harden the failed-write mechanism
- status: done (#66; the macOS `ios` job passed on 6574b43, including the real save-failure test)
- handover (2026-11-26, lead): `FailedWriteTests.testASaveThatFailsInTheStoreUndoesADeletionWithRelationships` fails at line 509, every run since `d7df43e`.
  - The setup is now deterministic. The store is written, the writable container is released, the store is copied, its WAL is checkpointed with `sqlite3_wal_checkpoint_v2`, and the copy is opened with `allowsSave: false`. Part 1 passes: a deleted brew is restored.
  - Part 2 deletes a scanned bag's shelf entry and, with it, its pending bean. The real `ModelContext.save()` fails (Code 513). After `discardUnsavedChanges()`, `store.bean(localID: pendingBeanID)` returns nil, although no inserted or deleted models are left and the following assertions pass.
  - So SwiftData's rollback after a real failed save does not bring back a deleted model whose inverse relationship was also deleted. The repair pass (`AccountStore+Write.swift`) cannot resurrect it.
  - Only a real store write failure (disk full, read-only store) triggers it. The `willSave` path and every other test pass (712 of 713).
  - Next step, an iOS store task (run `ios-engineer` on Opus): for such a write, either re-insert a deleted model from its saved copy when it is gone after the rollback, or reload the context from disk after a failed `save()`, e.g. throw the context away and open a new `ModelContext` on the container. Then rerun the job at least twice.
  - Fix (2026-11-26, ios-engineer): the job's log shows only line 509 failing; the same fetch at line 513 finds the bean, and the held instances are right, so the bean is not lost, only the first fetch after the repair misses it. `discardUnsavedChanges()` now ends each repair pass with `processPendingChanges()` and fetches every restored model again by its key (a miss is tried once more, then an `assertionFailure` and a fault). Re-insert and a new context were not taken (ADR 0025 Addendum M2-T36). Unverified: rerun the `ios` job at least twice.
- owner: ios-engineer
- depends: M2-T35
- implements: ADR 0025 (addendum M2-T35)
- acceptance:
  - These come from the M2-T35 review (PR #64), none of them blocking.
  - A test where `ModelContext.save()` itself fails on a deletion with relationships, not just the `willSave` hook. If that cannot be forced, the limit is documented.
  - `addShelfEntry` and `addBrew` run inside `write { }`, as `markUpdated` does.
  - When `savedCopy` cannot read the store, `discardUnsavedChanges` falls back to a bare `rollback()` without saying so. It should raise a debug assertion and log a fixed message.
  - A comment in `LabelPhotoQueue` says that a failed save after an upload repeats the S3 POST, and why that is safe.
  - Describing without a store shows a state that does not offer a retry.
  - The schema test also compares each property's key path, not only its name.
  - Mac: the `ios` job.

### M2-T37 Failed-write repair: the remaining review notes
- status: done (#87; the macOS `ios` job passed on cbde39d, including the real failed-save test: ADR 0025 Addendum M2-T37)
- owner: ios-engineer
- depends: M2-T36
- implements: ADR 0025 (addenda M2-T35 and M2-T36)
- acceptance:
  - These come from the reviews of PR #66, none of them blocking.
  - An `.attribute` restore reports whether it changed anything, by comparing values where they are `Equatable`, or the doc says it always reports a change.
  - Done in #66: the "not settled" and "unresolved" outcomes log a fixed fault and raise an `assertionFailure`; a fetch error is logged apart from "not on disk". What remains: a test of the "not settled" path needs the assertion to be injectable, or it crashes Debug test runs.
  - In the real save-failure test, `changedModelsArray` holds only the models of the failed write, and each equals its copy on disk.
  - Tests cover the "not settled" path (see above) and a repair run twice: an engine discard after a repaired discard.
  - An unresolved relationship left as the failed save's delete rule set it stays a pending change, and the next save would store it. Consider refusing `save()` until the context is reloaded, as `innerWriteFailed` does.
  - Two consent footer notes from the M2-T29 round 2 review:
    - the ADR 0025 addendum M2-T29 and the code agree on parked profile operations in the merge and adopt branches;
    - a test covers an edit made during the GET while `sentWithoutAnswer` is already true.
  - Mac: the `ios` job.

## Later ideas (not planned, not scheduled)

Owner ideas of 2026-11-26 for after launch or between M4 and M6. Each is planned with `/plan-milestone` when its turn comes. The notes list what a plan has to settle first, so nothing here is decided yet.

### L1 A widget to record a brew
- status: idea (owner, 2026-11-26)
- owner: ios-engineer, after a design decision by the lead
- goal: start or record a brew from the Home Screen or Lock Screen without opening the app.
- to settle before planning:
  - **What the widget does.** The shortest useful path is repeating the last brew or a saved recipe in one tap (docs/04 F2, M2-T27), and starting the timer. An interactive widget (iOS 17, App Intents) can run an intent without opening the app; a Live Activity could show a running timer. Pick one or two of these.
  - **No typed text (invariant 1).** A widget has no text input either; everything it records must be a pick from the vocabulary or a copy of an earlier brew.
  - **A second target and a shared store.** A widget extension is its own process. It needs the store, so the SwiftData store (and the per-account folders, ADR 0020) must move into an App Group container, with a migration for existing installs. That touches `ios/Cupmark/Store` and the account deletion cleanup (ADR 0031), so it needs an ADR and the Opus engineer.
  - **A human step.** The App Group and the widget's App ID are created in the Apple Developer account (the owner, as for Sign in with Apple); the entitlement goes in the project. No cloud cost.
  - **Sign-in state and the token.** The widget must not hold a token; it writes through the app's outbox and the app syncs later. Check that this keeps invariant 3.
  - **Privacy.** On-device only; the privacy manifest and the App Privacy answers need no change unless a new required-reason API is used (check).
  - **Accessibility and localisation** (en, de) as for the app.

### L2 Rate coffees from restaurants and other places of purchase
- status: idea (owner, 2026-11-26); needs the owner before anything is built
- owner: lead (design), then contract-keeper and the engineers
- goal: rate a coffee that is not a bag from the shelf: a cup in a café or restaurant, or beans bought somewhere without a barcode.
- why this is not a small task: it conflicts with three standing rules, so it needs decisions, an ADR and probably an invariant discussion with the owner:
  - **Identifying the place without typing (invariant 1).** No free text and no arbitrary strings in the API. Options to compare: (a) pick a place from the system's map search (MapKit points of interest, a first-party Apple framework, not a third-party SDK) and store only a server-generated id for it; (b) a closed list of place types (café, restaurant, bakery, roastery, shop, market, other) with no name; (c) a place the user saved earlier. A place name coming from Apple is a string that is not in the vocabulary, so storing it needs an explicit decision on invariant 1 (ADR) or must stay on the device.
  - **Location.** Finding nearby places needs the location permission. The privacy policy and the companion page say the app uses no location; the App Privacy answers (coarse or precise location) and the privacy manifest change, and the text must say so. Decide between coarse location only, location used on the device and never stored or sent, or no location at all (option b).
  - **What is being rated.** A cup has no barcode and often an unknown bean. The rating needs its own small shape: a drink type from a closed list (espresso, flat white, filter, and so on), the place (see above), the same criteria or a subset, and optionally the bean when it is known. Decide whether it reuses the brew record or is a new `Outing` model (contract change, vocabulary version bump: contract-keeper first, a new published vocabulary version, never an edit of a published one).
  - **Community data (invariants 4 and 6).** Decide whether cup ratings feed aggregates, and per place (a place's page would be a new aggregate: five distinct raters, subtract on delete, EU only) or not at all. A place is also personal data of where a person drinks coffee: the policy, the deletion cascade and the export have to cover it.
  - **Cost (invariant 5).** A server-side place table and any aggregates per place add DynamoDB items; estimate against docs/06 before deciding (pay-per-use only). Ask the owner if it adds cost.
  - **Photos.** A photo of the cup could reuse the brew photo store (M2-T42) with the same local-only rule.
- **Artfulness (owner, 2026-11-26).** The owner wants an "artfulness" score for a cup (latte art, presentation) that OTHER people can see, but at the level of the place, not the coffee:
  - It is not one of the eight bean criteria (those are about how a bean tastes and stay as they are in vocabulary v3). No vocabulary change for beans, no ninth bean criterion. It belongs to the cup-at-a-place rating of this idea, as a score of its own with the same 1 to 10 scale in half steps (a new published vocabulary version when this is built, never an edit of v3; contract-keeper first).
  - It is shown per place as an aggregate, never as one person's rating: at least five distinct raters before it is returned (invariant 4), subtracted when an account is deleted, EU only (invariant 6). The photo of the cup stays on the device (M2-T42 and ADR 0033); only the score would be shared, so the privacy text, the App Privacy answers and the manifest need the update this idea already lists.
  - It needs the place to exist first: identifying a place without typing, the location question and the cost are the same open points as above, and artfulness cannot ship before them. Until then, brew photos (M2-T42 and the gallery) stay personal and carry no score.
  - Who sees place averages (free or paid) is a product decision for the owner when the idea is planned; it affects the business model.
- first step when it is planned: a design note (ADR) answering the points above, with the owner's decision on location and invariant 1, before any contract or code.
