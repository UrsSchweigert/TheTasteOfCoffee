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
src/guards.ts      synth-time guards for invariants 5, 6 and 9
test/              Vitest tests
```

## Stages and stacks

- Two stages, `dev` and `prod`, built from the same code. Nothing is shared between them.
- Every stack extends `CupmarkStack`: named `cupmark-<stage>-<part>`, region pinned to `eu-central-1`, `DefaultStackSynthesizer` with qualifier `cupmark` (roles `cdk-cupmark-*`), termination protection on, stack tags `project=cupmark` and `stage=<stage>`.
- `CupmarkStage` tags every resource `project=cupmark` and `stage=<stage>`, and gives every IAM role the `CupmarkBoundary` permissions boundary, which `CupmarkCfnExecution` requires.
- M0 has one empty stack per stage, `cupmark-<stage>-core`. The CDK CLI skips deploying a stack without resources.

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

Adding a new resource type means adding it, with its name rule, to `ALLOWED_RESOURCE_TYPES` in a reviewed pull request, and adding the matching permissions to `scripts/aws/cupmark-cfn-execution-policy.json` (ADR 0002).

## Telemetry

`cdk.json` turns off CDK library version reporting (no `AWS::CDK::Metadata` resource) and CLI telemetry, and disables context lookups.
