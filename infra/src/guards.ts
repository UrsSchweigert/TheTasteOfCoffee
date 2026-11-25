// Synth-time guards for CLAUDE.md invariants 5 (pay-per-use only), 6 (eu-central-1)
// and 9 (never touch existing infrastructure), for least privilege, and for deployability under
// scripts/aws/cupmark-cfn-execution-policy.json (ADR 0002).
//
// `checkApp` synthesises an app and returns every violation. It runs in two places:
// bin/cupmark.ts (so `cdk synth` fails) and the Vitest suite (over both stages, plus
// throwaway stacks that prove each guard can fail).
//
// Resource types are checked against a deny list AND an allow list. The deny list
// gives a precise reason for known fixed-fee or forbidden types. The allow list holds
// only the types docs/05-system-design.md needs; any other type fails as "not
// reviewed" until someone adds it here, with its name rule, in a reviewed pull
// request. A deny list alone would let a new fixed-fee type through unnoticed.
//
// Two kinds of stack exist: the stage stacks (CupmarkStack, deployed by CI through
// CupmarkCfnExecution) and the one `cupmark-github-oidc` (CupmarkGitHubOidcStack,
// deployed once by the owner, ADR 0009). The second has its own, much shorter allow
// list and a few documented differences, each marked "GitHub OIDC stack" below.

import { CfnResource, CliCredentialsStackSynthesizer, DefaultStackSynthesizer, Resource, Stack, Stage, TagManager, Token } from 'aws-cdk-lib';
import type { App } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { AssetManifestArtifact } from 'aws-cdk-lib/cx-api';
import type { IConstruct } from 'constructs';
import {
  BOOTSTRAP_QUALIFIER,
  NAME_PREFIX,
  PERMISSIONS_BOUNDARY_NAME,
  PROJECT_TAG_KEY,
  PROJECT_TAG_VALUE,
  REGION,
  STAGES,
} from './config.ts';
import type { StageName } from './config.ts';
import {
  CupmarkGitHubOidcStack,
  GITHUB_DEPLOY_ROLE_NAME,
  GITHUB_DEPLOY_SUBJECTS,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_HOST,
  GITHUB_OIDC_STACK_NAME,
  GITHUB_REPOSITORY,
} from './github-oidc.ts';
import { CupmarkStack } from './stage.ts';

export type GuardName =
  | 'resource-type'
  | 'fixed-fee-property'
  | 'region'
  | 'name'
  | 'tag'
  | 'import'
  | 'bootstrap'
  | 'boundary'
  | 'isolation'
  | 'stateful'
  | 'iam'
  | 'trust';

export interface Violation {
  readonly guard: GuardName;
  /** Stack name, or the construct path when there is no stack. */
  readonly stack: string;
  /** Logical id, construct path or template location. */
  readonly where: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

interface DeniedType {
  /** Exact type, or a namespace ending in `::` that matches every type in it. */
  readonly match: string;
  readonly reason: string;
}

const FIXED_FEE = 'fixed monthly or hourly fee (invariant 5)';
const FOREIGN = 'denied by CupmarkCfnExecution and invariant 9';

export const DENIED_RESOURCE_TYPES: readonly DeniedType[] = [
  { match: 'AWS::WAFv2::', reason: `WAF: ${FIXED_FEE}` },
  { match: 'AWS::WAF::', reason: `WAF Classic: ${FIXED_FEE}` },
  { match: 'AWS::WAFRegional::', reason: `WAF Classic regional: ${FIXED_FEE}` },
  { match: 'AWS::Shield::', reason: `Shield Advanced: ${FIXED_FEE}` },
  { match: 'AWS::EC2::NatGateway', reason: `NAT gateway: ${FIXED_FEE}` },
  { match: 'AWS::EC2::VPCEndpoint', reason: `VPC endpoint: ${FIXED_FEE}` },
  { match: 'AWS::EC2::VPCEndpointService', reason: `VPC endpoint service: ${FIXED_FEE}` },
  { match: 'AWS::EC2::Instance', reason: `EC2 instance: ${FIXED_FEE}` },
  { match: 'AWS::EC2::EIP', reason: `public IPv4 address: ${FIXED_FEE}` },
  { match: 'AWS::EC2::TransitGateway', reason: `transit gateway: ${FIXED_FEE}` },
  { match: 'AWS::EC2::VPNConnection', reason: `site-to-site VPN: ${FIXED_FEE}` },
  { match: 'AWS::EC2::ClientVpnEndpoint', reason: `client VPN: ${FIXED_FEE}` },
  { match: 'AWS::EC2::VPC', reason: `no VPC in the design; ${FOREIGN} (ec2:CreateVpc*)` },
  { match: 'AWS::RDS::', reason: `RDS and Aurora: ${FIXED_FEE}` },
  { match: 'AWS::OpenSearchService::', reason: `OpenSearch: ${FIXED_FEE}` },
  { match: 'AWS::OpenSearchServerless::', reason: `OpenSearch Serverless (minimum OCUs): ${FIXED_FEE}` },
  { match: 'AWS::Elasticsearch::', reason: `Elasticsearch: ${FIXED_FEE}` },
  { match: 'AWS::ElastiCache::', reason: `ElastiCache: ${FIXED_FEE}` },
  { match: 'AWS::MemoryDB::', reason: `MemoryDB: ${FIXED_FEE}` },
  { match: 'AWS::KMS::Key', reason: `customer-managed KMS key: ${FIXED_FEE}` },
  { match: 'AWS::KMS::ReplicaKey', reason: `customer-managed KMS key: ${FIXED_FEE}` },
  { match: 'AWS::SecretsManager::', reason: `Secrets Manager: ${FIXED_FEE}; use Parameter Store` },
  { match: 'AWS::EKS::', reason: `EKS: ${FIXED_FEE}` },
  { match: 'AWS::Redshift::', reason: `Redshift: ${FIXED_FEE}` },
  { match: 'AWS::RedshiftServerless::', reason: `Redshift Serverless (base capacity): ${FIXED_FEE}` },
  { match: 'AWS::DocDB::', reason: `DocumentDB: ${FIXED_FEE}` },
  { match: 'AWS::DocDBElastic::', reason: `DocumentDB Elastic: ${FIXED_FEE}` },
  { match: 'AWS::Neptune::', reason: `Neptune: ${FIXED_FEE}` },
  { match: 'AWS::NeptuneGraph::', reason: `Neptune Analytics: ${FIXED_FEE}` },
  { match: 'AWS::MSK::', reason: `MSK (Kafka): ${FIXED_FEE}` },
  { match: 'AWS::Kinesis::Stream', reason: `Kinesis stream (shard or stream hours): ${FIXED_FEE}` },
  { match: 'AWS::AmazonMQ::', reason: `Amazon MQ broker: ${FIXED_FEE}` },
  { match: 'AWS::ElasticLoadBalancing::', reason: `load balancer: ${FIXED_FEE}` },
  { match: 'AWS::ElasticLoadBalancingV2::', reason: `load balancer: ${FIXED_FEE}` },
  { match: 'AWS::NetworkFirewall::', reason: `Network Firewall: ${FIXED_FEE}` },
  { match: 'AWS::GlobalAccelerator::', reason: `Global Accelerator: ${FIXED_FEE}` },
  { match: 'AWS::DirectoryService::', reason: `Directory Service: ${FIXED_FEE}` },
  { match: 'AWS::Transfer::', reason: `Transfer Family server: ${FIXED_FEE}` },
  { match: 'AWS::FSx::', reason: `FSx: ${FIXED_FEE}` },
  { match: 'AWS::SageMaker::Endpoint', reason: `SageMaker endpoint: ${FIXED_FEE}` },
  { match: 'AWS::Route53::', reason: `Route 53 (no new hosted zones or records): ${FOREIGN}` },
  { match: 'AWS::Route53Resolver::', reason: `Route 53 Resolver: ${FOREIGN}` },
  { match: 'AWS::CloudFront::', reason: `CloudFront: ${FOREIGN}` },
  { match: 'AWS::CertificateManager::', reason: `ACM: ${FOREIGN}` },
];

interface NameRule {
  /** Property path inside `Properties`. */
  readonly path: readonly string[];
  /** Allowed prefixes; `{stage}` is replaced with the stack's stage. */
  readonly prefixes: readonly string[];
  /**
   * True when CloudFormation's generated default name would not match
   * CupmarkCfnExecution, so the name must be set explicitly.
   */
  readonly required: boolean;
  /** True when the name must equal one of `prefixes` exactly (Cognito domain prefixes). */
  readonly exact?: boolean;
}

export interface ResourceRule {
  /** Why the type is expected (docs/05-system-design.md). */
  readonly why: string;
  readonly names: readonly NameRule[];
}

const STAGE_PREFIX = `${NAME_PREFIX}{stage}-`;
const optionalName = (prop: string): NameRule => ({ path: [prop], prefixes: [STAGE_PREFIX], required: false });
const requiredName = (prop: string): NameRule => ({ path: [prop], prefixes: [STAGE_PREFIX], required: true });

/**
 * The types the app is expected to use. Unnamed resources get a CloudFormation name
 * that starts with the stack name (`cupmark-<stage>-...`), which matches the execution
 * policy; where it would not, the rule makes the name required.
 */
export const ALLOWED_RESOURCE_TYPES: Readonly<Record<string, ResourceRule>> = {
  'AWS::DynamoDB::Table': { why: 'the one table', names: [optionalName('TableName')] },
  'AWS::S3::Bucket': { why: 'photo, backup and deletion-log buckets', names: [optionalName('BucketName')] },
  'AWS::S3::BucketPolicy': { why: 'TLS-only bucket policy', names: [] },
  'AWS::Lambda::Function': { why: 'API and worker functions', names: [optionalName('FunctionName')] },
  'AWS::Lambda::Permission': { why: 'API Gateway and Scheduler invoke', names: [] },
  'AWS::Lambda::EventSourceMapping': { why: 'table stream to aggregator', names: [] },
  'AWS::Logs::LogGroup': {
    why: '14-day log retention',
    names: [{ path: ['LogGroupName'], prefixes: ['/aws/lambda/cupmark-{stage}-', '/cupmark/{stage}/'], required: true }],
  },
  'AWS::IAM::Role': { why: 'one least-privilege role per function', names: [optionalName('RoleName')] },
  // Inline policy names are not ARNs; CupmarkCfnExecution scopes iam:PutRolePolicy by role.
  'AWS::IAM::Policy': { why: 'inline policies of the function roles', names: [] },
  'AWS::Cognito::UserPool': { why: 'Sign in with Apple', names: [optionalName('UserPoolName')] },
  'AWS::Cognito::UserPoolClient': { why: 'iOS app client', names: [optionalName('ClientName')] },
  'AWS::Cognito::UserPoolIdentityProvider': { why: 'Apple identity provider', names: [] },
  // ADR 0015: the deploy-time resource that creates the Sign in with Apple provider.
  'Custom::CupmarkAppleIdentityProvider': { why: 'Sign in with Apple provider (ADR 0015)', names: [] },
  'AWS::Cognito::UserPoolDomain': {
    why: 'hosted domain for the Apple flow',
    // Exactly `cupmark-<stage>`: the owner registered that return URL with Apple (M0-T7).
    names: [{ path: ['Domain'], prefixes: [`${NAME_PREFIX}{stage}`], required: true, exact: true }],
  },
  'AWS::ApiGatewayV2::Api': { why: 'HTTP API', names: [requiredName('Name')] },
  'AWS::ApiGatewayV2::Stage': { why: 'HTTP API stage with throttling', names: [] },
  'AWS::ApiGatewayV2::Route': { why: 'HTTP API routes', names: [] },
  'AWS::ApiGatewayV2::Integration': { why: 'Lambda integrations', names: [] },
  'AWS::ApiGatewayV2::Authorizer': { why: 'built-in JWT authorizer', names: [] },
  'AWS::Scheduler::ScheduleGroup': { why: 'group for the schedules', names: [optionalName('Name')] },
  'AWS::Scheduler::Schedule': {
    why: 'nightly rankings and weekly export',
    // The policy allows schedule/cupmark-*/*: the default group would be denied.
    names: [requiredName('GroupName'), optionalName('Name')],
  },
  'AWS::CloudWatch::Alarm': { why: 'Lambda errors and throttles', names: [optionalName('AlarmName')] },
  'AWS::SNS::Topic': { why: 'alarm notifications', names: [optionalName('TopicName')] },
  'AWS::SNS::Subscription': { why: 'alarm notifications', names: [] },
  'AWS::Budgets::Budget': {
    why: 'alerts at 10, 25 and 50 USD',
    names: [{ path: ['Budget', 'BudgetName'], prefixes: [STAGE_PREFIX], required: true }],
  },
};

/**
 * GitHub OIDC stack: the only types it may hold, with exact names. In no other stack
 * is `AWS::IAM::OIDCProvider` allowed, and no other role may be `CupmarkGitHubDeploy`
 * (a stage role must start with `cupmark-<stage>-`).
 */
export const GITHUB_OIDC_RESOURCE_TYPES: Readonly<Record<string, ResourceRule>> = {
  'AWS::IAM::Role': {
    why: 'the GitHub deploy role (ADR 0009)',
    names: [{ path: ['RoleName'], prefixes: [GITHUB_DEPLOY_ROLE_NAME], required: true, exact: true }],
  },
  'AWS::IAM::OIDCProvider': {
    why: 'the GitHub OIDC provider, create mode only (ADR 0009)',
    // IAM names the provider after its URL; invariant 9's prefix cannot apply.
    names: [{ path: ['Url'], prefixes: [`https://${GITHUB_OIDC_HOST}`], required: true, exact: true }],
  },
};

function deniedReason(type: string): string | undefined {
  const hit = DENIED_RESOURCE_TYPES.find((d) => (d.match.endsWith('::') ? type.startsWith(d.match) : type === d.match));
  return hit?.reason;
}

/** Properties that turn an otherwise pay-per-use type into a fixed fee. */
function fixedFeeProperties(type: string, props: Record<string, unknown>): string[] {
  const found: string[] = [];
  if ((type === 'AWS::Lambda::Alias' || type === 'AWS::Lambda::Version') && props.ProvisionedConcurrencyConfig !== undefined) {
    found.push('ProvisionedConcurrencyConfig: provisioned concurrency is billed per hour');
  }
  if (type === 'AWS::Lambda::EventSourceMapping' && props.ProvisionedPollerConfig !== undefined) {
    found.push('ProvisionedPollerConfig: provisioned pollers are billed per hour');
  }
  if (type === 'AWS::DynamoDB::Table' || type === 'AWS::DynamoDB::GlobalTable') {
    if (props.BillingMode !== 'PAY_PER_REQUEST') {
      found.push('BillingMode must be PAY_PER_REQUEST; provisioned capacity is billed per hour');
    }
    if (props.KinesisStreamSpecification !== undefined) {
      found.push('KinesisStreamSpecification: a Kinesis stream is billed per hour; use DynamoDB Streams');
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Stateful resources
// ---------------------------------------------------------------------------

/**
 * Types that hold data. Each must survive stack deletion and resource replacement
 * (DeletionPolicy and UpdateReplacePolicy Retain) and carry its own safety net:
 * deletion protection and point-in-time recovery for tables, versioning and a full
 * public access block for buckets (docs/05-system-design.md, Persistence and recovery),
 * deletion protection for the user pool, whose user ids key every `USER#<sub>`
 * partition: losing the pool would orphan all user data.
 */
export const STATEFUL_RESOURCE_TYPES: readonly string[] = [
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::S3::Bucket',
  'AWS::Cognito::UserPool',
];

const PUBLIC_ACCESS_BLOCK = ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'];

/**
 * `retainAll`: GitHub OIDC stack. Its role and provider hold no data, but deleting them
 * would cut off every deploy, and the role predates the stack (ADR 0009), so every
 * resource there must be Retain too.
 */
function statefulProblems(type: string, resource: unknown, props: Record<string, unknown>, retainAll = false): string[] {
  if (!retainAll && !STATEFUL_RESOURCE_TYPES.includes(type)) return [];
  const found: string[] = [];
  for (const policy of ['DeletionPolicy', 'UpdateReplacePolicy']) {
    const value = get(resource, [policy]);
    if (value === 'Retain') continue;
    const shown = value === undefined ? 'unset (Delete)' : typeof value === 'string' ? value : JSON.stringify(value);
    found.push(`${policy} is ${shown}, must be Retain (RemovalPolicy.RETAIN)`);
  }
  if (type === 'AWS::DynamoDB::Table') {
    if (props.DeletionProtectionEnabled !== true) found.push('DeletionProtectionEnabled must be true');
    if (get(props, ['PointInTimeRecoverySpecification', 'PointInTimeRecoveryEnabled']) !== true) {
      found.push('PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled must be true');
    }
  }
  if (type === 'AWS::S3::Bucket') {
    if (get(props, ['VersioningConfiguration', 'Status']) !== 'Enabled') found.push('VersioningConfiguration.Status must be Enabled');
    const missing = PUBLIC_ACCESS_BLOCK.filter((k) => get(props, ['PublicAccessBlockConfiguration', k]) !== true);
    if (missing.length > 0) found.push(`PublicAccessBlockConfiguration must set ${missing.join(', ')} to true`);
  }
  if (type === 'AWS::Cognito::UserPool' && props.DeletionProtection !== 'ACTIVE') {
    found.push('DeletionProtection must be ACTIVE');
  }
  return found;
}

// ---------------------------------------------------------------------------
// IAM policies (least privilege)
// ---------------------------------------------------------------------------

/**
 * AWS-managed ARNs an identity policy or role may name although they are not
 * Cupmark's: none so far. Each entry needs a reason in a reviewed pull request. In
 * particular AWSLambdaBasicExecutionRole is not here: it allows logs on `*`; every
 * function gets an explicit role that may only write to its own log group.
 */
export const AWS_MANAGED_ARN_EXCEPTIONS: readonly string[] = [];

/** Placeholder for a `Ref` or `Fn::GetAtt` of a resource in the same template: `${owned:<Type>}`. */
const OWNED = '${owned';
const ownedToken = (type: unknown): string => `${OWNED}:${typeof type === 'string' ? type : '?'}}`;
const UNKNOWN = '${unknown}';
const ACCOUNT_PLACEHOLDER = '${account}';

const PSEUDO: Readonly<Record<string, string>> = {
  'AWS::Partition': 'aws',
  'AWS::Region': REGION,
  'AWS::AccountId': ACCOUNT_PLACEHOLDER,
  'AWS::URLSuffix': 'amazonaws.com',
};

/** A policy value as text, with references to this template's resources as `${owned:<Type>}`. */
function renderArn(value: unknown, resources: Json, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > 5) return UNKNOWN;
  const typeOf = (id: string): string => ownedToken(get(resources[id], ['Type']));
  const ref = get(value, ['Ref']);
  if (typeof ref === 'string') return PSEUDO[ref] ?? (ref in resources ? typeOf(ref) : UNKNOWN);
  const att = get(value, ['Fn::GetAtt']);
  if (Array.isArray(att)) return typeof att[0] === 'string' && att[0] in resources ? typeOf(att[0]) : UNKNOWN;
  const join = get(value, ['Fn::Join']);
  if (Array.isArray(join) && join.length === 2 && typeof join[0] === 'string' && Array.isArray(join[1])) {
    const parts = join[1] as unknown[];
    return parts.map((p) => renderArn(p, resources, depth + 1)).join(join[0]);
  }
  const sub = get(value, ['Fn::Sub']);
  if (typeof sub === 'string') {
    return sub.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
      const pseudo = PSEUDO[name];
      if (pseudo !== undefined) return pseudo;
      const id = name.split('.')[0] ?? '';
      return id in resources ? typeOf(id) : UNKNOWN;
    });
  }
  return UNKNOWN;
}

/**
 * Literal ARNs the app may name, per service: the resource part of the ARN (after
 * `arn:aws:<service>:<region>:<account>:`) must start with one of these prefixes, so
 * the first name segment is Cupmark's. `cupmark-` later in the path does not count.
 * A service that is not listed fails closed; resources of this template (Ref or
 * Fn::GetAtt, such as the user pool's ARN) are always allowed, with any suffix.
 */
export const OWNED_ARN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  // Bucket names; `cdk-cupmark-assets-` is the Cupmark bootstrap's asset bucket.
  s3: ['cupmark-', 'cdk-cupmark-assets-'],
  dynamodb: ['table/cupmark-'],
  lambda: ['function:cupmark-'],
  ssm: ['parameter/cupmark/'],
  logs: ['log-group:/aws/lambda/cupmark-', 'log-group:/cupmark/'],
  iam: ['role/cupmark-', 'role/Cupmark', 'policy/Cupmark'],
};

/**
 * GitHub OIDC stack only, on top of OWNED_ARN_PREFIXES: the roles of the `cupmark`
 * bootstrap (CDKToolkit-cupmark), which the deploy role assumes. No stage role may name
 * them: a function that could assume the deploy role could change every stack.
 */
export const GITHUB_OIDC_ARN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  iam: ['role/cdk-cupmark-'],
};

/**
 * Where an Allow statement's Resource may contain a wildcard (`*` or `?`). Everywhere
 * else a wildcard fails, even after a Cupmark prefix (`table/cupmark-*`), because it
 * would also match resources created later, by anyone. The resource up to the wildcard
 * must already pass the prefix check.
 */
// Known limitation: `index/*` or `stream/*` on a table of this template (for example
// `${table.tableArn}/index/*`) fails, because only S3 and logs have an exception. Name the
// index or stream exactly instead (the api role names `index/gsi1`); add an exception here,
// with its reason, only if a role really needs every index or stream.
export const RESOURCE_WILDCARD_EXCEPTIONS: readonly { readonly service: string; readonly pattern: RegExp; readonly why: string }[] = [
  {
    service: 's3',
    pattern: /^[^*?]+\/\*$/,
    why: 'objects of one bucket, or under one key prefix of it (`<bucket>/catalogue/*`): object keys are ids generated at run time',
  },
  {
    service: 'logs',
    pattern: /^[^*?]+:log-group:[^*?]+:\*$/,
    why: 'the log streams of one named log group (`log-group:<name>:*`): Lambda generates the stream names',
  },
];

/** The service of an ARN text, also for `${owned:<Type>}...`. */
function serviceOf(text: string): string {
  const owned = /^\$\{owned:AWS::([A-Za-z0-9]+)::/.exec(text);
  if (owned?.[1] !== undefined) return owned[1].toLowerCase();
  return text.split(':')[2] ?? '';
}

function wildcardProblem(text: string): string | undefined {
  if (!/[*?]/.test(text)) return undefined;
  const service = serviceOf(text);
  if (RESOURCE_WILDCARD_EXCEPTIONS.some((e) => e.service === service && e.pattern.test(text))) return undefined;
  return `resource "${text}" has a wildcard; only RESOURCE_WILDCARD_EXCEPTIONS allow one (S3 objects "<bucket>[/<prefix>]/*", log streams "log-group:<name>:*")`;
}

function iamResourceProblem(
  value: unknown,
  resources: Json,
  ownAccount: string | undefined,
  prefixesFor: Readonly<Record<string, readonly string[]>>,
): string | undefined {
  const text = renderArn(value, resources);
  if (AWS_MANAGED_ARN_EXCEPTIONS.includes(text)) return undefined;
  if (text.includes(UNKNOWN)) return `resource ${JSON.stringify(value)} cannot be checked at synth time`;
  if (text === '*') return 'Resource "*" is not allowed';
  if (text.startsWith(OWNED)) return wildcardProblem(text);
  if (!text.startsWith('arn:')) return `resource "${text}" is not an ARN of this stack`;
  const parts = text.split(':');
  const service = parts[2] ?? '';
  const account = parts[4] ?? '';
  const resource = parts.slice(5).join(':');
  if (account !== '' && account !== ACCOUNT_PLACEHOLDER && account !== ownAccount) return `resource "${text}" is in another account`;
  if (resource.startsWith(OWNED)) return wildcardProblem(text);
  const prefixes = prefixesFor[service];
  if (prefixes === undefined) return `resource "${text}": service ${service} is not on OWNED_ARN_PREFIXES; name a resource of this template instead`;
  if (!prefixes.some((p) => resource.startsWith(p))) {
    return `resource "${text}" is not a Cupmark resource: it must start with ${prefixes.map((p) => `${service}:${p}`).join(' or ')}`;
  }
  return wildcardProblem(text);
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every problem of one identity policy document. */
function policyDocumentProblems(
  doc: unknown,
  resources: Json,
  ownAccount: string | undefined,
  prefixesFor: Readonly<Record<string, readonly string[]>>,
): string[] {
  const found: string[] = [];
  for (const [i, statement] of asList(get(doc, ['Statement'])).entries()) {
    const at = `Statement[${String(i)}]`;
    for (const key of ['NotAction', 'NotResource', 'NotPrincipal']) {
      if (get(statement, [key]) !== undefined) found.push(`${at}: ${key} is not allowed`);
    }
    if (get(statement, ['Effect']) !== 'Allow') continue;
    const actions = asList(get(statement, ['Action']));
    if (actions.length === 0) found.push(`${at}: no Action`);
    for (const action of actions) {
      if (typeof action !== 'string') found.push(`${at}: action ${JSON.stringify(action)} is not a literal`);
      else if (/[*?]/.test(action)) found.push(`${at}: action "${action}" has a wildcard`);
    }
    const targets = asList(get(statement, ['Resource']));
    if (targets.length === 0) found.push(`${at}: no Resource`);
    for (const target of targets) {
      const problem = iamResourceProblem(target, resources, ownAccount, prefixesFor);
      if (problem !== undefined) found.push(`${at}: ${problem}`);
    }
  }
  return found;
}

/** Service principals a stage role may trust. Each new one needs a reviewed pull request. */
export const TRUSTED_SERVICE_PRINCIPALS: readonly string[] = ['lambda.amazonaws.com'];

const GITHUB_PROVIDER_ARN = `arn:aws:iam::${ACCOUNT_PLACEHOLDER}:oidc-provider/${GITHUB_OIDC_HOST}`;

/**
 * Every problem of a role's trust policy. Stage roles may only trust a service in
 * TRUSTED_SERVICE_PRINCIPALS with `sts:AssumeRole`. GitHub OIDC stack: the role may only
 * trust the GitHub provider (by its ARN, the one documented foreign ARN, or the provider
 * of the same template in create mode) with `sts:AssumeRoleWithWebIdentity`, `aud`
 * `sts.amazonaws.com` and only the `environment:dev` / `environment:prod` subjects of this
 * repository, all `StringEquals`. No `AWS`
 * principal (another account or role) and no `*` principal anywhere.
 */
function trustProblems(doc: unknown, resources: Json, githubOidc: boolean): string[] {
  const found: string[] = [];
  const statements = asList(get(doc, ['Statement']));
  if (statements.length === 0) found.push('trust policy has no statement');
  for (const [i, statement] of statements.entries()) {
    const at = `trust Statement[${String(i)}]`;
    if (get(statement, ['Effect']) !== 'Allow') {
      found.push(`${at}: only Allow statements are expected`);
      continue;
    }
    for (const key of ['NotAction', 'NotPrincipal']) {
      if (get(statement, [key]) !== undefined) found.push(`${at}: ${key} is not allowed`);
    }
    const principal = get(statement, ['Principal']);
    const kinds = isRecord(principal) ? Object.keys(principal) : [];
    const actions = asList(get(statement, ['Action']));
    if (!isRecord(principal) || kinds.length !== 1) {
      found.push(`${at}: principal ${JSON.stringify(principal)} must be exactly one Service or Federated principal`);
      continue;
    }
    if (kinds[0] === 'Service') {
      for (const service of asList(principal.Service)) {
        if (typeof service !== 'string' || !TRUSTED_SERVICE_PRINCIPALS.includes(service)) {
          found.push(`${at}: service principal ${JSON.stringify(service)} is not on TRUSTED_SERVICE_PRINCIPALS`);
        }
      }
      if (actions.length !== 1 || actions[0] !== 'sts:AssumeRole') found.push(`${at}: a service may only be trusted with sts:AssumeRole`);
      continue;
    }
    if (kinds[0] !== 'Federated') {
      found.push(`${at}: ${String(kinds[0])} principals are not allowed; only a service or the GitHub provider may assume a role`);
      continue;
    }
    if (!githubOidc) {
      found.push(`${at}: a Federated principal is only allowed in ${GITHUB_OIDC_STACK_NAME}`);
      continue;
    }
    const providers = asList(principal.Federated).map((p) => renderArn(p, resources));
    if (providers.length !== 1 || !(providers[0] === GITHUB_PROVIDER_ARN || providers[0] === ownedToken('AWS::IAM::OIDCProvider'))) {
      found.push(`${at}: Federated must be the GitHub provider ${GITHUB_PROVIDER_ARN}; got ${JSON.stringify(providers)}`);
    }
    if (actions.length !== 1 || actions[0] !== 'sts:AssumeRoleWithWebIdentity') {
      found.push(`${at}: the GitHub provider may only be trusted with sts:AssumeRoleWithWebIdentity`);
    }
    const condition = get(statement, ['Condition']);
    const operators = isRecord(condition) ? Object.keys(condition) : [];
    if (operators.length !== 1 || operators[0] !== 'StringEquals') {
      found.push(`${at}: Condition must use StringEquals only (no StringLike, no wildcard subjects); got ${JSON.stringify(operators)}`);
    }
    const aud = get(condition, ['StringEquals', `${GITHUB_OIDC_HOST}:aud`]);
    if (aud !== GITHUB_OIDC_AUDIENCE) found.push(`${at}: ${GITHUB_OIDC_HOST}:aud must be exactly ${GITHUB_OIDC_AUDIENCE}`);
    const subs = asList(get(condition, ['StringEquals', `${GITHUB_OIDC_HOST}:sub`]));
    if (subs.length === 0) found.push(`${at}: ${GITHUB_OIDC_HOST}:sub must be set`);
    for (const sub of subs) {
      // Only the environment subjects (ADR 0018): a `ref:` subject would also match jobs
      // without an environment, such as claude.yml's issue_comment job on main.
      if (typeof sub !== 'string' || !GITHUB_DEPLOY_SUBJECTS.includes(sub)) {
        found.push(`${at}: sub ${JSON.stringify(sub)} must be one of ${GITHUB_DEPLOY_SUBJECTS.join(', ')} (environment subjects of repo:${GITHUB_REPOSITORY} only)`);
      }
    }
  }
  return found;
}

/**
 * Bucket policies may only deny. The TLS-only policy is the one documented use of
 * `s3:*` and Principal `*`: in Deny statements they take access away from everyone
 * without TLS 1.2. An Allow in a bucket policy would grant access outside IAM roles.
 */
function bucketPolicyProblems(props: Json): string[] {
  return asList(get(props, ['PolicyDocument', 'Statement']))
    .map((s, i) => (get(s, ['Effect']) === 'Deny' ? undefined : `Statement[${String(i)}]: a bucket policy may only Deny`))
    .filter((p): p is string => p !== undefined);
}

function iamProblems(type: string, props: Json, resources: Json, ownAccount: string | undefined, githubOidc: boolean): string[] {
  const found: string[] = [];
  const prefixesFor: Record<string, readonly string[]> = { ...OWNED_ARN_PREFIXES };
  if (githubOidc) {
    for (const [service, extra] of Object.entries(GITHUB_OIDC_ARN_PREFIXES)) prefixesFor[service] = [...(prefixesFor[service] ?? []), ...extra];
  }
  if (type === 'AWS::IAM::Policy') {
    found.push(...policyDocumentProblems(props.PolicyDocument, resources, ownAccount, prefixesFor));
  }
  if (type === 'AWS::S3::BucketPolicy') found.push(...bucketPolicyProblems(props));
  if (type === 'AWS::IAM::Role') {
    for (const [i, policy] of asList(props.Policies).entries()) {
      const name = get(policy, ['PolicyName']);
      for (const p of policyDocumentProblems(get(policy, ['PolicyDocument']), resources, ownAccount, prefixesFor)) {
        found.push(`Policies[${String(i)}] (${typeof name === 'string' ? name : '?'}) ${p}`);
      }
    }
    for (const arn of asList(props.ManagedPolicyArns)) {
      const text = renderArn(arn, resources);
      if (!AWS_MANAGED_ARN_EXCEPTIONS.includes(text) && !text.startsWith(OWNED)) {
        found.push(`managed policy "${text}" is not on AWS_MANAGED_ARN_EXCEPTIONS`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function get(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Every location (dotted path) where `key` is used as an object key. */
function findKey(value: unknown, key: string, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findKey(v, key, `${at}[${String(i)}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = at === '' ? k : `${at}.${k}`;
    return k === key ? [here, ...findKey(v, key, here)] : findKey(v, key, here);
  });
}

// Any AWS region id, e.g. us-east-1, eu-west-3, ap-southeast-4, us-gov-west-1.
const REGION_PATTERN = /\b(?:af|ap|ca|cn|eu|il|me|mx|sa|us)(?:-gov|-iso[a-z]?)?-(?:central|north|south|east|west|northeast|northwest|southeast|southwest)-\d{1,2}\b/g;

function foreignRegions(text: string): string[] {
  return [...new Set(text.match(REGION_PATTERN) ?? [])].filter((r) => r !== REGION);
}

function hasProjectTag(tags: unknown): boolean {
  if (Array.isArray(tags)) {
    return tags.some((t) => isRecord(t) && t.Key === PROJECT_TAG_KEY && t.Value === PROJECT_TAG_VALUE);
  }
  return isRecord(tags) && tags[PROJECT_TAG_KEY] === PROJECT_TAG_VALUE;
}

/** Types whose `Ref` returns the physical name, and the property that sets it. */
const REF_RETURNS_NAME: Readonly<Record<string, string>> = {
  'AWS::Lambda::Function': 'FunctionName',
  'AWS::DynamoDB::Table': 'TableName',
  'AWS::S3::Bucket': 'BucketName',
  'AWS::IAM::Role': 'RoleName',
};

/**
 * The part of a name that is known at synth time: a literal string, or the leading
 * literal parts of an `Fn::Join` with `Ref`s to resources of this template resolved to
 * their own name (or, when unnamed, to the `<stackName>-` prefix CloudFormation
 * generates). Returns undefined when nothing is known.
 */
function knownPrefix(value: unknown, resources: Json, stackName: string, depth = 0): string | undefined {
  if (typeof value === 'string') return value;
  const join = get(value, ['Fn::Join']);
  if (depth > 3 || !Array.isArray(join) || join.length !== 2) return undefined;
  const [delimiter, parts] = join as [unknown, unknown];
  if (typeof delimiter !== 'string' || !Array.isArray(parts)) return undefined;
  let known = '';
  for (const [i, part] of parts.entries()) {
    if (i > 0) known += delimiter;
    if (typeof part === 'string') {
      known += part;
      continue;
    }
    const ref = get(part, ['Ref']);
    const target = typeof ref === 'string' ? resources[ref] : undefined;
    const nameProp = REF_RETURNS_NAME[String(get(target, ['Type']))];
    if (nameProp !== undefined) {
      const own = get(target, ['Properties', nameProp]);
      const ownPrefix = own === undefined ? `${stackName}-` : knownPrefix(own, resources, stackName, depth + 1);
      if (ownPrefix !== undefined) known += ownPrefix;
      // A literal own name is complete; anything after it is still known.
      if (typeof own === 'string') continue;
    }
    break;
  }
  return known === '' ? undefined : known;
}

/** The trailing literal of a string or an `Fn::Join`, e.g. the end of an ARN. */
function lastLiteral(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const parts = get(value, ['Fn::Join']);
  if (!Array.isArray(parts)) return undefined;
  const list: unknown = parts[1];
  if (!Array.isArray(list)) return undefined;
  const last: unknown = list[list.length - 1];
  return typeof last === 'string' ? last : undefined;
}

function tagManagerOf(resource: CfnResource): TagManager | undefined {
  if (TagManager.isTaggable(resource)) return resource.tags;
  if (TagManager.isTaggableV2(resource)) return resource.cdkTagManager;
  return undefined;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Synthesises `app` (idempotent) and returns every guard violation. */
export function checkApp(app: App): Violation[] {
  app.synth();
  const out: Violation[] = [];
  const all = app.node.findAll();

  for (const c of all) {
    if (c instanceof CfnInclude) {
      out.push({ guard: 'import', stack: stackLabel(c), where: c.node.path, message: 'CfnInclude imports a template this repo did not write' });
    }
    if (c instanceof Resource && !Resource.isOwnedResource(c) && !isKnownInternalReference(c)) {
      out.push({
        guard: 'import',
        stack: stackLabel(c),
        where: c.node.path,
        message: 'imported resource (fromXxx/fromLookup): the app may only reference resources it creates',
      });
    }
  }

  const stacks = all.filter((c): c is Stack => Stack.isStack(c));
  for (const stack of stacks) out.push(...checkStack(stack));
  return out;
}

/**
 * References that aws-cdk-lib L2 constructs create on their own and that point at
 * AWS-managed resources, not at another project's. Keep this list short and reviewed.
 */
function isKnownInternalReference(c: IConstruct): boolean {
  // dynamodb.Table always references the AWS-managed service-linked role for DynamoDB
  // auto scaling (AWSServiceRoleForApplicationAutoScaling_DynamoDBTable). It is only
  // used when auto scaling is configured, which on-demand billing never is.
  if (c.node.id === 'ScalingRole' && c.node.scope instanceof dynamodb.Table) return true;
  // A file asset (Lambda code) references the asset bucket of its stack's bootstrap.
  // With the Cupmark synthesizer that is `cdk-cupmark-assets-<account>-<region>` of
  // CDKToolkit-cupmark, the one exception invariant 9 names; the bootstrap guard below
  // proves every stack uses that synthesizer.
  const asset = c.node.scope;
  if (c.node.id === 'AssetBucket' && asset instanceof s3assets.Asset) {
    const stack = Stack.of(c);
    const bucket = JSON.stringify(stack.resolve(asset.s3BucketName));
    return (
      stack.synthesizer instanceof DefaultStackSynthesizer &&
      stack.synthesizer.bootstrapQualifier === BOOTSTRAP_QUALIFIER &&
      bucket.includes(`cdk-${BOOTSTRAP_QUALIFIER}-assets-`)
    );
  }
  return false;
}

function stackLabel(c: IConstruct): string {
  try {
    return Stack.of(c).stackName;
  } catch {
    return c.node.path;
  }
}

function checkStack(stack: Stack): Violation[] {
  const out: Violation[] = [];
  const name = stack.stackName;
  const add = (guard: GuardName, where: string, message: string): void => {
    out.push({ guard, stack: name, where, message });
  };

  if (stack.nested) {
    add('resource-type', stack.node.path, 'nested stacks are not allowed');
    return out;
  }
  const githubOidc = stack instanceof CupmarkGitHubOidcStack;
  if (!(stack instanceof CupmarkStack) && !githubOidc) {
    add('name', stack.node.path, 'every stack must extend CupmarkStack (src/stage.ts)');
  }
  const stage: StageName | undefined = stack instanceof CupmarkStack ? stack.cupmarkStage : undefined;
  const stagePrefix = `${NAME_PREFIX}${stage ?? '<stage>'}-`;
  if (githubOidc) {
    // GitHub OIDC stack: one fixed name, at the top of the app, never inside a stage.
    if (name !== GITHUB_OIDC_STACK_NAME) add('name', 'stackName', `stack name ${name} must be ${GITHUB_OIDC_STACK_NAME}`);
    if (Stage.of(stack) !== stack.node.root) add('name', stack.node.path, `${GITHUB_OIDC_STACK_NAME} must not be inside a stage`);
  } else if (!name.startsWith(stagePrefix)) {
    add('name', 'stackName', `stack name ${name} must start with ${stagePrefix}`);
  }

  // Region: construct, manifest and every string in the template.
  if (stack.region !== REGION) add('region', 'env', `stack region is ${stack.region}, must be ${REGION}`);
  const owner = Stage.of(stack);
  if (owner === undefined) {
    add('region', stack.node.path, 'stack is not inside a stage or app');
    return out;
  }
  const assembly = owner.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);
  if (artifact.environment.region !== REGION) {
    add('region', 'manifest', `manifest region is ${artifact.environment.region}, must be ${REGION}`);
  }
  const template: unknown = artifact.template;
  const templateText = JSON.stringify(template);
  for (const r of foreignRegions(templateText)) add('region', 'template', `template mentions region ${r}`);
  for (const r of foreignRegions(JSON.stringify(artifact.manifest))) add('region', 'manifest', `manifest mentions region ${r}`);

  // Bootstrap: the Cupmark qualifier, never the shared default bootstrap.
  const bootstrapParam = `/cdk-bootstrap/${BOOTSTRAP_QUALIFIER}/version`;
  if (githubOidc) {
    // GitHub OIDC stack (ADR 0009): deployed with the caller's credentials, so no
    // bootstrap role and no CupmarkCfnExecution. The template still goes to the Cupmark
    // asset bucket, and the stack has no other asset (no Lambda code).
    const synth = stack.synthesizer;
    if (!(synth instanceof CliCredentialsStackSynthesizer) || synth.bootstrapQualifier !== BOOTSTRAP_QUALIFIER) {
      add('bootstrap', 'synthesizer', `must be CliCredentialsStackSynthesizer with qualifier ${BOOTSTRAP_QUALIFIER}`);
    }
    if (artifact.assumeRoleArn !== undefined || artifact.cloudFormationExecutionRoleArn !== undefined) {
      add('bootstrap', 'manifest', 'must deploy with the caller\'s credentials: no assume role and no CloudFormation execution role');
    }
    if (artifact.stackTemplateAssetObjectUrl?.startsWith(`s3://cdk-${BOOTSTRAP_QUALIFIER}-assets-`) !== true) {
      add('bootstrap', 'manifest', `template must go to cdk-${BOOTSTRAP_QUALIFIER}-assets-*; got ${String(artifact.stackTemplateAssetObjectUrl)}`);
    }
    for (const dep of artifact.dependencies) {
      if (!(dep instanceof AssetManifestArtifact)) continue;
      const { files = {}, dockerImages = {} } = dep.contents;
      const others = Object.values(files).filter((f) => f.source.path !== artifact.templateFile);
      if (others.length > 0 || Object.keys(dockerImages).length > 0) {
        add('bootstrap', 'assets', `${GITHUB_OIDC_STACK_NAME} must have no assets besides its template`);
      }
    }
  } else {
    if (get(template, ['Parameters', 'BootstrapVersion', 'Default']) !== bootstrapParam) {
      add('bootstrap', 'Parameters.BootstrapVersion', `must default to ${bootstrapParam} (DefaultStackSynthesizer qualifier ${BOOTSTRAP_QUALIFIER})`);
    }
    if (artifact.assumeRoleArn?.includes(`cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-`) !== true) {
      add('bootstrap', 'manifest', `deploy role must be cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-*; got ${String(artifact.assumeRoleArn)}`);
    }
  }
  if ((templateText + JSON.stringify(artifact.manifest)).includes('hnb659fds')) {
    add('bootstrap', 'template', 'references the shared default bootstrap (qualifier hnb659fds)');
  }

  // Imports and lookups.
  for (const at of findKey(template, 'Fn::ImportValue')) add('import', at, 'Fn::ImportValue is not allowed');
  for (const m of assembly.manifest.missing ?? []) {
    add('import', m.key, `context lookup ${m.provider} is not allowed`);
  }
  const params = get(template, ['Parameters']);
  if (isRecord(params)) {
    for (const [id, p] of Object.entries(params)) {
      const type = get(p, ['Type']);
      const def = get(p, ['Default']);
      if (typeof type === 'string' && type.startsWith('AWS::SSM::Parameter::Value')) {
        const ok = def === bootstrapParam || (typeof def === 'string' && def.startsWith(`/cupmark/${stage ?? '<stage>'}/`));
        if (!ok) add('import', `Parameters.${id}`, `SSM parameter ${String(def)} is not a Cupmark parameter of this stage`);
      }
    }
  }

  // Stage isolation: no reference to another stage's names.
  for (const other of STAGES.filter((s) => s !== stage)) {
    if (templateText.includes(`${NAME_PREFIX}${other}-`) || templateText.includes(`/cupmark/${other}/`)) {
      add('isolation', 'template', `references stage ${other}; nothing is shared between stages`);
    }
  }

  // GitHub OIDC stack in import mode (ADR 0018): no tags at all, so the template matches
  // the hand-made role. The one documented exception to the tag guard; the committed
  // state (no import flag) is checked like every other stack.
  const tagExempt = stack instanceof CupmarkGitHubOidcStack && stack.importMode;

  // Stack tags (CloudFormation propagates them to every resource that supports tags).
  if (!tagExempt && artifact.tags[PROJECT_TAG_KEY] !== PROJECT_TAG_VALUE) {
    add('tag', 'manifest', `stack tag ${PROJECT_TAG_KEY}=${PROJECT_TAG_VALUE} is missing`);
  }

  // Resources.
  const ownAccount = Token.isUnresolved(stack.account) ? undefined : stack.account;
  const resources = get(template, ['Resources']);
  const byId: Json = isRecord(resources) ? resources : {};
  for (const [id, res] of Object.entries(byId)) {
    const type = get(res, ['Type']);
    const propsValue = get(res, ['Properties']);
    const props: Json = isRecord(propsValue) ? propsValue : {};
    if (typeof type !== 'string') {
      add('resource-type', id, 'resource without a type');
      continue;
    }
    for (const f of fixedFeeProperties(type, props)) add('fixed-fee-property', id, `${type}: ${f}`);
    for (const p of statefulProblems(type, res, props, githubOidc)) add('stateful', id, `${type}: ${p}`);
    for (const p of iamProblems(type, props, byId, ownAccount, githubOidc)) add('iam', id, `${type}: ${p}`);
    if (type === 'AWS::IAM::Role') {
      for (const p of trustProblems(props.AssumeRolePolicyDocument, byId, githubOidc)) add('trust', id, `${type}: ${p}`);
    }
    const denied = deniedReason(type);
    const rule = (githubOidc ? GITHUB_OIDC_RESOURCE_TYPES : ALLOWED_RESOURCE_TYPES)[type];
    if (denied !== undefined) {
      add('resource-type', id, `${type} is forbidden: ${denied}`);
    } else if (rule === undefined) {
      const list = githubOidc ? 'GITHUB_OIDC_RESOURCE_TYPES' : 'the reviewed allow list';
      add('resource-type', id, `${type} is not on ${list} in src/guards.ts`);
    } else {
      for (const n of rule.names) {
        const value = get(props, n.path);
        const prefixes = n.prefixes.map((p) => p.replace('{stage}', stage ?? '<stage>'));
        const prop = n.path.join('.');
        const known = knownPrefix(value, byId, name);
        if (value === undefined) {
          if (n.required) add('name', id, `${type}.${prop} must be set and start with ${prefixes.join(' or ')}`);
        } else if (n.exact === true) {
          if (typeof value !== 'string' || !prefixes.includes(value)) {
            const shown = typeof value === 'string' ? `"${value}"` : 'is not a literal and';
            add('name', id, `${type}.${prop} ${shown} must be exactly ${prefixes.join(' or ')}`);
          }
        } else if (known === undefined || !prefixes.some((p) => known.startsWith(p))) {
          const shown = typeof value === 'string' ? `"${value}"` : 'is not a literal and';
          add('name', id, `${type}.${prop} ${shown} must start with ${prefixes.join(' or ')}`);
        }
      }
    }
    // GitHub OIDC stack: no boundary. The hand-made role has none, the stack is not
    // deployed through CupmarkCfnExecution (which requires it), and CupmarkBoundary does
    // not allow sts:AssumeRole on the bootstrap roles. Its own policy is pinned instead.
    if (type === 'AWS::IAM::Role' && !githubOidc) {
      if (lastLiteral(props.PermissionsBoundary)?.endsWith(`:policy/${PERMISSIONS_BOUNDARY_NAME}`) !== true) {
        add('boundary', id, `IAM role without the ${PERMISSIONS_BOUNDARY_NAME} permissions boundary`);
      }
    }
  }

  // Resource tags: every taggable L1 must carry the project tag in the template.
  for (const c of stack.node.findAll()) {
    if (!CfnResource.isCfnResource(c) || Stack.of(c) !== stack) continue;
    const tm = tagManagerOf(c);
    if (tm === undefined) continue;
    const logicalId: unknown = stack.resolve(c.logicalId);
    const id = typeof logicalId === 'string' ? logicalId : c.node.path;
    const tags = get(byId[id], ['Properties', capitalise(tm.tagPropertyName)]);
    if (!tagExempt && !hasProjectTag(tags)) add('tag', id, `${c.cfnResourceType} lacks tag ${PROJECT_TAG_KEY}=${PROJECT_TAG_VALUE}`);
  }

  return out;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `[${v.guard}] ${v.stack} ${v.where}: ${v.message}`).join('\n');
}
