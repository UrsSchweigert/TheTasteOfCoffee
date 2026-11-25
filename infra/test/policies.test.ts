// The guardrail policies in scripts/aws/ (ADR 0002) against what the stack needs.
// CupmarkBoundary caps every role the stack creates, so each action a role is granted
// must also be allowed by the boundary on that resource, or it fails at run time with
// AccessDenied. CupmarkCfnExecution must let CloudFormation read the Lambda code from
// the Cupmark bootstrap's asset bucket. The owner applies these files with
// scripts/aws/apply-guardrails.sh; this test only reads them.
import { readFileSync } from 'node:fs';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { REGION, STAGES } from '../src/config.ts';
import { FAKE_ACCOUNT, testApp } from './helpers.ts';

interface Statement {
  readonly Sid?: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action?: string | string[];
  readonly NotAction?: string | string[];
  readonly Resource: string | string[];
  readonly Condition?: Record<string, Record<string, string>>;
}

/** A policy file with its `${ACCOUNT}` and `${REGION}` placeholders filled in, as the script does. */
function policy(file: string): Statement[] {
  const text = readFileSync(new URL(`../../scripts/aws/${file}`, import.meta.url), 'utf8')
    .replaceAll('${ACCOUNT}', FAKE_ACCOUNT)
    .replaceAll('${REGION}', REGION);
  return (JSON.parse(text) as { Statement: Statement[] }).Statement;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** IAM wildcard match (`*` and `?`), case-insensitive for actions. */
function matches(pattern: string, value: string, ignoreCase = false): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, ignoreCase ? 'i' : '');
  return re.test(value);
}

/**
 * Whether a statement's condition holds for a request in eu-central-1. Only the
 * `aws:RequestedRegion` checks the policies use are understood; a statement with any
 * other condition is treated as not applying.
 */
function conditionHolds(s: Statement): boolean {
  return Object.entries(s.Condition ?? {}).every(([operator, keys]) =>
    Object.entries(keys).every(([key, value]) => {
      if (key !== 'aws:RequestedRegion') return false;
      if (operator === 'StringEquals') return value === REGION;
      if (operator === 'StringNotEquals') return value !== REGION;
      return false;
    }),
  );
}

/** Whether a policy allows `action` on `resource` in eu-central-1 (an explicit Deny wins). */
function allows(statements: readonly Statement[], action: string, resource: string): boolean {
  const hit = (s: Statement): boolean =>
    conditionHolds(s) &&
    list(s.Resource).some((r) => matches(r, resource)) &&
    (s.Action !== undefined
      ? list(s.Action).some((a) => matches(a, action, true))
      : !list(s.NotAction).some((a) => matches(a, action, true)));
  if (statements.some((s) => s.Effect === 'Deny' && hit(s))) return false;
  return statements.some((s) => s.Effect === 'Allow' && hit(s));
}

type Json = Record<string, unknown>;

/** A concrete ARN for a policy resource of the template, as it will be at deploy time. */
function arnOf(value: unknown, resources: Record<string, { Type: string; Properties: Json }>): string {
  if (typeof value === 'string') return value;
  const v = value as Json;
  if (typeof v.Ref === 'string') {
    if (v.Ref === 'AWS::AccountId') return FAKE_ACCOUNT;
    if (v.Ref === 'AWS::Region') return REGION;
    if (v.Ref === 'AWS::Partition') return 'aws';
  }
  if (Array.isArray(v['Fn::Join'])) {
    const [sep, parts] = v['Fn::Join'] as [string, unknown[]];
    return parts.map((p) => arnOf(p, resources)).join(sep);
  }
  if (Array.isArray(v['Fn::GetAtt'])) {
    const [id, att] = v['Fn::GetAtt'] as [string, string];
    const r = resources[id];
    if (r === undefined || att !== 'Arn') throw new Error(`cannot resolve ${JSON.stringify(value)}`);
    const prefix = `${REGION}:${FAKE_ACCOUNT}`;
    switch (r.Type) {
      case 'AWS::DynamoDB::Table':
        return `arn:aws:dynamodb:${prefix}:table/${String(r.Properties.TableName)}`;
      case 'AWS::S3::Bucket':
        return `arn:aws:s3:::${arnOf(r.Properties.BucketName, resources)}`;
      case 'AWS::Logs::LogGroup':
        return `arn:aws:logs:${prefix}:log-group:${String(r.Properties.LogGroupName)}:*`;
      case 'AWS::Cognito::UserPool':
        return `arn:aws:cognito-idp:${prefix}:userpool/${REGION}_Example1`;
      default:
        throw new Error(`no ARN rule for ${r.Type}`);
    }
  }
  throw new Error(`cannot resolve ${JSON.stringify(value)}`);
}

const boundary = policy('cupmark-boundary-policy.json');
const execution = policy('cupmark-cfn-execution-policy.json');

describe.each(STAGES)('stage %s', (stage) => {
  const { stages } = testApp({ context: { stage } });
  const core = stages[0]?.core;
  if (core === undefined) throw new Error(`stage ${stage} missing`);
  const template = Template.fromStack(core).toJSON() as { Resources: Record<string, { Type: string; Properties: Json }> };
  const roles = Object.values(template.Resources).filter((r) => r.Type === 'AWS::IAM::Role');

  it('has roles to check', () => {
    expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual(
      [`cupmark-${stage}-api`, `cupmark-${stage}-apple-idp`, `cupmark-${stage}-health`].sort(),
    );
  });

  it.each(roles.map((r) => [String(r.Properties.RoleName), r] as const))(
    'CupmarkBoundary allows everything %s is granted',
    (_name, role) => {
      const missing: string[] = [];
      const docs = (role.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[]).map((p) => p.PolicyDocument);
      for (const s of docs.flatMap((d) => d.Statement)) {
        for (const action of list(s.Action)) {
          for (const resource of list(s.Resource).map((r) => arnOf(r, template.Resources))) {
            if (!allows(boundary, action, resource)) missing.push(`${action} on ${resource}`);
          }
        }
      }
      expect(missing).toEqual([]);
    },
  );

  it('CupmarkCfnExecution lets CloudFormation read the Lambda code from the Cupmark asset bucket', () => {
    const functions = Object.values(template.Resources).filter((r) => r.Type === 'AWS::Lambda::Function');
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      const code = fn.Properties.Code as { S3Bucket: { 'Fn::Sub': string }; S3Key: string };
      const bucket = code.S3Bucket['Fn::Sub'].replace('${AWS::AccountId}', FAKE_ACCOUNT);
      expect(allows(execution, 's3:GetObject', `arn:aws:s3:::${bucket}/${code.S3Key}`)).toBe(true);
    }
    // ... and nothing else in that bucket, nor any other bootstrap's.
    expect(allows(execution, 's3:PutObject', `arn:aws:s3:::cdk-cupmark-assets-${FAKE_ACCOUNT}-${REGION}/x.zip`)).toBe(false);
    expect(allows(execution, 's3:GetObject', `arn:aws:s3:::cdk-hnb659fds-assets-${FAKE_ACCOUNT}-${REGION}/x.zip`)).toBe(false);
  });
});

describe('the boundary stays narrow', () => {
  it('allows the Cognito identity-provider actions only, and only on user pools in eu-central-1', () => {
    const pool = `arn:aws:cognito-idp:${REGION}:${FAKE_ACCOUNT}:userpool/${REGION}_Example1`;
    expect(allows(boundary, 'cognito-idp:UpdateIdentityProvider', pool)).toBe(true);
    expect(allows(boundary, 'cognito-idp:DeleteUserPool', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:AdminCreateUser', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:UpdateIdentityProvider', pool.replace(REGION, 'eu-west-1'))).toBe(false);
  });

  it('allows ConditionCheckItem only on Cupmark tables', () => {
    const table = (name: string) => `arn:aws:dynamodb:${REGION}:${FAKE_ACCOUNT}:table/${name}`;
    expect(allows(boundary, 'dynamodb:ConditionCheckItem', table('cupmark-dev-main'))).toBe(true);
    expect(allows(boundary, 'dynamodb:ConditionCheckItem', table('other-main'))).toBe(false);
  });
});
