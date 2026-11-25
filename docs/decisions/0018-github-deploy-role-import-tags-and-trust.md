# 0018 The GitHub deploy role is imported as it is, then tagged; no boundary; its trust stays as built

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

M1-T9 builds the stack `cupmark-github-oidc` (ADR 0009). The role `CupmarkGitHubDeploy` already exists: the owner created it by hand on 2026-11-25, with the trust and the inline policy `AssumeCdkBootstrapRoles` that docs/07 describes, no permissions boundary and no tags. The owner prefers to import it with `cdk import`, which keeps the role as it is.

An import does not change the resource. CloudFormation records the template as the stack's template and takes the resource as it is. If the template differs from the real role, nothing applies the difference: `cdk diff` compares templates, so it shows nothing, and the next deploy changes only the properties whose template value changed. The difference stays as silent drift. So the import template must match the role exactly, and every intended change must come as a normal update after the import.

Three properties of the target state differ from the hand-made role, or might:

- **Tags.** Invariant 9 tags every resource `project=cupmark`. The stage stacks set it as a stack tag and on every resource. The role has no tags.
- **Boundary.** Every role in the stage stacks carries `CupmarkBoundary`, because `CupmarkCfnExecution` requires it. The role has none.
- **Trust for prod.** The acceptance says "the prod stage only from `main`". The role trusts `environment:dev` and `ref:refs/heads/main`. A GitHub job that declares an environment gets `sub` `repo:<owner>/<repo>:environment:<name>`, never `ref:...`.

## Decision

1. **Import first, with no tags.** `cdk import` runs with `-c cupmark:githubOidcImport=true`. In that mode the stack has no stack tags and the role has no `Tags`, so the template matches the role exactly: name, trust, inline policy, no boundary. The resource mapping is `infra/import/cupmark-github-oidc.json`. The role's logical id `DeployRole` is pinned in a test.
2. **Then tag, as a normal update.** The committed state (no flag) adds `project=cupmark` as a stack tag and on the role, and on the provider in create mode. The owner deploys it right after the import, in the same session. It is an in-place update (`iam:TagRole`): no replacement, and no change to the trust or the permissions. `cdk diff` between the two shows exactly this one change, which is the drift list for the owner. The tag guard exempts the stack only in import mode.
3. **No permissions boundary on this role.** The role is not created through `CupmarkCfnExecution`, which is the only reason the stage roles need it. `CupmarkBoundary` does not allow `sts:AssumeRole` on the bootstrap roles, so adding it would break every deploy. The role's one permission is pinned instead: an exact test, and the guards (no wildcard, only `role/cdk-cupmark-*` ARNs in this stack, which no stage role may name).
4. **The trust stays as built for now; prod is settled in M1-T7.** The import keeps `environment:dev` and `ref:refs/heads/main`. If the prod deploy job declares the GitHub environment `prod` (it should, because its required reviewers are how the owner approves every production deployment), M1-T7 adds `repo:UrsSchweigert/TheTasteOfCoffee:environment:prod` to the trust. That environment's deployment branches are limited to `main`. The trust change is a stack update that the owner deploys by hand, like the import. The code carries a `TODO(M1-T7)`.
5. **IAM does not separate dev from prod.** There is one deploy role and one `cupmark` bootstrap, and the bootstrap's deploy role can deploy any `cupmark-*` stack. A job that may assume the role for dev can therefore also deploy prod. "Prod only from `main`" is enforced in GitHub. M1-T7 must limit the deployment branches of both environments, `dev` and `prod`, to `main`. Then every `sub` the role accepts comes from a job on `main`, and changes to `main` go through reviewed pull requests. Real separation would need a bootstrap per stage. That is an owner decision for later: it touches the account and ADR 0002.
6. **The provider flag has no implicit default.** `cupmark:githubOidcProvider` must be `create` or `reference`. cdk.json commits `reference`, and a missing value fails the synth. Import mode together with `create` is rejected, because an import change set cannot create the provider.
7. **The stack is outside the stages.** It is built only when no `-c stage=` is given, so a stage deploy can never select it. It uses `CliCredentialsStackSynthesizer` with qualifier `cupmark`, so it deploys with the caller's credentials and assumes no bootstrap role. It has no assets: only the template is uploaded, to `cdk-cupmark-assets-<account>-eu-central-1`.

## Alternatives

- **Tags in the template at import time:** rejected. CloudFormation would record tags that the role does not have and would never apply them. That is silent drift.
- **No tags on this stack, ever:** rejected. It would be a permanent exception to invariant 9 for no reason. Tagging is free and safe once the role is imported.
- **Tagging by hand with `aws iam tag-role`:** rejected. The change would live outside the code.
- **Changing the trust at import time (adding `environment:prod`):** rejected. It is the same silent-drift problem, and M1-T7 has not yet fixed how the prod job authenticates.
- **The owner deletes the role and the stack creates it:** allowed by ADR 0009, but not chosen. The role ARN string would stay the same, but the role gets a new unique id, and GitHub deploys fail between the delete and the create. The owner prefers the import.

## Consequences

- The owner's one-time steps are in `infra/README.md` ("The GitHub deploy role"): synth, check what exists, import, check drift, deploy the tag, check again.
- `scripts/aws/apply-guardrails.sh` no longer writes the role's policy. Only the stack changes the role.
- If drift detection after the import reports a difference, the template is changed to match the real role (or the role to match the template) in a reviewed pull request, before anything else is deployed to this stack.
- Revisit when M1-T7 builds the deploy workflow (the `environment:prod` subject and the branch limits on both environments), and when Cupmark moves to its own account.
- Cost: zero. IAM roles, tags and OIDC providers are free.
