// M3-T9: the nightly rebuild of the community aggregates. A Lambda scans the table and
// rewrites the aggregate items; a Scheduler schedule in the shared jobs group starts it
// once a day. The failure alarms and their topic exist only while the stage flag is on.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  ERRORS_ALARM_PERIOD_SECONDS,
  MISSING_RUN_ALARM_PERIOD_HOURS,
  NIGHTLY_MEMORY_MB,
  NIGHTLY_TIMEOUT_SECONDS,
  STAGES,
  STAGE_SETTINGS,
} from '../src/config.ts';
import type { StageName, StageSettings } from '../src/config.ts';
import { checkApp, formatViolations } from '../src/guards.ts';
import { CupmarkStage } from '../src/stage.ts';
import { readCdkJson, testApp } from './helpers.ts';

type Json = Record<string, unknown>;
interface Resource {
  readonly Type: string;
  readonly Properties: Json;
}
interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action: string | string[];
  readonly Resource: unknown;
  readonly Principal?: unknown;
  readonly Condition?: unknown;
}

const FORBIDDEN = /^AWS::(WAFv2|WAF|EC2::(NatGateway|VPCEndpoint|VPC|EIP)|RDS|OpenSearch|Elasticsearch|ElastiCache|KMS|SecretsManager|Kinesis)/;

/** One stage, built in its own app with the given settings (the real config is never changed). */
function build(stage: StageName, settings: StageSettings): { template: Template; all: Record<string, Resource>; violations: string } {
  const app = new App({ analyticsReporting: false, context: readCdkJson().context });
  const cupmarkStage = new CupmarkStage(app, { stage, settings });
  const template = Template.fromStack(cupmarkStage.core);
  const all = (template.toJSON() as { Resources: Record<string, Resource> }).Resources;
  return { template, all, violations: formatViolations(checkApp(app)) };
}

const ofType = (all: Record<string, Resource>, type: string): [string, Resource][] =>
  Object.entries(all).filter(([, r]) => r.Type === type);

describe('the stage settings in infra/src/config.ts', () => {
  it('have the failure alarms off for dev and prod, and the prod schedule disabled', () => {
    expect(STAGE_SETTINGS.dev.failureAlarms).toEqual({ enabled: false });
    expect(STAGE_SETTINGS.prod.failureAlarms).toEqual({ enabled: false });
    expect(STAGE_SETTINGS.dev.nightlyScheduleEnabled).toBe(true);
    expect(STAGE_SETTINGS.prod.nightlyScheduleEnabled).toBe(false);
  });

  it('are what the real app synthesises: no alarm and no topic by default, either stage', () => {
    for (const { stages } of STAGES.map((stage) => testApp({ context: { stage } }))) {
      const all = (Template.fromStack(stages[0]?.core as never).toJSON() as { Resources: Record<string, Resource> }).Resources;
      expect(ofType(all, 'AWS::CloudWatch::Alarm')).toEqual([]);
      expect(ofType(all, 'AWS::SNS::Topic')).toEqual([]);
      expect(ofType(all, 'AWS::SNS::TopicPolicy')).toEqual([]);
    }
  });
});

describe.each(STAGES)('stage %s, default settings', (stage) => {
  const { template, all, violations } = build(stage, STAGE_SETTINGS[stage]);
  const fnName = `cupmark-${stage}-nightly-aggregates`;
  const fn = ofType(all, 'AWS::Lambda::Function').find(([, r]) => r.Properties.FunctionName === fnName);
  const role = ofType(all, 'AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === fnName)?.[1];
  const schedulerRole = ofType(all, 'AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === `cupmark-${stage}-nightly-scheduler`)?.[1].Properties;
  const schedule = ofType(all, 'AWS::Scheduler::Schedule').find(([, r]) => r.Properties.Name === fnName)?.[1].Properties;
  const tableId = ofType(all, 'AWS::DynamoDB::Table')[0]?.[0];

  it('passes every guard', () => {
    expect(violations).toBe('');
  });

  it('is a Node 22 arm64 function with 300 s, 512 MB, no VPC and no concurrency setting', () => {
    expect(NIGHTLY_TIMEOUT_SECONDS).toBe(300);
    expect(NIGHTLY_MEMORY_MB).toBe(512);
    expect(fn?.[1].Properties).toMatchObject({
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 300,
      MemorySize: 512,
      Environment: { Variables: { TABLE_NAME: { Ref: tableId }, NODE_OPTIONS: '--enable-source-maps' } },
    });
    expect(fn?.[1].Properties.VpcConfig).toBeUndefined();
    expect(fn?.[1].Properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(JSON.stringify(all)).not.toContain('ProvisionedConcurrency');
  });

  it('has a log group with 14-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/aws/lambda/${fnName}`, RetentionInDays: 14 });
  });

  it('has a role with exactly the log and table statements, on the table ARN only, and the boundary', () => {
    const policies = role?.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[];
    const statements = policies.flatMap((p) => p.PolicyDocument.Statement);
    expect(statements.map((s) => s.Sid)).toEqual(['Logs', 'RebuildAggregates']);
    const table = statements[1];
    expect(table?.Effect).toBe('Allow');
    expect(table?.Action).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:Scan']);
    // Exactly the table ARN: no `/index/*`, no `/stream/*`, no wildcard.
    expect(table?.Resource).toEqual({ 'Fn::GetAtt': [tableId, 'Arn'] });
    expect(JSON.stringify(role?.Properties.Policies)).not.toMatch(/"\*"|index|stream/);
    expect(role?.Properties.ManagedPolicyArns).toBeUndefined();
    // The boundary comes from the stage (Aspect on every role), as for the other roles.
    expect(JSON.stringify(role?.Properties.PermissionsBoundary)).toContain('CupmarkBoundary');
  });

  it('has no event source mapping: the stream stays enabled and unread', () => {
    expect(ofType(all, 'AWS::Lambda::EventSourceMapping')).toEqual([]);
    template.hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } });
  });

  it('is started once a day at 02:00 UTC in the shared jobs group, with a 15 minute window and one retry', () => {
    expect(ofType(all, 'AWS::Scheduler::ScheduleGroup')).toHaveLength(1);
    expect(schedule).toMatchObject({
      Name: fnName,
      GroupName: `cupmark-${stage}-jobs`,
      ScheduleExpression: 'cron(0 2 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 15 },
      State: stage === 'prod' ? 'DISABLED' : 'ENABLED',
    });
    const target = schedule?.Target as Json;
    expect(Object.keys(target).sort()).toEqual(['Arn', 'Input', 'RetryPolicy', 'RoleArn']);
    expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 1 });
    expect(target.Input).toBe('{}');
    expect(target.Arn).toEqual({ 'Fn::GetAtt': [fn?.[0], 'Arn'] });
    // No dead-letter queue and no queue at all.
    expect(JSON.stringify(schedule)).not.toContain('DeadLetter');
    expect(ofType(all, 'AWS::SQS::Queue')).toEqual([]);
  });

  it('gives the Scheduler a role that may only invoke this function, trusted for this schedule only', () => {
    const doc = (schedulerRole?.Policies as { PolicyDocument: { Statement: Statement[] } }[])[0]?.PolicyDocument;
    expect(doc?.Statement).toEqual([
      { Sid: 'InvokeNightlyFunction', Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [fn?.[0], 'Arn'] } },
    ]);
    expect(schedulerRole?.AssumeRolePolicyDocument).toMatchObject({
      Statement: [
        {
          Principal: { Service: 'scheduler.amazonaws.com' },
          Condition: {
            StringEquals: {
              'aws:SourceAccount': { Ref: 'AWS::AccountId' },
              'aws:SourceArn': {
                'Fn::Join': ['', ['arn:aws:scheduler:eu-central-1:', { Ref: 'AWS::AccountId' }, `:schedule/cupmark-${stage}-jobs/${fnName}`]],
              },
            },
          },
        },
      ],
    });
  });

  it('has no forbidden resource type, no subscription and only cupmark- names and project=cupmark tags', () => {
    expect(Object.values(all).map((r) => r.Type).filter((t) => FORBIDDEN.test(t))).toEqual([]);
    expect(ofType(all, 'AWS::SNS::Subscription')).toEqual([]);
    for (const [, r] of Object.entries(all)) {
      const name = r.Properties.FunctionName ?? r.Properties.RoleName ?? r.Properties.LogGroupName;
      if (typeof name === 'string' && ['AWS::Lambda::Function', 'AWS::IAM::Role'].includes(r.Type)) {
        expect(name).toMatch(new RegExp(`^cupmark-${stage}-`));
      }
    }
    for (const r of [fn?.[1]]) {
      expect(r?.Properties.Tags).toEqual(expect.arrayContaining([{ Key: 'project', Value: 'cupmark' }]));
    }
  });
});

describe.each(STAGES)('stage %s, failure alarms flag', (stage) => {
  const topicName = `cupmark-${stage}-alerts`;
  const fnName = `cupmark-${stage}-nightly-aggregates`;

  describe('off', () => {
    const { all, violations } = build(stage, { failureAlarms: { enabled: false }, nightlyScheduleEnabled: true });
    it('creates no alarm, no topic and no topic policy, and still passes the guards', () => {
      expect(violations).toBe('');
      expect(ofType(all, 'AWS::CloudWatch::Alarm')).toEqual([]);
      expect(ofType(all, 'AWS::SNS::Topic')).toEqual([]);
      expect(ofType(all, 'AWS::SNS::TopicPolicy')).toEqual([]);
      expect(ofType(all, 'AWS::SNS::Subscription')).toEqual([]);
    });
  });

  describe('on', () => {
    const { template, all, violations } = build(stage, { failureAlarms: { enabled: true }, nightlyScheduleEnabled: true });
    const topicId = ofType(all, 'AWS::SNS::Topic')[0]?.[0];
    const alarms = ofType(all, 'AWS::CloudWatch::Alarm').map(([, r]) => r.Properties);
    const errors = alarms.find((a) => a.MetricName === 'Errors');
    const missing = alarms.find((a) => a.MetricName === 'Invocations');

    it('passes every guard', () => {
      expect(violations).toBe('');
    });

    it('has exactly the topic cupmark-<stage>-alerts and two alarms, tagged project=cupmark', () => {
      expect(ofType(all, 'AWS::SNS::Topic')).toHaveLength(1);
      template.hasResourceProperties('AWS::SNS::Topic', { TopicName: topicName, Tags: [{ Key: 'project', Value: 'cupmark' }, { Key: 'stage', Value: stage }] });
      expect(alarms).toHaveLength(2);
      for (const a of alarms) {
        expect(a.AlarmName).toMatch(new RegExp(`^cupmark-${stage}-`));
        expect(a.Tags).toEqual(expect.arrayContaining([{ Key: 'project', Value: 'cupmark' }]));
      }
    });

    it('raises on one failed night: Errors, Sum, >= 1 over 86,400 seconds', () => {
      expect(MISSING_RUN_ALARM_PERIOD_HOURS).toBe(25);
      expect(ERRORS_ALARM_PERIOD_SECONDS).toBe(86_400);
      expect(errors).toMatchObject({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Dimensions: [{ Name: 'FunctionName', Value: fnName }],
        Statistic: 'Sum',
        Period: 86_400,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('raises on a missing run: Invocations, Sum, < 1 over 25 hours, missing data breaching', () => {
      expect(missing).toMatchObject({
        Namespace: 'AWS/Lambda',
        MetricName: 'Invocations',
        Dimensions: [{ Name: 'FunctionName', Value: fnName }],
        Statistic: 'Sum',
        Period: 90_000,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
        TreatMissingData: 'breaching',
      });
    });

    it('sends both alarms to the topic and to nothing else', () => {
      for (const a of alarms) {
        expect(a.AlarmActions).toEqual([{ Ref: topicId }]);
        expect(a.OKActions).toBeUndefined();
        expect(a.InsufficientDataActions).toBeUndefined();
      }
    });

    it('lets only CloudWatch alarms of this account publish to the topic', () => {
      const policies = ofType(all, 'AWS::SNS::TopicPolicy');
      expect(policies).toHaveLength(1);
      const props = policies[0]?.[1].Properties as { Topics: unknown[]; PolicyDocument: { Statement: Statement[] } };
      expect(props.Topics).toEqual([{ Ref: topicId }]);
      expect(props.PolicyDocument.Statement).toEqual([
        {
          Sid: 'CloudWatchAlarmsOfThisAccountMayPublish',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: 'sns:Publish',
          Resource: { Ref: topicId },
          Condition: {
            StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
            ArnLike: {
              'aws:SourceArn': { 'Fn::Join': ['', ['arn:aws:cloudwatch:eu-central-1:', { Ref: 'AWS::AccountId' }, `:alarm:cupmark-${stage}-*`]] },
            },
          },
        },
      ]);
    });

    it('has no subscription, no endpoint (no @, no phone number) and no custom metric', () => {
      expect(ofType(all, 'AWS::SNS::Subscription')).toEqual([]);
      const text = JSON.stringify(all);
      expect(text).not.toContain('@');
      expect(text).not.toMatch(/"Endpoint"|"Protocol"/);
      expect(text).not.toMatch(/\+\d{6,}/);
      for (const a of alarms) expect(a.Namespace).toBe('AWS/Lambda');
    });

    it('adds no resource with a monthly fee beyond the two alarms', () => {
      const types = Object.values(all).map((r) => r.Type);
      expect(types.filter((t) => FORBIDDEN.test(t))).toEqual([]);
      expect(types.filter((t) => t === 'AWS::CloudWatch::Alarm')).toHaveLength(2);
      expect(types.filter((t) => t.startsWith('AWS::CloudWatch::') && t !== 'AWS::CloudWatch::Alarm')).toEqual([]);
    });
  });
});

describe('prod while the schedule is disabled', () => {
  it('has the schedule DISABLED and, with the flag on, the errors alarm but no missing-run alarm', () => {
    const { all, violations } = build('prod', { failureAlarms: { enabled: true }, nightlyScheduleEnabled: false });
    expect(violations).toBe('');
    const schedule = ofType(all, 'AWS::Scheduler::Schedule').find(([, r]) => r.Properties.Name === 'cupmark-prod-nightly-aggregates')?.[1];
    expect(schedule?.Properties.State).toBe('DISABLED');
    const metrics = ofType(all, 'AWS::CloudWatch::Alarm').map(([, r]) => r.Properties.MetricName);
    expect(metrics).toEqual(['Errors']);
    expect(ofType(all, 'AWS::SNS::Topic')).toHaveLength(1);
  });

  it('has both alarms once the schedule is enabled', () => {
    const { all } = build('prod', { failureAlarms: { enabled: true }, nightlyScheduleEnabled: true });
    const metrics = ofType(all, 'AWS::CloudWatch::Alarm').map(([, r]) => r.Properties.MetricName).sort();
    expect(metrics).toEqual(['Errors', 'Invocations']);
  });
});
