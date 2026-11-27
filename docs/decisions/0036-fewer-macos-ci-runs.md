# 0036 Fewer and shorter macOS CI runs

- Status: accepted
- Date: 2026-11-27
- Decided by: owner (request to reduce the number and length of macOS CI runs, 2026-11-27); lead for the details (ADR 0014). No fixed-fee resource is added; this lowers the use of paid macOS runner minutes.

## Context

The `ios` job in `ci.yml` runs on macOS, the most expensive runner, on every pull request that touches the app and on every push to `main`. It ran the report-only accessibility audits (M2-T33), 13 screens at two text sizes, although they never fail on a finding.

## Decision

1. **Audits weekly and on demand.** `CupmarkUITests/AccessibilityAuditTests` is skipped in `ci.yml` (`-skip-testing`). `.github/workflows/ios-audits.yml` runs only that class on `workflow_dispatch` and every Monday 04:17 UTC. It is read-only, has no secrets, and nothing gates on it. The `AUDIT-ISSUE` lines are in that run, not in the pull request log.
2. **A gating smoke test replaces the audits' implicit checks.** `AccessibilityVoiceOverTests` has one test per screen that launches it once at the standard size and waits for its main control, no audit, and a test that the timer starts. The audit class has no assertion of its own, and a static test fails if one is added, because CI would not run it.
3. **Skip macOS when the app cannot have changed.** Markdown directly under `ios/` (the README) is not an app change. Markdown deeper in `ios/` is, because `Cupmark/`, `CupmarkTests/` and `CupmarkUITests/` are synchronized folders and Xcode bundles every file in them. A push to `main` is compared with `github.event.before`, with the same `IOS_PATHS`; an empty or all-zero before commit, an unreachable one (force push) or a failed diff runs `ios`. `ci-ok` is unchanged: a skipped `ios` passes only when `changes` said `ios=false`.

## Consequences

- Shorter `ios` runs on every pull request, and no macOS run for merges that touch only docs, backend, infra or `ios/*.md`.
- A new accessibility finding shows up within a week, not on the pull request that causes it.
- A new screen in the UI-test start needs its smoke test as well as its audit.
- The pull request that changes `ci.yml` still runs `ios` once, since `ci.yml` is in `IOS_PATHS`.
