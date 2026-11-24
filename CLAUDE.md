# Cupmark

Coffee bean rating and lookup app for iOS with a serverless AWS backend. Free tier for personal logging, paid tier for aggregated community data.

Read `docs/03-project-brief.md`, `docs/04-specification.md` and `docs/05-system-design.md` before changing anything. They are the source of truth. If code and docs disagree, stop and raise it; do not silently pick one.

## Invariants (never break these)

1. **No free text.** No control in the app accepts typed text. No API field accepts an arbitrary string. Every string field is an id from `contracts/vocabulary/` or a server-generated id. `scripts/check-no-free-text.sh` must pass.
2. **Closed vocabulary lives in one place.** `contracts/vocabulary/v<N>/` is the only definition of methods, criteria, notes and ranges. App and backend generate or load from it. Never hard-code a list elsewhere. Never edit a published version; add a new version.
3. **User id comes from the token.** Never from the request body, path or query.
4. **Aggregates need 5 distinct raters** before any endpoint returns them.
5. **Pay-per-use only.** No resource with a fixed monthly fee (WAF, NAT gateway, RDS, OpenSearch, ElastiCache, customer-managed KMS keys, Secrets Manager, provisioned concurrency) without an approved ADR.
6. **Region is eu-central-1.** No data leaves the EU.
7. **No third-party SDKs** for analytics, ads, crash reporting or subscriptions.
8. **No secrets in the repo.** Not in code, tests, fixtures or docs.

## Repository layout

```
docs/          product and design documents (source of truth)
docs/decisions ADRs: one file per decision
backlog/       BACKLOG.md: milestones and tasks, the work queue
contracts/     vocabulary JSON and openapi.yaml, shared by app and backend
backend/       TypeScript Lambda handlers, Vitest tests
infra/         AWS CDK app (TypeScript)
ios/           Xcode project, SwiftUI app, XCTest
scripts/       repo checks and operator tools
.claude/       agents, skills and settings for the agent team
```

`backend/`, `infra/` and `ios/` do not exist yet. Milestone M0 creates them.

## How work happens

- The queue is `backlog/BACKLOG.md`. Take the first task whose status is `todo` and whose dependencies are `done`. Run `/next-task` to do that.
- One task, one branch (`task/<id>-<slug>`), one pull request. Never commit to `main`.
- The lead session delegates to the specialist agent named in the task, then to `reviewer`. The agent that wrote the code never reviews it.
- Contract first: if a task changes the API or the vocabulary, `contract-keeper` changes `contracts/` first, then the engineers follow.
- Tests are written with the code. A task without passing tests is not done.
- Update the task status in `backlog/BACKLOG.md` in the same pull request.

## Definition of done

- Acceptance criteria in the task are met and demonstrated by tests.
- `npm test` passes in `backend/` and `infra/`; `cdk synth` succeeds; iOS tests pass where the task touched `ios/`.
- `scripts/check-no-free-text.sh` passes.
- `reviewer` has approved, with no open blocking findings.
- Docs updated if behaviour changed; an ADR added if a decision was made.

## Stop and ask the human

Do not proceed on your own when a task needs any of these. Leave the task `blocked`, say exactly what is needed, and move on to the next unblocked task.

- A decision listed in `docs/07-open-questions.md` that the default does not cover.
- Anything that spends money or touches a real account: `cdk deploy`, `cdk destroy`, App Store Connect, AWS console changes.
- Credentials, keys, certificates, provisioning profiles.
- Deleting data, tables or buckets; force-pushing; rewriting history.
- Adding a dependency with a non-permissive licence, or any SDK that sends data to a third party.
- Changing an invariant above.

## Environment notes

- iOS code only builds on macOS with Xcode. On Linux (cloud sessions, default GitHub runners) write and review Swift, but mark the task `needs-mac-verification` instead of `done` until tests have run on a Mac or a macOS runner.
- Backend and infra work anywhere with Node 22.
- Use `npm ci`, never `npm install`, in CI and in agents once a lockfile exists.

## Style

- TypeScript: strict mode, no `any`, zod schemas generated from `contracts/`.
- Swift: SwiftUI, Swift concurrency, no force unwraps, strings only through the localisation catalogue.
- Small pull requests. Plain commit messages that say what changed and why.
