# Decisions

One file per decision, named `NNNN-short-title.md`. The master agent adds an ADR for every decision the docs did not already make (`Decided by: master`) and work continues at once. The owner can overturn any ADR. Only the owner can change an invariant in `CLAUDE.md`.

## Template

```
# NNNN Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Decided by: owner | master

## Context
What forced a decision.

## Decision
What was chosen.

## Alternatives
What was not chosen and why.

## Consequences
What this costs, what it rules out, when to revisit.
```

## Index

- [0001 Serverless AWS stack and iOS-only client](0001-stack.md)
- [0002 Iteration 1 is local-first; the master agent decides](0002-iteration-1-and-autonomy.md)
