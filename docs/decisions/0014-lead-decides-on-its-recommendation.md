# 0014 The lead decides open questions on its recommendation, unless cloud costs are likely

- Status: accepted
- Date: 2026-11-25
- Decided by: owner

## Context

Until now, every open product or design question went to the owner, who answered most of them by choosing the lead's recommended option. Waiting for those answers slowed the work down without changing the outcome.

## Decision

- The lead decides open product and design questions itself, following its own recommendation. This covers new questions and the ones in `docs/07-open-questions.md`.
- Each such decision is recorded as an ADR, or as an answered row in `docs/07` that references one, with "decided by: lead (ADR 0014)", so the owner can review it and overturn it later.
- The lead asks the owner first only when a decision is likely to add cloud costs. That covers a new billable resource, a higher-usage design or a paid tier change, judged against invariant 5 and `docs/06-cost-estimate.md`.
- The rule is about decisions, not actions. These still need the owner, as CLAUDE.md lists them:
  - anything that touches a real account (deploys, App Store Connect, AWS console);
  - credentials;
  - deleting data;
  - force-pushing or rewriting history;
  - non-permissive licences and SDKs that send data to third parties;
  - changing an invariant.

## Alternatives

- Keep asking the owner every time: rejected by the owner, because it slows progress without changing outcomes.

## Consequences

- When a decision is likely to cost money, the lead states the expected cost when it asks.
- The owner reviews decisions after the fact, through the ADR index and the pull request descriptions.
