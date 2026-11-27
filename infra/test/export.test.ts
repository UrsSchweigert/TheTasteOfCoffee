// M3-T11: the weekly table export. A Scheduler schedule calls DynamoDB's
// ExportTableToPointInTime through a universal target; no Lambda. The role may export this
// table and write under one prefix of the backup bucket, nothing else.
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/config.ts';
import { BACKUP_ARCHIVE_AFTER_DAYS, BACKUP_EXPIRE_AFTER_DAYS } from '../src/data.ts';
import { testApp } from './helpers.ts';

type Json = Record<string, unknown>;
interface Resource {
  readonly Type: string;
  readonly Properties: Json;
}

describe.each(STAGES)('stage %s', (stage) => {
  const core = testApp({ context: { stage } }).stages[0]?.core;
  if (core === undefined) throw new Error(`stage ${stage} missing`);
  const template = Template.fromStack(core);
  const all = (template.toJSON() as { Resources: Record<string, Resource> }).Resources;
  const ofType = (type: string): [string, Resource][] => Object.entries(all).filter(([, r]) => r.Type === type);

  const tableId = ofType('AWS::DynamoDB::Table')[0]?.[0];
  const backupId = ofType('AWS::S3::Bucket').find(([, r]) => JSON.stringify(r.Properties.BucketName).includes(`cupmark-${stage}-backups-`))?.[0];
  const [, schedule] = ofType('AWS::Scheduler::Schedule').find(([, r]) => r.Properties.Name === `cupmark-${stage}-weekly-export`) ?? [];
  const role = ofType('AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === `cupmark-${stage}-export-scheduler`)?.[1];

  it('has one shared schedule group, the weekly and the nightly schedule, and no other scheduler resource', () => {
    expect(ofType('AWS::Scheduler::Schedule')).toHaveLength(2);
    expect(ofType('AWS::Scheduler::ScheduleGroup')).toHaveLength(1);
    expect(Object.values(all).filter((r) => r.Type.startsWith('AWS::Scheduler::')).length).toBe(3);
  });

  it('puts the schedule in the cupmark group, named with the prefix, weekly on Sunday 03:00 UTC, with no flexible window', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: `cupmark-${stage}-jobs` });
    expect(schedule?.Properties).toMatchObject({
      Name: `cupmark-${stage}-weekly-export`,
      GroupName: `cupmark-${stage}-jobs`,
      State: 'ENABLED',
      ScheduleExpression: 'cron(0 3 ? * SUN *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  it('uses the universal target ExportTableToPointInTime with the stage role and two retries', () => {
    const target = schedule?.Properties.Target as Json;
    expect(target.Arn).toBe('arn:aws:scheduler:::aws-sdk:dynamodb:exportTableToPointInTime');
    expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 2 });
    expect(JSON.stringify(target.RoleArn)).toContain('"Fn::GetAtt"');
    expect(Object.keys(target).sort()).toEqual(['Arn', 'Input', 'RetryPolicy', 'RoleArn']);
  });

  it('exports this table in full, as DynamoDB JSON, to the backup bucket under a dated exports/ prefix', () => {
    const input = (schedule?.Properties.Target as { Input: { 'Fn::Join': [string, unknown[]] } }).Input;
    const parts = input['Fn::Join'][1];
    // Resolve the two references, keep the rest literal.
    const text = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        const ref = p as { Ref?: string; 'Fn::GetAtt'?: string[] };
        if (ref['Fn::GetAtt']?.[0] === tableId && ref['Fn::GetAtt']?.[1] === 'Arn') return 'TABLE_ARN';
        if (ref.Ref === backupId) return 'BACKUP_BUCKET';
        throw new Error(`unexpected reference ${JSON.stringify(p)}`);
      })
      .join('');
    expect(JSON.parse(text)).toEqual({
      TableArn: 'TABLE_ARN',
      S3Bucket: 'BACKUP_BUCKET',
      S3Prefix: 'exports/<aws.scheduler.scheduled-time>',
      ExportFormat: 'DYNAMODB_JSON',
      ExportType: 'FULL_EXPORT',
      ClientToken: '<aws.scheduler.scheduled-time>',
    });
    expect(tableId).toBeDefined();
    expect(backupId).toBeDefined();
  });

  it('adds no Lambda function of its own: nothing invokes a function from the weekly schedule', () => {
    expect(ofType('AWS::Lambda::Function')).toHaveLength(4);
    expect(JSON.stringify(schedule)).not.toContain('lambda');
    expect(JSON.stringify(role)).not.toContain('lambda:');
  });

  it('has a role named with the prefix, trusted only by the Scheduler of this account, with the boundary and no managed policy', () => {
    expect(role).toBeDefined();
    expect(role?.Properties.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal: { Service: 'scheduler.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
          },
        },
      ],
    });
    // Scheduler validates the role without the schedule ARN in context: no SourceArn here.
    expect(JSON.stringify(role?.Properties.AssumeRolePolicyDocument)).not.toContain('aws:SourceArn');
    expect(JSON.stringify(role?.Properties.PermissionsBoundary)).toContain(':policy/CupmarkBoundary');
    expect(role?.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('allows ExportTableToPointInTime on the table ARN, and S3 writes under exports/ of the backup bucket, and nothing else', () => {
    const policies = role?.Properties.Policies as { PolicyDocument: { Statement: Json[] } }[];
    expect(policies).toHaveLength(1);
    expect(policies[0]?.PolicyDocument.Statement).toEqual([
      {
        Sid: 'ExportTable',
        Effect: 'Allow',
        Action: 'dynamodb:ExportTableToPointInTime',
        // Exactly the table ARN: no `/index/*`, no `/stream/*`, no wildcard.
        Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
      },
      {
        Sid: 'WriteExportFiles',
        Effect: 'Allow',
        Action: ['s3:AbortMultipartUpload', 's3:PutObject', 's3:PutObjectAcl'],
        // The backup bucket's exports/ prefix only: not the bucket, not read, not delete.
        Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [backupId, 'Arn'] }, '/exports/*']] },
      },
    ]);
  });

  it('has no iam or other service actions, no Deny, no wildcard action and no delete in the role', () => {
    const text = JSON.stringify(role?.Properties.Policies);
    expect(text).not.toMatch(/iam:|kms:|secretsmanager:|dynamodb:(?!ExportTableToPointInTime)/);
    expect(text).not.toMatch(/"Action":(\[[^\]]*)?"[^"]*\*/);
    expect(text).not.toMatch(/[Dd]elete|s3:Get|s3:List/);
  });

  it('is tagged project=cupmark (schedule group and role) in a stack that carries the stage tags', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Tags: Match.arrayWith([{ Key: 'project', Value: 'cupmark' }]),
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `cupmark-${stage}-export-scheduler`,
      Tags: Match.arrayWith([{ Key: 'project', Value: 'cupmark' }]),
    });
  });

  it('keeps the backup bucket lifecycle: archive after 30 days, expire after 365', () => {
    expect(BACKUP_ARCHIVE_AFTER_DAYS).toBe(30);
    expect(BACKUP_EXPIRE_AFTER_DAYS).toBe(365);
    const bucket = ofType('AWS::S3::Bucket').find(([id]) => id === backupId)?.[1];
    const rules = (bucket?.Properties.LifecycleConfiguration as { Rules: Json[] }).Rules;
    expect(rules.find((r) => r.Id === 'archive-then-expire-exports')).toMatchObject({
      Status: 'Enabled',
      ExpirationInDays: 365,
      Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
    });
  });

  it('adds no fixed-fee resource type to the template', () => {
    const forbidden = /^AWS::(WAFv2|WAF|EC2::(NatGateway|VPCEndpoint|VPC|EIP)|RDS|OpenSearch|Elasticsearch|ElastiCache|KMS|SecretsManager|Kinesis)/;
    expect(Object.values(all).map((r) => r.Type).filter((t) => forbidden.test(t))).toEqual([]);
    expect(JSON.stringify(all)).not.toContain('ProvisionedConcurrency');
  });

  it('names every new resource with the cupmark-<stage>- prefix', () => {
    const names = [
      role?.Properties.RoleName,
      schedule?.Properties.Name,
      schedule?.Properties.GroupName,
      ofType('AWS::Scheduler::ScheduleGroup')[0]?.[1].Properties.Name,
    ];
    for (const n of names) expect(n).toMatch(new RegExp(`^cupmark-${stage}-`));
  });
});
