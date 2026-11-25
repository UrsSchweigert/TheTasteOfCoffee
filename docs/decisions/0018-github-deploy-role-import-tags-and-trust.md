# 0018 The GitHub deploy role trusts only the dev and prod environments, is imported as it is, then tagged; no boundary

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

M1-T9 builds the stack `cupmark-github-oidc` (ADR 0009). The role `CupmarkGitHubDeploy` already exists: the owner created it by hand on 2026-11-25, with the trust and the inline policy `AssumeCdkBootstrapRoles` that docs/07 describes, no permissions boundary and no tags. The owner prefers to import it with `cdk import`, which keeps the role as it is.

An import does not change the resource. CloudFormation records the template as the stack's template and takes the resource as it is. If the template differs from the real role, nothing applies the difference: `cdk diff` compares templates, so it shows nothing, and the next deploy changes only the properties whose template value changed. The difference stays as silent drift. So the import template must match the role exactly, and every intended change must come as a normal update after the import.

Three properties of the target state differ from the hand-made role, or might:

- **Tags.** Invariant 9 tags every resource `project=cupmark`. The stage stacks set it as a stack tag and on every resource. The role has no tags.
- **Boundary.** Every role in the stage stacks carries `CupmarkBoundary`, because `CupmarkCfnExecution` requires it. The role has none.
- **Trust.** The acceptance says "the prod stage only from `main`". The hand-made role trusts `environment:dev` and `ref:refs/heads/main`. A GitHub job that declares an environment gets `sub` `repo:<owner>/<repo>:environment:<name>`, never `ref:...`. The M1-T9 review found two holes in that trust:
  - any job on any branch that declares `environment: dev` gets `environment:dev`, unless the GitHub environment is limited to `main`, and naming an environment that does not exist creates it unprotected;
  - `.github/workflows/claude.yml` runs on `issue_comment` with `id-token: write` (for its own App-token exchange). For `issue_comment` GitHub sets the ref to the default branch, so its `sub` is `ref:refs/heads/main`. The agent there could assume `CupmarkGitHubDeploy` and, through the `cupmark` bootstrap's deploy role, deploy any `cupmark-*` stack, prod included.

## Decision

1. **Import first, with no tags.** `cdk import` runs with `-c cupmark:githubOidcImport=true`. In that mode the stack has no stack tags and the role has no `Tags`, so the template matches the role exactly: name, trust, inline policy, no boundary. The resource mapping is `infra/import/cupmark-github-oidc.json`. The role's logical id `DeployRole` is pinned in a test.
2. **Then tag, as a normal update.** The committed state (no flag) adds `project=cupmark` as a stack tag and on the role, and on the provider in create mode. The owner deploys it right after the import, in the same session. It is an in-place update (`iam:TagRole`): no replacement, and no change to the trust or the permissions. `cdk diff` between the two shows exactly this one change, which is the drift list for the owner. The tag guard exempts the stack only in import mode.
3. **No permissions boundary on this role.** The role is not created through `CupmarkCfnExecution`, which is the only reason the stage roles need it. `CupmarkBoundary` does not allow `sts:AssumeRole` on the bootstrap roles, so adding it would break every deploy. The role's one permission is pinned instead: an exact test, and the guards (no wildcard, only `role/cdk-cupmark-*` ARNs in this stack, which no stage role may name).
4. **The trust accepts only the two environment subjects.** These are `repo:UrsSchweigert/TheTasteOfCoffee:environment:dev` and `repo:UrsSchweigert/TheTasteOfCoffee:environment:prod`, with no `ref:` subject. The owner edits the existing role's trust to this list by hand before the import, so the import template still matches it exactly. The `trust` guard rejects any other `sub`. `scripts/check-workflows.mjs` requires, in strict workflow files (enforced) and as an advisory finding elsewhere, every job that runs `configure-aws-credentials` to declare the literal environment `dev` or `prod`, and in strict files every job that requests an OIDC token, except the listed `claude` job. `aws-oidc-check.yml` runs in `dev`.
5. **The environments' branch limits are the control; IAM separates neither branches nor stages.** IAM cannot tell `main` from another branch: any job that declares `environment: dev` on any branch gets the accepted `sub`. The owner therefore limits the deployment branches of the GitHub environments `dev` and `prod` to `main`, and makes the owner a required reviewer of `prod` (docs/07, issue #46). That setting, not the role, is what keeps other branches out. Nor is dev separated from prod in IAM: there is one deploy role and one `cupmark` bootstrap, whose deploy role can deploy any `cupmark-*` stack, so a job in `dev` could deploy prod stacks too. Prod deploys stay behind the owner's approval only because the workflows on `main` (changed through reviewed pull requests) deploy prod only from the `prod` environment. Real separation would need a bootstrap per stage. That is an owner decision for later: it touches the account and ADR 0002.
6. **The provider flag has no implicit default.** `cupmark:githubOidcProvider` must be `create` or `reference`. cdk.json commits `reference`, and a missing value fails the synth. Import mode together with `create` is rejected, because an import change set cannot create the provider.
7. **The stack is outside the stages.** It is built only when no `-c stage=` is given, so a stage deploy can never select it. It uses `CliCredentialsStackSynthesizer` with qualifier `cupmark`, so it deploys with the caller's credentials and assumes no bootstrap role. It has no assets: only the template is uploaded, to `cdk-cupmark-assets-<account>-eu-central-1`.

## Alternatives

- **Tags in the template at import time:** rejected. CloudFormation would record tags that the role does not have and would never apply them. That is silent drift.
- **No tags on this stack, ever:** rejected. It would be a permanent exception to invariant 9 for no reason. Tagging is free and safe once the role is imported.
- **Tagging by hand with `aws iam tag-role`:** rejected. The change would live outside the code.
- **Keeping `ref:refs/heads/main` in the trust:** rejected. The claude.yml `issue_comment` job, and any other job on `main` without an environment, could assume the role.
- **Changing the trust in the template only, at import time:** rejected. It is the same silent-drift problem. The owner changes the role by hand first instead, and `scripts/aws/check-github-deploy-role.sh` checks that the role and the template match before the import.
- **The owner deletes the role and the stack creates it:** allowed by ADR 0009, but not chosen. The role ARN string would stay the same, but the role gets a new unique id, and GitHub deploys fail between the delete and the create. The owner prefers the import.

## Consequences

- Before the import, the owner sets up the GitHub environments `dev` and `prod`, both limited to `main`, with `prod` requiring the owner's review, and edits the role's trust `sub` list to the two environment subjects (docs/07, issue #46).
- The owner's one-time steps are in `infra/README.md` ("The GitHub deploy role"): synth, the mechanical check (`scripts/aws/check-github-deploy-role.sh`), import, drift detection, deploy the tag, check again.
- Every GitHub job that uses AWS declares `environment: dev` or `environment: prod`. A job without an environment, such as claude.yml's, cannot assume the role.
- Removing a branch limit from either environment would let any branch deploy. Changing those settings is the owner's alone.
- `scripts/aws/apply-guardrails.sh` no longer writes the role's policy. Only the stack changes the role.
- If drift detection after the import reports a difference, the template is changed to match the real role (or the role to match the template) in a reviewed pull request, before anything else is deployed to this stack.
- Revisit when M1-T7 builds the deploy workflow (its jobs use the two environments and name the stage stacks, never `--all`), and when Cupmark moves to its own account or gets a bootstrap per stage.
- Cost: zero. IAM roles, tags and OIDC providers are free.
