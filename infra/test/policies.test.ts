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

  it('CupmarkCfnExecution lets CloudFormation create and configure every bucket of the stack, unchanged by ADR 0017', () => {
    const buckets = Object.values(template.Resources).filter((r) => r.Type === 'AWS::S3::Bucket');
    expect(buckets).toHaveLength(3);
    for (const b of buckets) {
      const arn = `arn:aws:s3:::${arnOf(b.Properties.BucketName, template.Resources)}`;
      for (const action of [
        's3:CreateBucket',
        's3:PutBucketPolicy',
        's3:PutBucketVersioning',
        's3:PutLifecycleConfiguration',
        's3:PutBucketPublicAccessBlock',
        's3:PutEncryptionConfiguration',
        's3:PutBucketOwnershipControls',
        's3:PutBucketTagging',
      ]) {
        expect(allows(execution, action, arn), `${action} on ${arn}`).toBe(true);
      }
    }
  });

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

describe('CupmarkCfnExecution and the bootstrap version parameter', () => {
  const ssmAllows = execution.filter((s) => s.Effect === 'Allow' && list(s.Action).some((a) => /^ssm:/i.test(a)));
  const version = `arn:aws:ssm:${REGION}:${FAKE_ACCOUNT}:parameter/cdk-bootstrap/cupmark/version`;

  it('has exactly one statement for it: two read actions on one parameter of the cupmark qualifier', () => {
    const own = execution.filter((s) => s.Sid === 'CupmarkBootstrapVersionParameter');
    expect(own).toEqual([
      {
        Sid: 'CupmarkBootstrapVersionParameter',
        Effect: 'Allow',
        Action: ['ssm:GetParameter', 'ssm:GetParameters'],
        Resource: version,
      },
    ]);
  });

  it('lets CloudFormation resolve BootstrapVersion of the cupmark qualifier and no other qualifier', () => {
    expect(allows(execution, 'ssm:GetParameters', version)).toBe(true);
    expect(allows(execution, 'ssm:GetParameter', version)).toBe(true);
    const other = (q: string) => `arn:aws:ssm:${REGION}:${FAKE_ACCOUNT}:parameter/cdk-bootstrap/${q}/version`;
    expect(allows(execution, 'ssm:GetParameters', other('hnb659fds'))).toBe(false);
    expect(allows(execution, 'ssm:GetParameters', other('cupmarkx'))).toBe(false);
    expect(allows(execution, 'ssm:GetParameters', `${version}/x`)).toBe(false);
    expect(allows(execution, 'ssm:GetParameters', version.replace(REGION, 'eu-west-1'))).toBe(false);
    for (const action of ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParametersByPath']) {
      expect(allows(execution, action, version), action).toBe(false);
    }
  });

  it('names no bootstrap qualifier but cupmark under /cdk-bootstrap/', () => {
    const text = readFileSync(new URL('../../scripts/aws/cupmark-cfn-execution-policy.json', import.meta.url), 'utf8');
    expect(text.match(/cdk-bootstrap\/[^/"]*/g)).toEqual(['cdk-bootstrap/cupmark']);
  });

  it('keeps ssm access to /cupmark/* and that one parameter, and a wildcard resource only for the region-scoped services', () => {
    const resources = ssmAllows.flatMap((s) => list(s.Resource)).filter((r) => r.startsWith('arn:aws:ssm:'));
    expect(resources.sort()).toEqual([`arn:aws:ssm:${REGION}:${FAKE_ACCOUNT}:parameter/cupmark/*`, version].sort());
    const starResource = execution.filter((s) => s.Effect === 'Allow' && list(s.Resource).includes('*'));
    expect(starResource.map((s) => s.Sid)).toEqual(['ServicesThatCannotBeNameScoped']);
    expect(list(starResource[0]?.Action)).toEqual(['apigateway:*', 'cognito-idp:*', 'cognito-identity:*']);
  });
});

describe('the boundary stays narrow', () => {
  it('allows the Cognito identity-provider actions and AdminDeleteUser only, and only on user pools in eu-central-1', () => {
    const pool = `arn:aws:cognito-idp:${REGION}:${FAKE_ACCOUNT}:userpool/${REGION}_Example1`;
    expect(allows(boundary, 'cognito-idp:UpdateIdentityProvider', pool)).toBe(true);
    expect(allows(boundary, 'cognito-idp:AdminDeleteUser', pool)).toBe(true);
    expect(allows(boundary, 'cognito-idp:DeleteUserPool', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:AdminCreateUser', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:AdminDisableUser', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:ListUsers', pool)).toBe(false);
    expect(allows(boundary, 'cognito-idp:UpdateIdentityProvider', pool.replace(REGION, 'eu-west-1'))).toBe(false);
    expect(allows(boundary, 'cognito-idp:AdminDeleteUser', pool.replace(REGION, 'eu-west-1'))).toBe(false);
  });

  it('allows object and version deletes only under labels/ and uploads/ of Cupmark photo buckets (ADR 0017)', () => {
    for (const stage of STAGES) {
      const photos = `arn:aws:s3:::cupmark-${stage}-photos-${FAKE_ACCOUNT}`;
      for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
        expect(allows(boundary, action, `${photos}/labels/x.jpg`), `${action} ${stage} labels`).toBe(true);
        expect(allows(boundary, action, `${photos}/uploads/x.jpg`), `${action} ${stage} uploads`).toBe(true);
        for (const prefix of ['catalogue/', 'verified/', 'entries/', '']) {
          expect(allows(boundary, action, `${photos}/${prefix}x.jpg`), `${action} ${stage} ${prefix}`).toBe(false);
        }
      }
    }
  });

  it.each(['backups', 'deletion-log'])('allows no delete and no version listing in the %s bucket', (part) => {
    for (const stage of STAGES) {
      const bucket = `arn:aws:s3:::cupmark-${stage}-${part}-${FAKE_ACCOUNT}`;
      for (const prefix of ['labels/', 'uploads/', 'entries/', '']) {
        for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
          expect(allows(boundary, action, `${bucket}/${prefix}x`), `${action} ${bucket}/${prefix}x`).toBe(false);
        }
      }
      expect(allows(boundary, 's3:ListBucketVersions', bucket)).toBe(false);
    }
  });

  it('allows version listing only on Cupmark photo buckets, and no bucket-level delete or reconfiguration', () => {
    const photos = `arn:aws:s3:::cupmark-dev-photos-${FAKE_ACCOUNT}`;
    expect(allows(boundary, 's3:ListBucketVersions', photos)).toBe(true);
    expect(allows(boundary, 's3:ListBucketVersions', 'arn:aws:s3:::derschweigert-site')).toBe(false);
    for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
      expect(allows(boundary, action, 'arn:aws:s3:::derschweigert-photos-x/labels/x.jpg')).toBe(false);
      expect(allows(boundary, action, `arn:aws:s3:::cdk-cupmark-assets-${FAKE_ACCOUNT}-${REGION}/x.zip`)).toBe(false);
    }
    for (const action of ['s3:DeleteBucket', 's3:DeleteBucketPolicy', 's3:PutLifecycleConfiguration', 's3:PutBucketVersioning']) {
      expect(allows(boundary, action, photos), action).toBe(false);
    }
  });

  it('allows ConditionCheckItem only on Cupmark tables', () => {
    const table = (name: string) => `arn:aws:dynamodb:${REGION}:${FAKE_ACCOUNT}:table/${name}`;
    expect(allows(boundary, 'dynamodb:ConditionCheckItem', table('cupmark-dev-main'))).toBe(true);
    expect(allows(boundary, 'dynamodb:ConditionCheckItem', table('other-main'))).toBe(false);
  });
});
