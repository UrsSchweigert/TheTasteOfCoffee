# Decisions

One file per decision, named `NNNN-short-title.md`. Agents add an ADR whenever they make a choice the docs did not already make. Only the owner accepts an ADR that changes an invariant in `CLAUDE.md`.

## Template

```
# NNNN Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Decided by: owner | agent (name)

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
