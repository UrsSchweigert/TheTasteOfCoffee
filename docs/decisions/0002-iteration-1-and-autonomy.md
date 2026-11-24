# 0002 Iteration 1 is local-first; the master agent decides

- Status: accepted
- Date: 2026-11-24
- Decided by: owner

## Context

The owner wants a first version on a phone as soon as possible and does not want to be asked about decisions. The original plan built the backend first and stopped at every open question.

## Decision

- A master agent runs the project. It decides product and technical questions inside the invariants in `CLAUDE.md`, records each decision as an ADR, merges reviewed work, and asks the owner only for access (`ACCESS.md`).
- Iteration 1 is the iOS app working fully on the device, with no backend. See `docs/08-iteration-1.md`.
- The master uses the owner's AWS and fal.ai credentials only through `scripts/with-env.sh`, never reading the values, and deploys only this project's dev stage.
- Every agent run is bounded by a session budget: turn limits on subagents, a turn or spend cap on the master, and a checkpoint after every task.

## Alternatives

- Backend first: nothing to hold in the hand for weeks, and it needs AWS and Apple accounts before any test.
- Owner approves each decision and each merge: safer, but progress waits on the owner.

## Consequences

- The owner sees decisions after the fact, in `docs/decisions/` and `backlog/STATE.md`, and can overturn them.
- Merges to `main` happen without a human, guarded by the reviewer agent and CI.
- The invariants, production deployment, fixed-fee resources and secret values stay outside the master's authority.
- Local-first for iteration 1 is a starting default; the master may revise it with a new ADR.
