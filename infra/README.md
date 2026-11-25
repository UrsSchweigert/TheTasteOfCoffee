# Infra

The AWS CDK v2 app of Cupmark (TypeScript, ESM). Design: `docs/05-system-design.md`; cost: `docs/06-cost-estimate.md`; account isolation: `docs/decisions/0002-isolate-from-existing-aws-resources.md`.

**Deploys happen only through the human-approved GitHub Actions workflow (M1-T7).** Nobody runs `cdk deploy`, `cdk destroy` or `cdk bootstrap` from a laptop or an agent session. The Cupmark bootstrap (`CDKToolkit-cupmark`, qualifier `cupmark`) is created once by a human with `scripts/aws/apply-guardrails.sh --apply`. The one exception is the stack `cupmark-github-oidc` (the GitHub deploy role, below): the owner imports and deploys it by hand, with their own credentials, because it is what lets GitHub deploy everything else. No agent ever runs those steps.

## Commands

Run in `infra/` with Node `^22.18.0` or 24 and later (`.npmrc` sets `engine-strict`). The app is TypeScript run directly by Node's type stripping; nothing is compiled to JavaScript.

| Command | What it does |
| --- | --- |
| `npm ci` | Install exactly what `package-lock.json` pins. |
| `npm run build` | Type-check with `tsc` (no output files). |
| `npm run lint` | ESLint (typescript-eslint, strict type-checked, `any` banned) and `tsc --noEmit`. |
| `npm test` | Vitest with `aws-cdk-lib/assertions`: the app and every guard. |
| `npm run synth` | `cdk synth --no-lookups` of both stages into `cdk.out/` (gitignored). Works offline, without AWS credentials. |

**Build the backend first.** The Lambda code is the backend's bundle, `backend/dist/<name>/index.mjs`, and `test/api.test.ts` reads `contracts/openapi.yaml` with the backend's `yaml` package. Before `npm test` or `npm run synth` here, run `npm ci && npm run build` in `backend/`. Without the bundle, synth stops with an error that says so. CI's infra job does the same.

`npm run synth` also synthesises `cupmark-github-oidc` (below), in the committed `reference` mode; `npm run synth -- -c cupmark:githubOidcProvider=create` shows create mode. `npm run synth -- -c stage=dev` synthesises one stage and leaves `cupmark-github-oidc` out. The target account comes from `-c cupmark:<stage>:account=<id>`, else from `CDK_DEFAULT_ACCOUNT` (set by the CDK CLI when credentials are present), else the stacks are account-agnostic. No account id is written in this repo.

## Layout

```
bin/cupmark.ts     entry point (cdk.json "app"): builds, synthesises, runs the guards
src/config.ts      region, tag, name prefix, bootstrap qualifier, stage names
src/app.ts         builds the App with the selected stages
src/stage.ts       CupmarkStage (one per environment) and CupmarkStack (base of every stage stack)
src/github-oidc.ts the stack cupmark-github-oidc: the GitHub OIDC trust and CupmarkGitHubDeploy (M1-T9)
src/data.ts        the DynamoDB table and the three S3 buckets (M1-T1, M1-T6)
src/identity.ts    the Cognito user pool, its domain, the iOS app client and the Apple provider (M1-T2)
src/functions.ts   one Lambda function: bundle, role, concurrency cap, 14-day log group
src/api.ts         the HTTP API, its authorizer and stage, the api and health functions (M1-T2)
src/routes.ts      the route list, checked against contracts/openapi.yaml
src/guards.ts      synth-time guards for invariants 5, 6 and 9, and least privilege
import/            the cdk import resource mapping of cupmark-github-oidc
test/              Vitest tests
```

## Stages and stacks

- Two stages, `dev` and `prod`, built from the same code. Nothing is shared between them.
- Every stage stack extends `CupmarkStack`: named `cupmark-<stage>-<part>`, region pinned to `eu-central-1`, `DefaultStackSynthesizer` with qualifier `cupmark` (roles `cdk-cupmark-*`), termination protection on, stack tags `project=cupmark` and `stage=<stage>`.
- `CupmarkStage` tags every resource `project=cupmark` and `stage=<stage>`, and gives every IAM role the `CupmarkBoundary` permissions boundary, which `CupmarkCfnExecution` requires.
- Each stage has one stack, `cupmark-<stage>-core`. It holds the data, identity and API resources below.
- One more stack, outside the stages: `cupmark-github-oidc` (below). It is the only stack that is not a `CupmarkStack`, not deployed by CI and not deployed through `CupmarkCfnExecution`.

## Data (`src/data.ts`)

Everything here is `RemovalPolicy.RETAIN` (CloudFormation `DeletionPolicy` and `UpdateReplacePolicy` `Retain`): deleting the stack or replacing a resource leaves the data in place. The physical names are fixed, so a change that would replace one of these resources fails instead of silently creating a second one. Deleting a table or bucket is a human decision.

### Table `cupmark-<stage>-main`

| Property | Value | Why |
| --- | --- | --- |
| Keys | `pk` (S), `sk` (S) | Generic: one table holds every item type of the data model in `docs/05-system-design.md`. |
| Billing | `PAY_PER_REQUEST` (on-demand), also for the index | No fixed fee (invariant 5). |
| Point-in-time recovery | on, 35 days | Restore to any second of the last 35 days. |
| Deletion protection | on | A stack or console delete cannot drop the table. |
| Stream | `NEW_AND_OLD_IMAGES` | The aggregator applies the difference on edits and deletes. |
| Encryption | AWS-owned key (`SSEEnabled: false` in the template means "AWS-owned", not "unencrypted") | Encrypted at rest with no KMS key and no KMS request charges. |
| TTL | on attribute `expires_at` (number, epoch seconds) | Only an Open Food Facts miss (`BARCODE#<ean>` / `OFF`) and the daily lookup counter (`USER#<id>` / `LOOKUPS#<date>`) carry it. Deletion happens some time after expiry, so reads still check the time. TTL deletes are free and appear in the stream. |
| Table class | `STANDARD` | |

**Index `gsi1` (review queue).** Keys `gsi1pk` (S) and `gsi1sk` (S), projection `ALL`. It is sparse: only items that carry both attributes appear in it.

| Item | `gsi1pk` | `gsi1sk` | When |
| --- | --- | --- | --- |
| Bean (`BEAN#<beanId>` / `META`) with status unverified | `REVIEW#UNVERIFIED` | `<createdAt ISO 8601>#<beanId>` | Set when the bean is created unverified (F1, M1-T4). |

Verifying (or rejecting) a bean removes both attributes in the same write, which drops it from the queue. No other item sets `gsi1pk` or `gsi1sk`. The repository module (`backend/src/repository/`, M1-T3) owns these formats; this table is the contract. `test/table-schema.test.ts` fails if the synthesised keys, index or stream differ from `backend/src/repository/table.ts`, which the backend's DynamoDB Local tests create their table from.

### Buckets

All three buckets: all public access blocked, object ownership `BucketOwnerEnforced` (ACLs off), versioning on, S3-managed encryption (SSE-S3), a bucket policy that denies any request without TLS or with TLS older than 1.2, `RETAIN`. Names are `cupmark-<stage>-<part>-<account id>` because bucket names are global.

| Bucket | Holds | Lifecycle |
| --- | --- | --- |
| `cupmark-<stage>-photos-<account>` | By prefix: `uploads/` raw label photo uploads (presigned POST, ADR 0016); `labels/` the stripped label photos of unverified beans (F1), seen only by the operator; `verified/` photos of verified beans; `catalogue/` the catalogue's copies of Open Food Facts images (ADR 0011), which never expire | Objects under `uploads/` expire 1 day after they were written, and their noncurrent versions 1 day later. Objects under `verified/` expire 90 days after they were written. Noncurrent versions elsewhere expire after 30 days. Incomplete multipart uploads are aborted after 1 day. Expired delete markers are removed. No CORS configuration: the iOS app is not a browser. |
| `cupmark-<stage>-backups-<account>` | The weekly full table export | Moves to S3 Glacier Flexible Retrieval after 30 days and expires after 365 days. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 7 days. Expired delete markers are removed. |
| `cupmark-<stage>-deletion-log-<account>` | The account deletion log (ADR 0017): one object per deleted account, `entries/<ulid>.json`, holding `sub`, `photo_ids` and `deleted_at` (ids only) | Objects under `entries/` expire 400 days after they were written. Noncurrent versions expire after 30 days. Expired delete markers are removed. |

- **Label photo uploads (ADR 0016).** The API signs a presigned POST for `uploads/<photoId>.jpg` (exact key, `image/jpeg`, 1 byte to 8 MiB, 10 minutes); the app posts the JPEG straight to S3. The completion call reads the upload, strips its metadata and writes `labels/<photoId>.jpg`. Keys hold only the random photo id, never a user id. The API never deletes the raw upload: the `expire-raw-uploads` rule expires it 1 day after creation (in a versioned bucket that adds a delete marker and makes it noncurrent) and removes the noncurrent version 1 day later, so an unstripped original exists for at most about two days; the leftover delete marker is then removed by `remove-expired-delete-markers`. The whole-bucket `expire-noncurrent-versions` rule (30 days) also matches `uploads/`; when two rules expire the same object, S3 applies the shorter period, so the 1-day rule wins there and the two do not conflict. Photos under `labels/` never expire by lifecycle while the bean is in review. The upload flow itself deletes nothing; the only S3 deletes are account deletion's, below.
- **Label photos.** `docs/06-cost-estimate.md` says "delete label photos 90 days after the bean is verified". Lifecycle rules count from an object's creation, not from a later event, so the convention is: when the operator verifies a bean, the tooling copies its photo to `verified/<beanId>/...` (a new object with a new creation date) and deletes the original. Photos of beans still in review never expire by lifecycle. Because the bucket is versioned, an expired or deleted photo stays as a noncurrent version for 30 more days, so it is gone for good about 120 days after verification.
- **Account deletion (ADR 0017).** `DELETE /account` removes every version and delete marker of the user's `labels/<id>.jpg` and `uploads/<id>.jpg` (it lists the versions with the exact key as prefix, then deletes each `VersionId`), so a deleted photo does not linger as a noncurrent version. It then writes one entry to the deletion log before deleting the Cognito user.
- **Deletion log.** It lives outside the table so that restoring the table from point-in-time recovery or an export cannot lose entries written after the restore point. 400 days outlives the 365-day exports and the 35-day recovery window. The API may only put objects under `entries/`; it cannot read, list or delete the log. Reading it is for the operator's restore procedure (M5): after a restore, re-delete every `sub` and bean-side `PHOTO#` item logged after the restore point. Its logical id is pinned like the other buckets.
- **Backups.** Glacier Flexible Retrieval restores in hours (standard retrieval 3 to 5 hours), which matches the "restore within a few hours" target; the newest four exports are still in S3 Standard, and point-in-time recovery covers the last 35 days anyway. Its 90-day minimum storage duration is well inside the one-year retention.
- **No access logging.** S3 server access logs need a third bucket, which then needs its own retention and safety properties, and they add storage and request charges per log object. CloudTrail (account level) already records bucket-level API calls. Revisit if the photo bucket ever needs per-object audit.
- **No replication.** Replicating the backup bucket to Ireland (eu-west-1) is optional in the design and is not done. It is a follow-up: it would need a replication role, a second bucket in another region (an exception to the region guard) and a change to `CupmarkCfnExecution`, which denies every region but eu-central-1.

- **Catalogue images.** The photo bucket also holds `catalogue/<imageId>.jpg`, the stored copies of Open Food Facts front images (ADR 0011, docs/05 Barcode lookup). No lifecycle rule matches `catalogue/`, so they never expire; only overwritten or deleted versions go after 30 days. They are shared catalogue data, so account deletion does not remove them. The API function may read and write only this prefix.

## Identity (`src/identity.ts`)

| Resource | Name | Key properties |
| --- | --- | --- |
| User pool | `cupmark-<stage>-users` | Lite feature plan (free for the first 10,000 monthly active users). No self sign-up (`AllowAdminCreateUserOnly`), no verified attributes, no account recovery, no MFA, no email, phone or name attribute. `RETAIN` and `DeletionProtection: ACTIVE`: the token subjects key every `USER#<sub>` partition, so losing the pool would orphan all user data. |
| Hosted domain | prefix exactly `cupmark-<stage>` | `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com`; classic hosted UI (managed login needs Essentials). Apple's return URL is `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`. |
| Apple provider | `SignInWithApple` | Created by the custom resource `Custom::CupmarkAppleIdentityProvider` (ADR 0015), below. |
| App client | `cupmark-<stage>-ios` | Public (no secret); authorization code flow with PKCE; scope `openid`; no password, SRP or custom sign-in (`ExplicitAuthFlows` is only `ALLOW_REFRESH_TOKEN_AUTH`); `SignInWithApple` is its only provider (never `COGNITO`), and it depends on the provider resource; access and id tokens 60 minutes, refresh token 30 days; token revocation on; user-existence errors hidden. |

**App callback (for M2).** The client's callback URL is `cupmark://auth` and its sign-out URL `cupmark://signout`. The app registers the `cupmark` URL scheme and opens `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com/oauth2/authorize?identity_provider=SignInWithApple&response_type=code&client_id=<AppClientId>&redirect_uri=cupmark://auth&scope=openid&code_challenge=...&code_challenge_method=S256` in `ASWebAuthenticationSession`, then exchanges the code at `/oauth2/token`. The access token is the bearer token of the API.

**Sign in with Apple** (`APPLE_SIGN_IN` in `src/identity.ts`, M0-T7): Services ID `app.cupmark.signin`, Team ID `2F695PTZC6`, key id `3WKKAZFM6M`, scopes none (no name, no email; only Apple's opaque user id is used). These are configuration, not secrets. The `.p8` private key lives only in the SecureString `/cupmark/<stage>/apple-sign-in-key`, created by the owner (below).

### The Apple provider (ADR 0015)

CloudFormation cannot put a SecureString into `ProviderDetails.private_key` (`{{resolve:ssm-secure}}` does not support that property, `{{resolve:ssm}}` reads only unencrypted parameters, Secrets Manager has a fee). So a deploy-time custom resource does it:

- **`Custom::CupmarkAppleIdentityProvider`**, a plain custom resource (no CDK Provider framework, so there is no extra framework Lambda or role). Its properties are the pool id, the Services ID, Team ID, key id, the key's parameter **name**, the scopes (empty) and the rotation value. Never the key.
- **`cupmark-<stage>-apple-idp`**, its function (`backend/src/handlers/apple-idp.ts`, logic in `backend/src/apple-idp/`), built like every other function: Node 22, arm64, reserved concurrency 1, 30 s, 14-day log group, its own role with the boundary. The role may `ssm:GetParameter` on exactly `/cupmark/<stage>/apple-sign-in-key` and call `cognito-idp:Create`, `Update`, `Delete` and `DescribeIdentityProvider` on exactly the stage's pool ARN.
- **Create and Update** read the SecureString (it must be a `SecureString` holding a PEM key), then create the provider, or update it if it exists. **Delete** removes it; a provider or pool that is already gone counts as success. Deleting the stack removes the provider and keeps the pool.
- The handler never logs the key and never returns it: the response has `NoEcho` and only the provider name in `Data`; a failure reason is an error class name only. One log line per event: request type, status, reason.
- **Scopes:** `authorize_scopes` is empty. Apple's only scopes are `name` and `email`, and requesting neither is allowed; `openid` is not an Apple scope. This could not be verified against Cognito offline: if Cognito rejected an empty value, the first dev deploy fails at this resource with the error class name, and the fix is one constant (`APPLE_SIGN_IN.scopes`).
- **Rotating the key:** replace the SecureString (below), then bump `cupmark:<stage>:appleKeyRotation` in `cdk.json` in a pull request. The changed property makes CloudFormation run Update, which re-reads the key.

## API (`src/api.ts`, `src/routes.ts`)

| Resource | Name | Key properties |
| --- | --- | --- |
| HTTP API | `cupmark-<stage>-api` | API Gateway v2 HTTP API, no CORS (native app). |
| Stage | `$default` | Auto-deploy. The API function routes on `rawPath`, so there is no stage prefix in the path (ADR 0013). Throttling: dev 10 requests per second (burst 20), prod 25 (burst 50); at docs/06's 60 calls per user a month, 10,000 users average about 0.25 per second. |
| JWT authorizer | `cupmark-<stage>-cognito` | Built in (no Lambda). Issuer `https://cognito-idp.eu-central-1.amazonaws.com/<pool id>`, audience the app client id (Cognito access tokens carry it as `client_id`), identity source the `Authorization` header. |
| Routes | | One per operation of `contracts/openapi.yaml`, all with the JWT authorizer except `GET /health` (ADR 0007). The App Store notifications route joins `UNAUTHENTICATED_ROUTES` in M4. `test/api.test.ts` fails if the routes and the contract differ, or if any other route lacks the authorizer. |
| Functions | `cupmark-<stage>-api`, `cupmark-<stage>-health` | Node 22 on arm64, code from `backend/dist/api` and `backend/dist/health`, payload format 2.0. Reserved concurrency: dev 5 and 1, prod 10 and 2 (free; caps the cost of a flood); with `apple-idp` (1 each) the account reserves 20 in all. 256 MB and 10 s for the API, 128 MB and 3 s for health. |
| Log groups | `/aws/lambda/cupmark-<stage>-api`, `-health` | 14 days. Deleted with the stack (operational logs only). |
| Roles | `cupmark-<stage>-api`, `cupmark-<stage>-health` | One per function, with the `CupmarkBoundary` boundary and one inline policy; no managed policies. |

**What each role may do.**

| Role | Actions | Resource |
| --- | --- | --- |
| both | `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group |
| api | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `ConditionCheckItem` (the repository's transactions are authorised per contained action), `BatchWriteItem` (account deletion deletes the user partition in pages of 25, ADR 0017) | the table |
| api | `dynamodb:Query` | the index `gsi1` |
| api | `ssm:GetParameter` | exactly `/cupmark/<stage>/cursor-key` (the AWS-managed `aws/ssm` key needs no grant) |
| api | `s3:GetObject`, `s3:PutObject` | `cupmark-<stage>-photos-<account>/catalogue/*` |
| api | `s3:GetObject`, `s3:PutObject` | `cupmark-<stage>-photos-<account>/uploads/*` (PutObject authorises the presigned POST the API signs; GetObject lets the completion call read it, ADR 0016) |
| api | `s3:PutObject` | `cupmark-<stage>-photos-<account>/labels/*` (the stripped label photo, ADR 0016) |
| api | `s3:DeleteObject`, `s3:DeleteObjectVersion` | `cupmark-<stage>-photos-<account>/labels/*` and `/uploads/*` (account deletion, ADR 0017) |
| api | `s3:ListBucketVersions` | the photo bucket, only with `StringLike` `s3:prefix` `labels/*` or `uploads/*` (account deletion finds the version ids) |
| api | `s3:PutObject` | `cupmark-<stage>-deletion-log-<account>/entries/*` (write only, ADR 0017) |
| api | `cognito-idp:AdminDeleteUser` | the stage's user pool (account deletion, ADR 0017) |
| apple-idp | `ssm:GetParameter` | exactly `/cupmark/<stage>/apple-sign-in-key` |
| apple-idp | `cognito-idp:CreateIdentityProvider`, `UpdateIdentityProvider`, `DeleteIdentityProvider`, `DescribeIdentityProvider` | the stage's user pool |

The only S3 delete and list actions any role holds are the api role's account-deletion statements, limited to `labels/` and `uploads/` of the photo bucket; `catalogue/` and `verified/` cannot be deleted by the API. No role can read, list or delete the deletion log. The only delete actions any role holds are `dynamodb:DeleteItem`, `s3:DeleteObject`, `s3:DeleteObjectVersion` and `cognito-idp:AdminDeleteUser` (api) and `cognito-idp:DeleteIdentityProvider` (apple-idp). `test/api.test.ts` pins all of this, and the exact S3 and Cognito statements, per stage.

**API function environment:** `TABLE_NAME` (`cupmark-<stage>-main`), `CURSOR_KEY_PARAMETER` (`/cupmark/<stage>/cursor-key`), `PHOTO_BUCKET` (`cupmark-<stage>-photos-<account>`, where the API stores and serves `catalogue/` images, signs label photo uploads to `uploads/` and writes stripped photos to `labels/`), `DELETION_LOG_BUCKET` (`cupmark-<stage>-deletion-log-<account>`, ADR 0017), `USER_POOL_ID` (the stage pool's id, for `AdminDeleteUser`), `NODE_OPTIONS=--enable-source-maps`. No secret is in the environment. Both bucket names match the backend's pattern `^cupmark-[a-z0-9][a-z0-9-]{0,53}[a-z0-9]$` without `--` (the longest, `cupmark-prod-deletion-log-<12 digits>`, is 38 characters); `test/api.test.ts` checks it.

**Outbound HTTPS.** The functions are not in a VPC. A Lambda function outside a VPC has internet access through the Lambda service, so the API function reaches the Open Food Facts API and image host over HTTPS without a VPC, NAT gateway or VPC endpoint (all fixed-fee, invariant 5). Which hosts it calls is the backend's concern (docs/05, Barcode lookup); there is no egress filter, which would need a NAT gateway or a firewall.

**Not done, on purpose:** no API access logging (it would need a log delivery setup and adds log charges; the function logs one line per request); no custom domain (would need ACM and Route 53, denied by `CupmarkCfnExecution`).

## The GitHub deploy role (`src/github-oidc.ts`, stack `cupmark-github-oidc`)

ADR 0009 and ADR 0018. The stack holds the role that GitHub Actions in this repository assumes, `CupmarkGitHubDeploy`. In create mode it also holds the account's GitHub OIDC provider.

| Property | Value |
| --- | --- |
| Stack | `cupmark-github-oidc`, at the top of the app (not in a stage), built only when no `-c stage=` is given. eu-central-1, account-agnostic (every ARN uses `AWS::AccountId`), termination protection on, stack tag `project=cupmark` (none in import mode). |
| Deployed by | The owner, by hand, with their own credentials. `CliCredentialsStackSynthesizer` (qualifier `cupmark`): the CLI assumes no bootstrap role and passes no CloudFormation execution role, so `CupmarkCfnExecution` (which denies `oidc-provider/*` and does not cover this role) is not involved. The CLI still uploads the template to `cdk-cupmark-assets-<account>-eu-central-1`, so the `cupmark` bootstrap must exist (it does). The stack has no other asset and no `BootstrapVersion` parameter. |
| Role | `CupmarkGitHubDeploy`, logical id `DeployRole` (pinned; it is the key of the import mapping). `RETAIN` on delete and on replacement. No permissions boundary, no managed policies, no description, default path and session duration, as built by hand. Tag `project=cupmark` only after the import (below). |
| Trust | Principal: the GitHub provider. `reference` (committed): `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, named by ARN only, never imported, looked up or modified. `create`: the provider of this stack. Action `sts:AssumeRoleWithWebIdentity`. `StringEquals` `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com` and `token.actions.githubusercontent.com:sub` = exactly `repo:UrsSchweigert/TheTasteOfCoffee:environment:dev` or `repo:UrsSchweigert/TheTasteOfCoffee:ref:refs/heads/main`. |
| Inline policy | `AssumeCdkBootstrapRoles`: `sts:AssumeRole` on exactly `cdk-cupmark-deploy-role-`, `cdk-cupmark-file-publishing-role-`, `cdk-cupmark-image-publishing-role-` and `cdk-cupmark-lookup-role-<account>-eu-central-1`. This is the document `scripts/aws/apply-guardrails.sh` step 3 wrote before M1-T9. |
| Provider (create mode only) | `AWS::IAM::OIDCProvider`, URL `https://token.actions.githubusercontent.com`, client id `sts.amazonaws.com`, no thumbprints (IAM no longer uses them for GitHub). `RETAIN`. An account can hold only one provider per URL, so create mode fails with `EntityAlreadyExists` if one exists. That is a safe failure. |

**Context flags.**

| Flag | Values | Committed | Meaning |
| --- | --- | --- | --- |
| `cupmark:githubOidcProvider` | `create`, `reference` | `reference` (cdk.json) | The shared account already has the provider (docs/07). Any other value, or none, fails the synth: there is no silent default. |
| `cupmark:githubOidcImport` | `true`, `false` | absent (`false`) | `true` only for the one-time `cdk import`. It leaves out the stack and role tags, so the template matches the hand-made role. It needs `reference`. |

**The repository name is case-sensitive.** GitHub writes `sub` with the owner and repository as GitHub names them, and IAM's `StringEquals` compares case-sensitively. The name `UrsSchweigert/TheTasteOfCoffee` was checked against the GitHub API (`full_name`) on 2026-11-25. If the repository or the account is ever renamed, or moved, every assume fails with AccessDenied until `GITHUB_REPOSITORY` in `src/github-oidc.ts` is changed and the stack is deployed again.

**Which jobs may assume the role.** GitHub sets `sub` to `repo:<owner>/<repo>:environment:<name>` when a job declares an environment, and to `repo:<owner>/<repo>:ref:<ref>` when it does not (for push and workflow_dispatch events). So:

- a job that declares the environment `dev` may assume the role, on any branch the `dev` environment allows;
- a job on `main` that declares no environment may assume it (the "AWS OIDC check" workflow does this);
- no pull request job, no job on another branch, and no job of another repository or fork may assume it.

"The prod stage only from `main`": with this trust, a prod deploy job on `main` that declares no environment is accepted. But the owner approves every production deployment, so the prod job should declare a GitHub environment `prod` with required reviewers, and then its `sub` is `environment:prod`, which this trust does not accept yet. **TODO(M1-T7):** if the prod job declares `environment: prod`, add `repo:UrsSchweigert/TheTasteOfCoffee:environment:prod` to `GITHUB_DEPLOY_SUBJECTS`, limit the `prod` environment's deployment branches to `main`, and have the owner deploy the stack (`npx cdk diff` and then `npx cdk deploy cupmark-github-oidc`, as in step 6 below). There is one role for both stages, and the `cupmark` bootstrap's deploy role can deploy any `cupmark-*` stack, so IAM alone cannot keep a dev job from deploying prod. M1-T7 must also limit the `dev` environment's deployment branches to `main` (ADR 0018).

### One-time import (owner)

Run by the owner in AWS CloudShell in eu-central-1, signed in with their own admin identity (not root). Never by an agent or CI. Nothing here deletes anything. The role keeps its ARN and its unique id, and GitHub deploys keep working throughout.

```sh
# 0. Who and where. Node 22.18 or later is needed (infra/.npmrc is engine-strict);
#    if CloudShell's node is older, install Node 22 for the session first (for example with nvm).
aws sts get-caller-identity          # your identity in the shared account, not :root
echo "$AWS_REGION"                   # eu-central-1 (CloudShell sets it to the console's region)
node --version
git clone https://github.com/UrsSchweigert/TheTasteOfCoffee.git && cd TheTasteOfCoffee
git log -1 --format='%H %s'          # the main commit that contains M1-T9
(cd backend && npm ci && npm run build)   # the stage stacks need the bundles to synthesise
cd infra && npm ci

# 1. Synthesise offline (both commands must pass every guard).
npx cdk synth --no-lookups --quiet
npx cdk synth --no-lookups --quiet -c cupmark:githubOidcImport=true
jq '.Resources.DeployRole' cdk.out/cupmark-github-oidc.template.json   # what the import will record

# 2. Check what exists (read-only).
aws iam list-open-id-connect-providers
#    must list arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com" \
  --query ClientIDList               # must contain sts.amazonaws.com
aws iam get-role --role-name CupmarkGitHubDeploy \
  --query 'Role.{Trust:AssumeRolePolicyDocument,Boundary:PermissionsBoundary,Tags:Tags,Path:Path,MaxSession:MaxSessionDuration,Description:Description}'
aws iam list-role-policies --role-name CupmarkGitHubDeploy            # exactly ["AssumeCdkBootstrapRoles"]
aws iam get-role-policy --role-name CupmarkGitHubDeploy --policy-name AssumeCdkBootstrapRoles
aws iam list-attached-role-policies --role-name CupmarkGitHubDeploy   # empty
aws cloudformation describe-stacks --stack-name cupmark-github-oidc   # must fail: "does not exist"
```

Compare step 2 with the template from step 1 and with the table above. The role must have: the trust with `StringEquals` (not `StringLike`) and exactly the two `sub` values, the four bootstrap role ARNs, no boundary, no tags, path `/`, a session duration of 3600 and no description. **If anything differs, stop and report it.** The template is then changed to match the role in a pull request before the import. Importing a role that differs from the template leaves silent drift (ADR 0018). If the provider does not exist, stop as well: `reference` would trust a provider that is not there.

```sh
# 3. Import the role into the new stack. CloudFormation takes the role as it is and changes nothing.
#    The CLI shows the resource to import; confirm it.
npx cdk import cupmark-github-oidc \
  -c cupmark:githubOidcImport=true \
  --resource-mapping import/cupmark-github-oidc.json \
  --toolkit-stack-name CDKToolkit-cupmark

# 4. Check that the stack exists and that the role matches the template.
aws cloudformation describe-stacks --stack-name cupmark-github-oidc \
  --query 'Stacks[0].[StackStatus,EnableTerminationProtection]'    # IMPORT_COMPLETE
ID="$(aws cloudformation detect-stack-drift --stack-name cupmark-github-oidc --query StackDriftDetectionId --output text)"
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$ID" \
  --query '[DetectionStatus,StackDriftStatus]'                     # repeat until DETECTION_COMPLETE; expect IN_SYNC
aws cloudformation describe-stack-resource-drifts --stack-name cupmark-github-oidc   # only if DRIFTED: shows the difference

# 5. The remaining drift: the committed template against the imported one.
npx cdk diff cupmark-github-oidc --toolkit-stack-name CDKToolkit-cupmark
#    expected: only [~] AWS::IAM::Role DeployRole, Tags [+] project=cupmark.
#    The same deploy also sets the stack tag project=cupmark, which cdk diff may not list.

# 6. Apply it: an in-place tag update, no replacement, no change to trust or permissions.
npx cdk deploy cupmark-github-oidc --toolkit-stack-name CDKToolkit-cupmark
aws iam list-role-tags --role-name CupmarkGitHubDeploy             # project=cupmark
#    run the drift check of step 4 again: IN_SYNC; termination protection is now true

# 7. From GitHub, run the "AWS OIDC check" workflow on main: it must still pass.
```

If step 4 reports `DRIFTED`, do not run steps 5 and 6. Report the difference. It is fixed in a pull request, by changing the template to match the role or the role to match the template, before anything else is deployed to this stack.

**The drift list before the deploy.** The import itself changes nothing. The only planned change afterwards is step 6: the tag `project=cupmark` on the role, and the stack tag. No boundary is added (ADR 0018). Later changes are each a reviewed pull request plus the same `cdk diff` and `cdk deploy` by the owner. The first expected one is `environment:prod` in the trust (M1-T7).

**Rolling back.**

- *The import fails* (for example `IMPORT_ROLLBACK_COMPLETE`, or a stack left in `REVIEW_IN_PROGRESS`): the role is unchanged, because imports never change resources. Remove the empty stack and start again. If termination protection was set, turn it off first: `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name cupmark-github-oidc`, then `aws cloudformation delete-stack --stack-name cupmark-github-oidc`. The role is `RETAIN`, so a stack delete never deletes it.
- *The tag update (step 6) fails:* CloudFormation rolls the update back on its own. The role keeps the imported state.
- *Undo the whole import* (stop managing the role as code): turn off termination protection and delete the stack, as above. The role stays, with its trust, its policy and (after step 6) its tag. `cdk destroy` is never used.
- *A later trust change breaks GitHub deploys:* revert the pull request, then the owner runs `npx cdk deploy cupmark-github-oidc` again with their own credentials. That does not need GitHub.

**Deleting the role needs the owner.** The stack never deletes it (`RETAIN`), `scripts/aws/apply-guardrails.sh` never touches it, and no agent may delete it. If the owner ever deletes it instead of importing it (ADR 0009 allows that), the stack recreates it under the same name and ARN, but with a new unique id. GitHub deploys fail until it exists again. The stack never creates a role under another name: the guard allows exactly `CupmarkGitHubDeploy` in this stack and no `Cupmark...` role name in the stage stacks.

**A fresh account** (no provider yet): `npx cdk deploy cupmark-github-oidc -c cupmark:githubOidcProvider=create --toolkit-stack-name CDKToolkit-cupmark`, with no import, after the `cupmark` bootstrap. Commit `create` to cdk.json in that case, so a later deploy does not drop the provider from the stack (it would stay in the account because it is `RETAIN`).

**For M1-T7.** The deploy workflow names the stage stacks (`-c stage=<stage>`, `cupmark-<stage>-core`) and never uses `--all`. With `-c stage=` the app does not contain `cupmark-github-oidc`. If the workflow ever tried to deploy it, the deploy would fail with AccessDenied, because the role can only assume the bootstrap roles.

## Parameters the owner creates

CloudFormation cannot create a SecureString, so the owner creates both per stage, once, with their own credentials (never an agent, never CI). Standard tier and the AWS-managed `aws/ssm` key: no fee. Neither command puts the value on the command line, so it never enters shell history or the process list. Run each for `STAGE=dev` and `STAGE=prod`.

Cursor signing key (ADR 0013), 32 random bytes as base64:

```sh
STAGE=dev
openssl rand -base64 32 | tr -d '\n' | aws ssm put-parameter \
  --region eu-central-1 \
  --name "/cupmark/$STAGE/cursor-key" \
  --type SecureString --tier Standard \
  --value file:///dev/stdin \
  --tags Key=project,Value=cupmark Key=stage,Value="$STAGE"
```

Sign in with Apple private key, from the `.p8` file downloaded from Apple (key id `3WKKAZFM6M`). Keep the file outside the repository (`*.p8` is gitignored anyway) and delete or lock it away afterwards:

```sh
STAGE=dev
aws ssm put-parameter \
  --region eu-central-1 \
  --name "/cupmark/$STAGE/apple-sign-in-key" \
  --type SecureString --tier Standard \
  --value "file://$HOME/path/outside/repo/AuthKey_3WKKAZFM6M.p8" \
  --tags Key=project,Value=cupmark Key=stage,Value="$STAGE"
```

The Apple provider is created at the first deploy from this parameter, so it must exist before that deploy.

Check without decrypting: `aws ssm describe-parameters --region eu-central-1 --parameter-filters Key=Name,Option=BeginsWith,Values=/cupmark/`. To rotate, run the same command with `--overwrite` and without `--tags` (the two cannot be combined); rotating the cursor key invalidates outstanding cursors (ADR 0013).

## Before the first deploy (owner)

1. **Re-apply the guardrails** with `scripts/aws/apply-guardrails.sh` (dry run first, then `--apply`). M1-T2 changed both policies:
   - `CupmarkBoundary`: `dynamodb:ConditionCheckItem` on `table/cupmark-*` (the repository's transactions use condition checks), and the four Cognito identity-provider actions on `userpool/*` in eu-central-1 for the Apple provider function (pools cannot be name-scoped; each role's own policy names its pool).
   - `CupmarkCfnExecution`: `s3:GetObject` on `cdk-cupmark-assets-<account>-eu-central-1/*`, so CloudFormation can create functions from the bootstrap's asset bucket.
   - `test/policies.test.ts` checks that the boundary allows everything the stack's roles are granted, and that the execution policy can read the code.

   M1-T6 (account deletion, ADR 0017) changed `CupmarkBoundary` again, so re-apply it even if you already applied the M1-T2 version:
   - two new statements: `AccountDeletionOfLabelPhotos` (`s3:DeleteObject`, `s3:DeleteObjectVersion` on `arn:aws:s3:::cupmark-*-photos-*/labels/*` and `/uploads/*`) and `AccountDeletionListPhotoVersions` (`s3:ListBucketVersions` on `arn:aws:s3:::cupmark-*-photos-*`), so no other bucket, the backups and the deletion log included, can have objects or versions deleted through the boundary;
   - `cognito-idp:AdminDeleteUser` added to the user-pool statement, renamed from `AppleIdentityProviderOfCupmarkPools` to `CognitoOfCupmarkPools`.

   Since M1-T9 the script no longer writes the inline policy of `CupmarkGitHubDeploy`. Its step 3 only prints that the stack `cupmark-github-oidc` owns the role, so re-applying the guardrails can never undo a change made through the stack. The script stays a dry run unless `--apply` is given, rejects any other argument, and stops at the first failed change (before M1-T9, `--apply` ignored failed commands and ended with exit status 1 even on success). `test/guardrails-script.test.ts` runs it against fake `aws` and `npx` commands.

   `CupmarkCfnExecution` is unchanged: its `s3:*` on `cupmark-*` already covers creating and configuring the deletion log bucket. Without the new boundary, `DELETE /account` fails with AccessDenied (500) at its first step; nothing else breaks.
2. **Create both SecureStrings per stage** (above): `/cupmark/<stage>/cursor-key` and `/cupmark/<stage>/apple-sign-in-key`.
3. **Check the Lambda concurrency quota.** Service Quotas → AWS Lambda → Concurrent executions, in eu-central-1. AWS keeps at least 100 unreserved, so the quota must be at least 100 plus the reserved total: 100 + 20 = 120, plus whatever other projects in the account reserve. New accounts often start at 10; ask for an increase (free) if needed.
4. **Import the GitHub deploy role** into `cupmark-github-oidc` and tag it ("One-time import", above). This is needed before the M1-T7 workflow deploys anything, but not before a stage deploy as such.
5. **Domain prefix risk.** Cognito prefix domains are unique per region across all AWS customers. If `cupmark-dev` or `cupmark-prod` is taken, the deploy fails at the domain, and a new prefix also means a new return URL in Apple's portal (and in this repo's tests).

Still unverified until the first dev deploy: whether CloudFormation's `AWS::Logs::LogGroup` handler also needs `logs:DescribeLogGroups` beyond `log-group:/aws/lambda/cupmark-*` (not added, because it could not be confirmed offline; an AccessDenied on the log groups would say so), and whether Cognito accepts empty Apple scopes.

## Outputs

The stack outputs, as plain `CfnOutput`s without exports: the table name, the stream ARN, the three bucket names, the user pool id, the app client id, the hosted domain URL and the API URL. Nothing imports them across stacks.

## Guards

`src/guards.ts` runs on every `cdk synth` and in `npm test`. Synth fails if any of these is found:

| Guard | Fails on |
| --- | --- |
| `resource-type` | A type on the deny list (WAF, NAT gateway, VPC endpoints, RDS, OpenSearch, ElastiCache, KMS keys, Secrets Manager, EC2 instances, EKS, Redshift, DocumentDB, Neptune, MSK and other fixed-fee or forbidden types), or any type not on the reviewed allow list. |
| `fixed-fee-property` | Provisioned concurrency on a Lambda alias or version, provisioned pollers, DynamoDB without on-demand billing or with a Kinesis stream. |
| `region` | A stack outside `eu-central-1`, or any other region id in a template or manifest. |
| `name` | A stack not built from `CupmarkStack` (or, for `cupmark-github-oidc` only, `CupmarkGitHubOidcStack`, which must have exactly that name and sit outside every stage), or a physical name without the `cupmark-<stage>-` prefix (`/aws/lambda/cupmark-<stage>-` or `/cupmark/<stage>/` for log groups). Names CloudFormation would generate outside the execution policy (log groups, schedule groups, budgets, Cognito domains, HTTP API names) are required. A Cognito domain prefix must be exactly `cupmark-<stage>`. |
| `tag` | A stack or taggable resource without `project=cupmark`. The one exception: `cupmark-github-oidc` in import mode (`-c cupmark:githubOidcImport=true`, ADR 0018). |
| `import` | `Fn::ImportValue`, any context lookup, any imported resource (`fromBucketName`, `fromLookup`, ...), `CfnInclude`, or an SSM parameter outside `/cupmark/<stage>/`. The one allowed reference is the asset bucket of the `cupmark` bootstrap (`cdk-cupmark-assets-*`) that holds the Lambda code. |
| `bootstrap` | A stack not on the `cupmark` bootstrap qualifier, or any reference to the shared default bootstrap. `cupmark-github-oidc` must use `CliCredentialsStackSynthesizer` with qualifier `cupmark`: no assume role, no execution role, template in `cdk-cupmark-assets-*`, and no asset besides its template. |
| `boundary` | An IAM role in a stage stack without the `CupmarkBoundary` permissions boundary. `CupmarkGitHubDeploy` has none (ADR 0018). |
| `isolation` | A template that names the other stage. |
| `stateful` | A DynamoDB table, S3 bucket or Cognito user pool, or any resource of `cupmark-github-oidc` (the role, the provider), that is not `Retain` on delete and on replacement; a table without deletion protection or point-in-time recovery; a bucket without versioning or without all four public access block settings; a user pool without `DeletionProtection: ACTIVE`. |
| `iam` | In a role's inline policies or an `AWS::IAM::Policy`: an action with `*` or `?`, `Resource: "*"`, a resource with `*` or `?` anywhere except the two `RESOURCE_WILDCARD_EXCEPTIONS` (S3 objects `<Cupmark bucket>[/<prefix>]/*`, because object keys are run-time ids; log streams `log-group:<Cupmark log group>:*`, because Lambda names the streams), so `table/cupmark-*`, `function:cupmark-*` or `parameter/cupmark/*` fail; `NotAction`, `NotResource` or `NotPrincipal`; a resource that is neither a resource of the same template (any suffix) nor a literal ARN whose resource part starts with its service's prefix in `OWNED_ARN_PREFIXES`: S3 bucket `cupmark-` (or the bootstrap's `cdk-cupmark-assets-`), DynamoDB `table/cupmark-`, Lambda `function:cupmark-`, SSM `parameter/cupmark/`, logs `log-group:/aws/lambda/cupmark-` or `log-group:/cupmark/`, IAM `role/cupmark-`, `role/Cupmark` or `policy/Cupmark` (`cupmark-` later in the path does not count; any other service fails closed, so the user pool may only be named by its ARN from the template); an ARN in another account; a value that cannot be resolved at synth time; any managed policy. `AWS_MANAGED_ARN_EXCEPTIONS` lists the AWS-managed ARNs allowed anyway: none. Only in `cupmark-github-oidc`, `GITHUB_OIDC_ARN_PREFIXES` adds IAM `role/cdk-cupmark-` (the bootstrap roles); a stage role naming them fails. An `AWS::S3::BucketPolicy` with any Allow statement fails: bucket policies may only deny (the TLS-only policy, whose `s3:*` and Principal `*` sit in Deny statements). |
| `trust` | A role's trust policy with anything but Allow statements with one principal: in a stage stack, only a service on `TRUSTED_SERVICE_PRINCIPALS` (`lambda.amazonaws.com`) with `sts:AssumeRole`; in `cupmark-github-oidc`, only the GitHub provider (`arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, the one documented foreign ARN, or the stack's own provider in create mode) with `sts:AssumeRoleWithWebIdentity`, a `StringEquals`-only condition, `aud` exactly `sts.amazonaws.com` and literal `sub` values of `repo:UrsSchweigert/TheTasteOfCoffee:`. `AWS` and `*` principals fail everywhere. |

`test/logical-ids.test.ts` pins the logical ids of the table, the three buckets and the user pool. A rename or move of their constructs would make CloudFormation create new, empty resources and orphan the old ones (they are `RETAIN`); the test fails first. Changing a pinned id needs a migration plan, not a snapshot update.

Adding a new resource type means adding it, with its name rule, to `ALLOWED_RESOURCE_TYPES` in a reviewed pull request, and adding the matching permissions to `scripts/aws/cupmark-cfn-execution-policy.json` (ADR 0002).

## Telemetry

`cdk.json` turns off CDK library version reporting (no `AWS::CDK::Metadata` resource) and CLI telemetry, and disables context lookups.
