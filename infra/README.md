# Infra

The AWS CDK v2 app of Cupmark (TypeScript, ESM). Design: `docs/05-system-design.md`; cost: `docs/06-cost-estimate.md`; account isolation: `docs/decisions/0002-isolate-from-existing-aws-resources.md`.

**Deploys happen only through the human-approved GitHub Actions workflow (M1-T7).** Nobody runs `cdk deploy`, `cdk destroy` or `cdk bootstrap` from a laptop or an agent session. The Cupmark bootstrap (`CDKToolkit-cupmark`, qualifier `cupmark`) is created once by a human with `scripts/aws/apply-guardrails.sh --apply`.

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

`npm run synth -- -c stage=dev` synthesises one stage. The target account comes from `-c cupmark:<stage>:account=<id>`, else from `CDK_DEFAULT_ACCOUNT` (set by the CDK CLI when credentials are present), else the stacks are account-agnostic. No account id is written in this repo.

## Layout

```
bin/cupmark.ts     entry point (cdk.json "app"): builds, synthesises, runs the guards
src/config.ts      region, tag, name prefix, bootstrap qualifier, stage names
src/app.ts         builds the App with the selected stages
src/stage.ts       CupmarkStage (one per environment) and CupmarkStack (base of every stack)
src/data.ts        the DynamoDB table and the two S3 buckets (M1-T1)
src/identity.ts    the Cognito user pool, its domain, the iOS app client and the Apple provider (M1-T2)
src/functions.ts   one Lambda function: bundle, role, concurrency cap, 14-day log group
src/api.ts         the HTTP API, its authorizer and stage, the api and health functions (M1-T2)
src/routes.ts      the route list, checked against contracts/openapi.yaml
src/guards.ts      synth-time guards for invariants 5, 6 and 9, and least privilege
test/              Vitest tests
```

## Stages and stacks

- Two stages, `dev` and `prod`, built from the same code. Nothing is shared between them.
- Every stack extends `CupmarkStack`: named `cupmark-<stage>-<part>`, region pinned to `eu-central-1`, `DefaultStackSynthesizer` with qualifier `cupmark` (roles `cdk-cupmark-*`), termination protection on, stack tags `project=cupmark` and `stage=<stage>`.
- `CupmarkStage` tags every resource `project=cupmark` and `stage=<stage>`, and gives every IAM role the `CupmarkBoundary` permissions boundary, which `CupmarkCfnExecution` requires.
- Each stage has one stack, `cupmark-<stage>-core`. It holds the data, identity and API resources below.

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

Both buckets: all public access blocked, object ownership `BucketOwnerEnforced` (ACLs off), versioning on, S3-managed encryption (SSE-S3), a bucket policy that denies any request without TLS or with TLS older than 1.2, `RETAIN`. Names are `cupmark-<stage>-<part>-<account id>` because bucket names are global.

| Bucket | Holds | Lifecycle |
| --- | --- | --- |
| `cupmark-<stage>-photos-<account>` | Label photos of unverified beans (F1), uploaded with presigned URLs (M1-T4), seen only by the operator; and, under `catalogue/`, the catalogue's copies of Open Food Facts images (ADR 0011), which never expire | Objects under `verified/` expire 90 days after they were written. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 1 day. Expired delete markers are removed. |
| `cupmark-<stage>-backups-<account>` | The weekly full table export | Moves to S3 Glacier Flexible Retrieval after 30 days and expires after 365 days. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 7 days. Expired delete markers are removed. |

- **Label photos.** `docs/06-cost-estimate.md` says "delete label photos 90 days after the bean is verified". Lifecycle rules count from an object's creation, not from a later event, so the convention is: when the operator verifies a bean, the tooling copies its photo to `verified/<beanId>/...` (a new object with a new creation date) and deletes the original. Photos of beans still in review never expire by lifecycle. Because the bucket is versioned, an expired or deleted photo stays as a noncurrent version for 30 more days, so it is gone for good about 120 days after verification.
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
| api | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `ConditionCheckItem` (the repository's transactions are authorised per contained action) | the table |
| api | `dynamodb:Query` | the index `gsi1` |
| api | `ssm:GetParameter` | exactly `/cupmark/<stage>/cursor-key` (the AWS-managed `aws/ssm` key needs no grant) |
| api | `s3:GetObject`, `s3:PutObject` | `cupmark-<stage>-photos-<account>/catalogue/*` |
| apple-idp | `ssm:GetParameter` | exactly `/cupmark/<stage>/apple-sign-in-key` |
| apple-idp | `cognito-idp:CreateIdentityProvider`, `UpdateIdentityProvider`, `DeleteIdentityProvider`, `DescribeIdentityProvider` | the stage's user pool |

**API function environment:** `TABLE_NAME` (`cupmark-<stage>-main`), `CURSOR_KEY_PARAMETER` (`/cupmark/<stage>/cursor-key`), `PHOTO_BUCKET` (`cupmark-<stage>-photos-<account>`, where the API stores and serves `catalogue/` images), `NODE_OPTIONS=--enable-source-maps`. No secret is in the environment.

**Outbound HTTPS.** The functions are not in a VPC. A Lambda function outside a VPC has internet access through the Lambda service, so the API function reaches the Open Food Facts API and image host over HTTPS without a VPC, NAT gateway or VPC endpoint (all fixed-fee, invariant 5). Which hosts it calls is the backend's concern (docs/05, Barcode lookup); there is no egress filter, which would need a NAT gateway or a firewall.

**Not done, on purpose:** no API access logging (it would need a log delivery setup and adds log charges; the function logs one line per request); no custom domain (would need ACM and Route 53, denied by `CupmarkCfnExecution`).

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
2. **Create both SecureStrings per stage** (above): `/cupmark/<stage>/cursor-key` and `/cupmark/<stage>/apple-sign-in-key`.
3. **Check the Lambda concurrency quota.** Service Quotas → AWS Lambda → Concurrent executions, in eu-central-1. AWS keeps at least 100 unreserved, so the quota must be at least 100 plus the reserved total: 100 + 20 = 120, plus whatever other projects in the account reserve. New accounts often start at 10; ask for an increase (free) if needed.
4. **Domain prefix risk.** Cognito prefix domains are unique per region across all AWS customers. If `cupmark-dev` or `cupmark-prod` is taken, the deploy fails at the domain, and a new prefix also means a new return URL in Apple's portal (and in this repo's tests).

Still unverified until the first dev deploy: whether CloudFormation's `AWS::Logs::LogGroup` handler also needs `logs:DescribeLogGroups` beyond `log-group:/aws/lambda/cupmark-*` (not added, because it could not be confirmed offline; an AccessDenied on the log groups would say so), and whether Cognito accepts empty Apple scopes.

## Outputs

The stack outputs, as plain `CfnOutput`s without exports: the table name, the stream ARN, both bucket names, the user pool id, the app client id, the hosted domain URL and the API URL. Nothing imports them across stacks.

## Guards

`src/guards.ts` runs on every `cdk synth` and in `npm test`. Synth fails if any of these is found:

| Guard | Fails on |
| --- | --- |
| `resource-type` | A type on the deny list (WAF, NAT gateway, VPC endpoints, RDS, OpenSearch, ElastiCache, KMS keys, Secrets Manager, EC2 instances, EKS, Redshift, DocumentDB, Neptune, MSK and other fixed-fee or forbidden types), or any type not on the reviewed allow list. |
| `fixed-fee-property` | Provisioned concurrency on a Lambda alias or version, provisioned pollers, DynamoDB without on-demand billing or with a Kinesis stream. |
| `region` | A stack outside `eu-central-1`, or any other region id in a template or manifest. |
| `name` | A stack not built from `CupmarkStack`, or a physical name without the `cupmark-<stage>-` prefix (`/aws/lambda/cupmark-<stage>-` or `/cupmark/<stage>/` for log groups). Names CloudFormation would generate outside the execution policy (log groups, schedule groups, budgets, Cognito domains, HTTP API names) are required. A Cognito domain prefix must be exactly `cupmark-<stage>`. |
| `tag` | A stack or taggable resource without `project=cupmark`. |
| `import` | `Fn::ImportValue`, any context lookup, any imported resource (`fromBucketName`, `fromLookup`, ...), `CfnInclude`, or an SSM parameter outside `/cupmark/<stage>/`. The one allowed reference is the asset bucket of the `cupmark` bootstrap (`cdk-cupmark-assets-*`) that holds the Lambda code. |
| `bootstrap` | A stack not on the `cupmark` bootstrap qualifier, or any reference to the shared default bootstrap. |
| `boundary` | An IAM role without the `CupmarkBoundary` permissions boundary. |
| `isolation` | A template that names the other stage. |
| `stateful` | A DynamoDB table, S3 bucket or Cognito user pool that is not `Retain` on delete and on replacement; a table without deletion protection or point-in-time recovery; a bucket without versioning or without all four public access block settings; a user pool without `DeletionProtection: ACTIVE`. |
| `iam` | In a role's inline policies or an `AWS::IAM::Policy`: an action with `*`, `Resource: "*"`, `NotAction`, `NotResource` or `NotPrincipal`; a resource that is neither a resource of the same template (any suffix) nor a literal ARN whose resource part starts with its service's prefix in `OWNED_ARN_PREFIXES`: S3 bucket `cupmark-` (or the bootstrap's `cdk-cupmark-assets-`), DynamoDB `table/cupmark-`, Lambda `function:cupmark-`, SSM `parameter/cupmark/`, logs `log-group:/aws/lambda/cupmark-` or `log-group:/cupmark/`, IAM `role/cupmark-`, `role/Cupmark` or `policy/Cupmark` (`cupmark-` later in the path does not count; any other service fails closed, so the user pool may only be named by its ARN from the template); an ARN in another account; a value that cannot be resolved at synth time; any managed policy. `AWS_MANAGED_ARN_EXCEPTIONS` lists the AWS-managed ARNs allowed anyway: none. |

`test/logical-ids.test.ts` pins the logical ids of the table, both buckets and the user pool. A rename or move of their constructs would make CloudFormation create new, empty resources and orphan the old ones (they are `RETAIN`); the test fails first. Changing a pinned id needs a migration plan, not a snapshot update.

Adding a new resource type means adding it, with its name rule, to `ALLOWED_RESOURCE_TYPES` in a reviewed pull request, and adding the matching permissions to `scripts/aws/cupmark-cfn-execution-policy.json` (ADR 0002).

## Telemetry

`cdk.json` turns off CDK library version reporting (no `AWS::CDK::Metadata` resource) and CLI telemetry, and disables context lookups.
