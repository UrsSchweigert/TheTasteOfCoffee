// Synth-time guards for CLAUDE.md invariants 5 (pay-per-use only), 6 (eu-central-1)
// and 9 (never touch existing infrastructure), and for deployability under
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

import { CfnResource, Resource, Stack, Stage, TagManager } from 'aws-cdk-lib';
import type { App } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
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
  | 'isolation';

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
  'AWS::S3::Bucket': { why: 'photo and backup buckets', names: [optionalName('BucketName')] },
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
  'AWS::Cognito::UserPoolDomain': { why: 'hosted domain for the Apple flow', names: [requiredName('Domain')] },
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
  return c.node.id === 'ScalingRole' && c.node.scope instanceof dynamodb.Table;
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
  if (!(stack instanceof CupmarkStack)) {
    add('name', stack.node.path, 'every stack must extend CupmarkStack (src/stage.ts)');
  }
  const stage: StageName | undefined = stack instanceof CupmarkStack ? stack.cupmarkStage : undefined;
  const stagePrefix = `${NAME_PREFIX}${stage ?? '<stage>'}-`;
  if (!name.startsWith(stagePrefix)) add('name', 'stackName', `stack name ${name} must start with ${stagePrefix}`);

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
  if (get(template, ['Parameters', 'BootstrapVersion', 'Default']) !== bootstrapParam) {
    add('bootstrap', 'Parameters.BootstrapVersion', `must default to ${bootstrapParam} (DefaultStackSynthesizer qualifier ${BOOTSTRAP_QUALIFIER})`);
  }
  if (artifact.assumeRoleArn?.includes(`cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-`) !== true) {
    add('bootstrap', 'manifest', `deploy role must be cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-*; got ${String(artifact.assumeRoleArn)}`);
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

  // Stack tags (CloudFormation propagates them to every resource that supports tags).
  if (artifact.tags[PROJECT_TAG_KEY] !== PROJECT_TAG_VALUE) {
    add('tag', 'manifest', `stack tag ${PROJECT_TAG_KEY}=${PROJECT_TAG_VALUE} is missing`);
  }

  // Resources.
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
    const denied = deniedReason(type);
    const rule = ALLOWED_RESOURCE_TYPES[type];
    if (denied !== undefined) {
      add('resource-type', id, `${type} is forbidden: ${denied}`);
    } else if (rule === undefined) {
      add('resource-type', id, `${type} is not on the reviewed allow list in src/guards.ts`);
    } else {
      for (const n of rule.names) {
        const value = get(props, n.path);
        const prefixes = n.prefixes.map((p) => p.replace('{stage}', stage ?? '<stage>'));
        const prop = n.path.join('.');
        const known = knownPrefix(value, byId, name);
        if (value === undefined) {
          if (n.required) add('name', id, `${type}.${prop} must be set and start with ${prefixes.join(' or ')}`);
        } else if (known === undefined || !prefixes.some((p) => known.startsWith(p))) {
          const shown = typeof value === 'string' ? `"${value}"` : 'is not a literal and';
          add('name', id, `${type}.${prop} ${shown} must start with ${prefixes.join(' or ')}`);
        }
      }
    }
    if (type === 'AWS::IAM::Role') {
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
    if (!hasProjectTag(tags)) add('tag', id, `${c.cfnResourceType} lacks tag ${PROJECT_TAG_KEY}=${PROJECT_TAG_VALUE}`);
  }

  return out;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `[${v.guard}] ${v.stack} ${v.where}: ${v.message}`).join('\n');
}
