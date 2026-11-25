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
- [0002 Isolate from existing AWS resources](0002-isolate-from-existing-aws-resources.md)
- [0003 Milk is a pick list of dairy, plant and nut drinks](0003-milk-as-pick-list.md)
- [0004 How the API represents vocabulary values](0004-api-representation-of-vocabulary-values.md)
- [0005 Open Food Facts text is stored and shown; the server fetches it](0005-open-food-facts-text-in-the-catalogue.md)
- [0006 Origin and variety pick lists in vocabulary v2; roaster comes from Open Food Facts](0006-origin-variety-lists-and-roaster-from-open-food-facts.md)
- [0007 The health route needs no token](0007-unauthenticated-health-route.md)
- [0008 MPL-2.0 is allowed in dev-only tooling](0008-mpl-licensed-dev-tooling.md)
- [0009 One shared AWS account for both stages; a Cupmark stack creates the GitHub deploy role](0009-shared-account-and-github-oidc-stack.md)
