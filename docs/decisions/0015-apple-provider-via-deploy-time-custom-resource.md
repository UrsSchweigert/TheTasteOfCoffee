# 0015 The Sign in with Apple provider is created by a deploy-time custom resource

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

Cognito's Apple identity provider needs the `.p8` private key in its `ProviderDetails`. The key lives in a Parameter Store SecureString that the owner creates (`/cupmark/<stage>/apple-sign-in-key`). CloudFormation offers no safe way to get it there:

- `{{resolve:ssm-secure}}` works only on a fixed list of properties, and `ProviderDetails` is not on it.
- `{{resolve:ssm}}` reads only plain String parameters.
- Secrets Manager has a monthly fee, so invariant 5 rules it out.
- Putting the key in the template, repo or CI breaks invariant 8 and ADR 0013.

## Decision

- A small custom resource Lambda, `cupmark-<stage>-apple-idp`, runs only during deploys. It reads the SecureString (`ssm:GetParameter` on exactly that ARN) and calls Cognito `CreateIdentityProvider`, `UpdateIdentityProvider`, `DeleteIdentityProvider` and `DescribeIdentityProvider` for the stage's user pool only.
- The provider's non-secret settings come from the stack: Services ID `app.cupmark.signin`, team `2F695PTZC6`, key id `3WKKAZFM6M`, and the scopes. The app client lists `SignInWithApple` as its only provider and depends on the custom resource.
- The key never appears in the template, repo, CI logs or CloudFormation events. The handler never logs it or returns it in its response.
- Rotating the key: the owner updates the SecureString, then the stack's rotation nonce is bumped so the resource runs again.

## Alternatives

- A NoEcho stack parameter filled in by the deploy job: rejected. The key would pass through the GitHub runner, and ADR 0013 rules that out.
- The owner creates the provider by hand with the CLI: rejected. The first deploy would need two phases, and the stack would depend on a resource it doesn't own, so it would drift.

## Consequences

- `scripts/aws/cupmark-boundary-policy.json` must allow the four Cognito identity-provider actions on `userpool/*`, because pools can't be name-scoped. The owner re-applies the guardrails before the first deploy.
- The guard allow list gains the custom resource type and the provider Lambda.
- The boundary also gains `dynamodb:ConditionCheckItem` on `table/cupmark-*`, which the repository's transactions need (found in the same task, M1-T2).
- By Cognito's design, `DescribeIdentityProvider` returns the provider's details, which may include the private key. Anyone in the shared account with that permission on the pool can therefore read the key. The lead accepts this under ADR 0014: there is no cost-free alternative, and the account's admins already have full access anyway.
- Hardening to verify on the first deploy: limit the boundary's Cognito statement to pools tagged `project=cupmark` with `"Condition": {"StringEquals": {"aws:ResourceTag/project": "cupmark"}}`. The pools carry that tag (`UserPoolTags`), but whether Cognito evaluates `aws:ResourceTag` for these four identity-provider actions could not be confirmed offline, and a wrong condition would make the provider function fail with AccessDenied. So it is not added yet.
- Cost: zero. The resource runs once per deploy, within the free tier.
