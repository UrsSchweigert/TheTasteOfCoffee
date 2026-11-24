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

`backend/`, `infra/` and `ios/` do not exist yet. Iteration 1 creates `ios/`; iteration 2 creates the other two.

`ACCESS.md` is the only place agents ask the owner for anything. `backlog/STATE.md` is the handoff note between sessions.

## How work happens

- The `master` agent runs the project (`claude --agent master`). Its goal is the current iteration in `docs/08-iteration-1.md`. It reads `backlog/STATE.md` first and rewrites it after every task.
- The queue is `backlog/BACKLOG.md`. Take the first task whose status is `todo` and whose dependencies are `done`. `/next-task` does one task.
- One task, one branch (`task/<id>-<slug>`), one pull request. Never commit product code straight to `main`.
- The master delegates to the specialist agent named in the task, then to `reviewer`. The agent that wrote the code never reviews it.
- The master squash-merges a pull request once the reviewer approves and checks pass. No human approval is needed for merges.
- Contract first: if a task changes the API or the vocabulary, `contract-keeper` changes `contracts/` first, then the engineers follow.
- Tests are written with the code. A task without passing tests is not done.
- Update the task status in `backlog/BACKLOG.md` in the same pull request.

## Definition of done

- Acceptance criteria in the task are met and demonstrated by tests.
- `npm test` passes in `backend/` and `infra/`; `cdk synth` succeeds; iOS tests pass where the task touched `ios/`.
- `scripts/check-no-free-text.sh` passes.
- `reviewer` has approved, with no open blocking findings.
- Docs updated if behaviour changed; an ADR added if a decision was made.

## Decide, do not ask

The owner has delegated decisions to the master agent and wants progress.

- **Decisions:** the master decides product detail, scope, order, design and the open questions in `docs/07-open-questions.md`. Each decision becomes an ADR in `docs/decisions/` and work continues at once. Specialist agents bring choices to the master, never to the owner.
- **Access:** the owner is asked for one thing only: access (accounts, credentials, keys, devices, installs, paid sign-ups). Requests go in `ACCESS.md` with exact steps. Work continues on everything that does not need it.
- **Outside every agent's authority:** changing an invariant above; deploying a production stage; creating anything with a fixed monthly fee; reading, printing or copying secret values; touching any AWS resource this project's stacks did not create; deleting data, tables or buckets; force-pushing or rewriting history; adding an SDK that sends data to a third party. If a goal seems to need one of these, take another route and note it in `backlog/STATE.md`.

## Credentials

The owner's AWS and fal.ai credentials are in an env file outside this repo (by default `../derschweigert/.env`).

- Never open, read, `cat`, `grep` or print that file, and never echo an environment variable that came from it. Never copy a value into this repo, a log, a commit or a pull request.
- Use credentials only through `scripts/with-env.sh <command>`, which loads them into that one command's environment and forces the region to eu-central-1.
- **AWS:** only the master runs deployments, only of this project's `dev` stage (`scripts/with-env.sh npx cdk deploy 'cupmark-dev-*'`), and only after `cdk diff` shows nothing but resources of this project. Every resource is tagged `project=cupmark`. The account may hold other projects: never list, change or delete anything outside this project's stacks. The first deployment creates the budget alarm before anything else.
- **fal.ai:** for generated image assets only (app icon, empty-state illustrations). At most 20 generations per iteration; log each one (prompt, model, file) in `docs/assets-log.md`. No user data is ever sent to it, and it is never called from the app or the backend.

## Session budgets

Every agent run is bounded, and the repo is the memory between runs.

- Subagents carry a `maxTurns` limit in their definition. Partial work is resumed once; after that the task is split.
- The master runs under a session budget: `--max-turns` and, where spend is metered, `--max-budget-usd` (see `scripts/run-master.sh`). Runs use the Claude subscription's usage allowance when a subscription token is configured, and API billing only as a fallback.
- Without an explicit cap, one session is at most three tasks.
- Checkpoint after every task: task status, `backlog/STATE.md`, commit. A run that is cut off must lose nothing.
- Spend the budget on work: pass subagents only the task and the doc sections they need, do not re-read what is already in context, do not re-run unchanged passing tests.
- With about a fifth of the budget left, stop starting tasks and checkpoint.

## Environment notes

- iOS code only builds on macOS with Xcode. On Linux (cloud sessions, default GitHub runners) write and review Swift, but mark the task `needs-mac-verification` instead of `done` until tests have run on a Mac or a macOS runner.
- The Xcode project is generated from `ios/project.yml` with XcodeGen. Never hand-edit a `.xcodeproj`; it is git-ignored.
- Backend and infra work anywhere with Node 22.
- Use `npm ci`, never `npm install`, in CI and in agents once a lockfile exists.

## Style

- TypeScript: strict mode, no `any`, zod schemas generated from `contracts/`.
- Swift: SwiftUI, Swift concurrency, no force unwraps, strings only through the localisation catalogue.
- Small pull requests. Plain commit messages that say what changed and why.
