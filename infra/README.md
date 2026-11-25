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

`npm run synth -- -c stage=dev` synthesises one stage. The target account comes from `-c cupmark:<stage>:account=<id>`, else from `CDK_DEFAULT_ACCOUNT` (set by the CDK CLI when credentials are present), else the stacks are account-agnostic. No account id is written in this repo.

## Layout

```
bin/cupmark.ts     entry point (cdk.json "app"): builds, synthesises, runs the guards
src/config.ts      region, tag, name prefix, bootstrap qualifier, stage names
src/app.ts         builds the App with the selected stages
src/stage.ts       CupmarkStage (one per environment) and CupmarkStack (base of every stack)
src/data.ts        the DynamoDB table and the two S3 buckets (M1-T1)
src/guards.ts      synth-time guards for invariants 5, 6 and 9
test/              Vitest tests
```

## Stages and stacks

- Two stages, `dev` and `prod`, built from the same code. Nothing is shared between them.
- Every stack extends `CupmarkStack`: named `cupmark-<stage>-<part>`, region pinned to `eu-central-1`, `DefaultStackSynthesizer` with qualifier `cupmark` (roles `cdk-cupmark-*`), termination protection on, stack tags `project=cupmark` and `stage=<stage>`.
- `CupmarkStage` tags every resource `project=cupmark` and `stage=<stage>`, and gives every IAM role the `CupmarkBoundary` permissions boundary, which `CupmarkCfnExecution` requires.
- Each stage has one stack, `cupmark-<stage>-core`. It holds the data resources below; identity, API and functions follow in M1.

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
| TTL | none | No item in the data model expires. |
| Table class | `STANDARD` | |

**Index `gsi1` (review queue).** Keys `gsi1pk` (S) and `gsi1sk` (S), projection `ALL`. It is sparse: only items that carry both attributes appear in it.

| Item | `gsi1pk` | `gsi1sk` | When |
| --- | --- | --- | --- |
| Bean (`BEAN#<beanId>` / `META`) with status unverified | `REVIEW#UNVERIFIED` | `<createdAt ISO 8601>#<beanId>` | Set when the bean is created unverified (F1, M1-T4). |

Verifying (or rejecting) a bean removes both attributes in the same write, which drops it from the queue. No other item sets `gsi1pk` or `gsi1sk`. The repository module (M1-T3) owns these formats; this table is the contract.

### Buckets

Both buckets: all public access blocked, object ownership `BucketOwnerEnforced` (ACLs off), versioning on, S3-managed encryption (SSE-S3), a bucket policy that denies any request without TLS or with TLS older than 1.2, `RETAIN`. Names are `cupmark-<stage>-<part>-<account id>` because bucket names are global.

| Bucket | Holds | Lifecycle |
| --- | --- | --- |
| `cupmark-<stage>-photos-<account>` | Label photos of unverified beans (F1), uploaded with presigned URLs (M1-T4), seen only by the operator | Objects under `verified/` expire 90 days after they were written. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 1 day. Expired delete markers are removed. |
| `cupmark-<stage>-backups-<account>` | The weekly full table export | Moves to S3 Glacier Flexible Retrieval after 30 days and expires after 365 days. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 7 days. Expired delete markers are removed. |

- **Label photos.** `docs/06-cost-estimate.md` says "delete label photos 90 days after the bean is verified". Lifecycle rules count from an object's creation, not from a later event, so the convention is: when the operator verifies a bean, the tooling copies its photo to `verified/<beanId>/...` (a new object with a new creation date) and deletes the original. Photos of beans still in review never expire by lifecycle. Because the bucket is versioned, an expired or deleted photo stays as a noncurrent version for 30 more days, so it is gone for good about 120 days after verification.
- **Backups.** Glacier Flexible Retrieval restores in hours (standard retrieval 3 to 5 hours), which matches the "restore within a few hours" target; the newest four exports are still in S3 Standard, and point-in-time recovery covers the last 35 days anyway. Its 90-day minimum storage duration is well inside the one-year retention.
- **No access logging.** S3 server access logs need a third bucket, which then needs its own retention and safety properties, and they add storage and request charges per log object. CloudTrail (account level) already records bucket-level API calls. Revisit if the photo bucket ever needs per-object audit.
- **No replication.** Replicating the backup bucket to Ireland (eu-west-1) is optional in the design and is not done. It is a follow-up: it would need a replication role, a second bucket in another region (an exception to the region guard) and a change to `CupmarkCfnExecution`, which denies every region but eu-central-1.

### Outputs

The stack outputs the table name, the stream ARN and both bucket names as plain `CfnOutput`s, without exports. Nothing imports them across stacks.

## Guards

`src/guards.ts` runs on every `cdk synth` and in `npm test`. Synth fails if any of these is found:

| Guard | Fails on |
| --- | --- |
| `resource-type` | A type on the deny list (WAF, NAT gateway, VPC endpoints, RDS, OpenSearch, ElastiCache, KMS keys, Secrets Manager, EC2 instances, EKS, Redshift, DocumentDB, Neptune, MSK and other fixed-fee or forbidden types), or any type not on the reviewed allow list. |
| `fixed-fee-property` | Provisioned concurrency on a Lambda alias or version, provisioned pollers, DynamoDB without on-demand billing or with a Kinesis stream. |
| `region` | A stack outside `eu-central-1`, or any other region id in a template or manifest. |
| `name` | A stack not built from `CupmarkStack`, or a physical name without the `cupmark-<stage>-` prefix (`/aws/lambda/cupmark-<stage>-` or `/cupmark/<stage>/` for log groups). Names CloudFormation would generate outside the execution policy (log groups, schedule groups, budgets, Cognito domains, HTTP API names) are required. |
| `tag` | A stack or taggable resource without `project=cupmark`. |
| `import` | `Fn::ImportValue`, any context lookup, any imported resource (`fromBucketName`, `fromLookup`, ...), `CfnInclude`, or an SSM parameter outside `/cupmark/<stage>/`. |
| `bootstrap` | A stack not on the `cupmark` bootstrap qualifier, or any reference to the shared default bootstrap. |
| `boundary` | An IAM role without the `CupmarkBoundary` permissions boundary. |
| `isolation` | A template that names the other stage. |
| `stateful` | A DynamoDB table or S3 bucket that is not `Retain` on delete and on replacement; a table without deletion protection or point-in-time recovery; a bucket without versioning or without all four public access block settings. |

Adding a new resource type means adding it, with its name rule, to `ALLOWED_RESOURCE_TYPES` in a reviewed pull request, and adding the matching permissions to `scripts/aws/cupmark-cfn-execution-policy.json` (ADR 0002).

## Telemetry

`cdk.json` turns off CDK library version reporting (no `AWS::CDK::Metadata` resource) and CLI telemetry, and disables context lookups.
