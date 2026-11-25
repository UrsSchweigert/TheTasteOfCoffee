# 0008 MPL-2.0 is allowed in dev-only tooling

- Status: accepted
- Date: 2026-11-25
- Decided by: owner

## Context

CLAUDE.md requires the owner's approval for any dependency with a licence that is not permissive. The backend test runner, Vitest 5, depends on Vite 8, which depends on `lightningcss` and its platform binaries, licensed MPL-2.0. MPL-2.0 is weak, file-level copyleft: it obliges us to share changes only to the MPL files themselves.

## Decision

MPL-2.0 is accepted for development-only dependencies that are not modified and never ship in the app or a Lambda bundle. `lightningcss`, pulled in by Vitest, is the first such dependency.

## Alternatives

- Downgrading to an older Vitest major version to avoid it: not chosen, because it trades away a current, maintained test runner for no practical licence risk.

## Consequences

- Any MPL-2.0 or other copyleft dependency that would ship at runtime still needs a separate decision.
- The reviewer checks licences on each lockfile change; a new non-permissive licence outside this rule needs the owner.
