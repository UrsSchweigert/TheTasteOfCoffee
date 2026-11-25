# 0009 One shared AWS account for both stages; a Cupmark stack creates the GitHub deploy role

- Status: accepted
- Date: 2026-11-25
- Decided by: owner

## Context

The docs disagreed in two places.

- M0-T7 and docs/05 asked for separate dev and prod accounts, while ADR 0002 describes deploying into the existing shared account.
- The infra-engineer brief put the GitHub OIDC deploy role in the stack, while ADR 0002, the `CupmarkCfnExecution` policy (which denies `oidc-provider/*`) and M0-T7 made it human-created.

An account can hold only one GitHub OIDC provider for `token.actions.githubusercontent.com`. The owner does not know whether the shared account already has one, for example from another project.

## Decision

- Both `dev` and `prod` deploy into the existing shared account. They are isolated from other projects as ADR 0002 describes, and from each other by `cupmark-<stage>-` names. A separate account stays the later option; moving only changes the account id and the role ARN secret.
- A Cupmark stack, `cupmark-github-oidc`, creates the role `CupmarkGitHubDeploy`. Its trust is limited to this repository, and to `main` for prod. The role may only assume the `cdk-cupmark-*` bootstrap roles.
- The GitHub OIDC provider is handled by the context flag `cupmark:githubOidcProvider`:
  - `create`: the stack creates the provider. Use this if the account has none.
  - `reference`: the stack trusts the existing provider by its ARN and never modifies it. This is a narrow, read-only exception to invariant 9: the stack references a shared, account-wide resource it cannot own.
- `cupmark-github-oidc` is deployed once by a human with their own credentials, not through `CupmarkCfnExecution`. It is the only stack that needs permissions outside that policy, and it is the step that lets GitHub deploy everything else. Every other stack keeps running under `CupmarkCfnExecution`.

## Alternatives

- Two new accounts now: rejected by the owner for now. It would be the strongest isolation, but it means extra setup before the first deploy.
- The role created by hand with a script: rejected by the owner in favour of keeping it as code.
- Loosening `CupmarkCfnExecution` to allow OIDC providers: rejected, because it would let any Cupmark stack create or change identity providers.

## Consequences

- Before the first deploy, the owner checks IAM → Identity providers for `token.actions.githubusercontent.com` and sets the flag. If a role named `CupmarkGitHubDeploy` already exists from earlier manual setup, it must be deleted or imported first, by the owner.
- Update, 2026-11-25: the owner confirmed that the provider already exists, so the flag is `reference`. The role `CupmarkGitHubDeploy` also already exists. M1-T9 must either import it into `cupmark-github-oidc` or have the owner delete it first, and it must never silently create a second role.
- Task M1-T9 builds the stack, and M1-T7 (deploy pipeline) depends on it.
- With `reference`, deleting the other project's provider would break Cupmark deploys. That is acceptable, because a separate account removes the dependency.
