# Backlog

The work queue for the agent team. `/next-task` takes the first task with `status: todo` whose dependencies are `done`.

Status values: `todo`, `in-progress`, `done`, `blocked`, `needs-mac-verification`.

Owners: `contract-keeper`, `backend-engineer`, `infra-engineer`, `ios-engineer`, `planner`, `human`.

Milestones M0 and M1 are broken into tasks. M2 to M6 are planned with `/plan-milestone` when their turn comes, so the plan can use what was learned before.

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
- status: todo
- owner: backend-engineer
- depends: M1-T4b
- implements: docs/decisions/0011, D12
- acceptance:
  - The server follows only an Open Food Facts image-host URL for the same canonical EAN-13. It copies the image once to `catalogue/<image_id>.jpg` in the photo bucket: JPEG only, size-limited, all metadata stripped. If the copy fails, the hit is cached without an image.
  - `GET /catalogue_images/{image_id}` serves the bytes with `X-Content-Type-Options: nosniff` and long-lived caching, under the Lambda response limit.
  - Any metadata-stripping dependency has a permissive licence and passes the licence check.

### M1-T4d Label photo upload
- status: todo
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
- status: todo
- owner: backend-engineer
- depends: M1-T5
- implements: docs/05-system-design.md, Security; docs/07-open-questions.md D1, D2
- acceptance:
  - Profile holds consent and locale; export returns all of a user's items as CSV; delete removes the whole user partition and the label photos.
  - From M1-T4b: the user partition also holds `LOOKUPS#<day>` counters (the daily Open Food Facts lookup cap). Deletion removes them with the partition. Export leaves them out: they are rate-limit state, not the user's data.
  - Tests prove nothing of the user remains after deletion.
  - From the M1-T2 review: deleting the account also deletes the Cognito user (`cognito-idp:AdminDeleteUser` on the stage pool). That needs a boundary change, and the owner re-applies the guardrails.
  - Deleting photos removes every object version, not just adding a delete marker, and a test asserts no version remains (see D10).
  - The boundary policy lacks `s3:DeleteObject`, `s3:DeleteObjectVersion` and `s3:ListBucketVersions` on the photo bucket. The policy change goes into `scripts/aws/`, and the owner re-applies it before deploy.

### M1-T7 Deploy pipeline to dev
- status: todo
- owner: infra-engineer
- depends: M1-T2, M0-T5, M1-T9
- needs: human (approve the first deployment)
- acceptance:
  - A workflow deploys to dev through OIDC on merge to `main`, and to prod only through a manually approved environment.
  - A smoke test calls the health route after deploy.
  - From M1-T4b: the API function gets `OFF_CONTACT` (the operator's mailbox, as a plain environment variable) and optionally `OFF_LOOKUP_CAP`. Without them, uncached Open Food Facts lookups answer 503.
  - From M1-T4b review: after the first deploy to dev, look up one known barcode and one unknown one, and check that the answers match the response shape the client expects (`status`, `product.product_name`, `product.brands`). A shape mismatch answers 503 and caches nothing.

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
- status: todo
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

Goal: scan, shelf, brew, rate and personal statistics work offline and sync. Not yet planned; run `/plan-milestone M2`.

Scope: Sign in with Apple, barcode scanner, Open Food Facts lookup, pick-list bean entry with label photo, shelf, brew form per method, timer, rating screen, recipes and one-tap repeat, local store and sync outbox, personal statistics, CSV export, account deletion, onboarding with consent, accessibility pass.

## M3 Aggregation

Goal: aggregates per bean and per method stay correct under create, edit, delete and replay. Not yet planned.

Scope: stream aggregator, rater markers, recipe histogram buckets, nightly rankings job, 5-rater threshold, one-rating-per-user-bean-day rule, weekly export to S3, load test of the aggregator with replayed records.

## M4 Paid tier

Goal: subscribers see Explore; free users see the give-to-get teaser. Not yet planned.

Scope: StoreKit 2 purchase and restore, transaction verification, App Store Server Notifications route, entitlement on the profile, paid API routes, Explore screens (bean page, method breakdown, top recipes, rankings), paywall.

## M5 Hardening

Goal: ready for strangers. Not yet planned.

Scope: App Attest, per-user write caps, budgets and alarms, operator CLI for the review queue and catalogue curation, restore drill from point-in-time recovery and from the S3 export, privacy review, performance against the 300 ms target.

## M6 Launch

Goal: TestFlight, then App Store. Not yet planned. Mostly human tasks.

Scope: App Store listing, screenshots, privacy nutrition labels, privacy policy and terms, TestFlight round with the persona interviews, production deployment, launch checklist.
