# 0002 Isolate Cupmark from existing AWS resources

- Status: accepted (2026-11-25), amended by ADR 0009
- Date: 2026-11-25
- Decided by: owner

## Context

Cupmark deploys into an AWS account that already hosts other projects (sites, buckets, Route 53 zones, roles, a CDK bootstrap). The default CDK bootstrap executes CloudFormation with AdministratorAccess, so a mistake in a Cupmark stack could change or delete those resources.

## Decision

- Invariant 9 in `CLAUDE.md`: this repo never touches resources it did not create. Names start with `cupmark-`, tagged `project=cupmark`.
- A separate CDK bootstrap with qualifier `cupmark` (stack `CDKToolkit-cupmark`). The shared `CDKToolkit` stack is used by nobody here and never modified.
- That bootstrap runs CloudFormation with the customer-managed policy `CupmarkCfnExecution`, not AdministratorAccess. It allows only `cupmark-*` resources in eu-central-1, requires the `CupmarkBoundary` permissions boundary on every role a stack creates, and explicitly denies Route 53, CloudFront, fixed-fee services and the named existing roles.
- The GitHub OIDC role `CupmarkGitHubDeploy` may assume only the `cdk-cupmark-*` bootstrap roles. It is created by the separate stack `cupmark-github-oidc` (ADR 0009), which a human deploys with their own credentials. It is the only Cupmark stack that does not run under `CupmarkCfnExecution`.
- The CDK app uses `new DefaultStackSynthesizer({ qualifier: 'cupmark' })` and applies the permissions boundary to every role (`PermissionsBoundary.of(app).apply(...)`).
- Files: `scripts/aws/`. A human runs `scripts/aws/apply-guardrails.sh --apply` as a non-root identity.

## Alternatives

- Rule in `CLAUDE.md` only: no technical enforcement.
- A separate AWS account for Cupmark: strongest isolation and the better long-term choice; not done yet. Moving later only changes the account id and the role ARN secret.

## Consequences

- IAM cannot scope API Gateway and Cognito creation by name (ids are generated), so those two services are allowed region-wide. Cupmark cannot be stopped from creating extra APIs or pools, but it can no longer change or delete resources of other projects in the name-scoped services.
- Every new service Cupmark needs must be added to `CupmarkCfnExecution` first; a failed deploy with AccessDenied is the signal.
- Costs nothing: IAM policies and a bootstrap bucket.
