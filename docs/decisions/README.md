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
- [0010 Shelf, brew and recipe sort keys carry the item id](0010-sort-keys-carry-item-ids.md)
- [0011 Vocabulary v2: regions name their country, species is its own list; Open Food Facts images are copied](0011-vocabulary-v2-shape-and-open-food-facts-images.md)
- [0012 Shelf entries count the brews that reference them](0012-shelf-entries-count-their-brews.md)
- [0013 The cursor signing key is read from Parameter Store at cold start](0013-cursor-key-from-parameter-store.md)
- [0014 The lead decides open questions on its recommendation, unless cloud costs are likely](0014-lead-decides-on-its-recommendation.md)
- [0015 The Sign in with Apple provider is created by a deploy-time custom resource](0015-apple-provider-via-deploy-time-custom-resource.md)
- [0016 Label photos are uploaded with a presigned POST and stripped by the API](0016-label-photo-upload-and-stripping.md)
- [0017 Account deletion runs in the request and writes a deletion log outside the table](0017-account-deletion-and-deletion-log.md)
- [0018 The GitHub deploy role trusts only the dev and prod environments, is imported as it is, then tagged; no boundary](0018-github-deploy-role-import-tags-and-trust.md)
- [0019 Deploys run after CI through workflow_run; the operator mailbox comes from context in an explicit deploy mode](0019-deploy-pipeline-workflow-run-and-deploy-mode.md)
- [0020 No local-only mode without sign-in for now](0020-no-local-only-mode-for-now.md)
- [0021 Brew fields depend on the method, and grinders get their own scales](0021-method-dependent-brew-fields-and-grinders.md)
- [0022 Swift API types come from an in-repo generator](0022-swift-api-types-from-an-in-repo-generator.md)
- [0023 Debug builds and the M2 TestFlight builds use the dev stage](0023-debug-and-testflight-builds-use-dev.md)
- [0024 iOS sign-in: an ephemeral web flow, an Apple-style button of our own, and a local account key](0024-ios-sign-in-web-flow-and-token-store.md)
- [0025 Client sync: an ordered outbox per account, and how each answer is handled](0025-client-sync-outbox-and-conflict-rules.md)
- [0026 Rating input: no default answers, an offered last rating, and the version raised on rating](0026-rating-input-defaults.md)
- [0027 Personal statistics: the default set, computed on the device](0027-personal-statistics-set.md)
- [0028 Recipes and one-tap repeat: no name, copied into a new brew, kept from the brew form](0028-recipes-and-one-tap-repeat.md)
- [0029 Processes gain `unknown` and species gain `other` in vocabulary v3](0029-processes-gain-unknown-and-species-gain-other.md)
