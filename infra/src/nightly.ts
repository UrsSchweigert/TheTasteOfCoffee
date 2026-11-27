// The nightly rebuild of the community aggregates (ADR 0035; M3-T9). One Lambda scans the
// table and rewrites the aggregate and ranking items; an EventBridge Scheduler schedule in
// the stage's jobs group (created by the weekly export, src/export.ts) starts it once a
// day. Optional failure alarms (ADR 0035, Addendum 2) exist only while the stage flag
// `failureAlarms.enabled` is on: then two CloudWatch alarms publish to one SNS topic.
// Nothing here subscribes anyone: the owner does that by hand (invariant 8).

import { ArnFormat, Aws, Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import {
  ERRORS_ALARM_PERIOD_SECONDS,
  MISSING_RUN_ALARM_PERIOD_HOURS,
  NAME_PREFIX,
  NIGHTLY_FLEXIBLE_WINDOW_MINUTES,
  NIGHTLY_MAX_RETRY_ATTEMPTS,
  NIGHTLY_MEMORY_MB,
  NIGHTLY_SCHEDULE,
  NIGHTLY_SCHEDULE_TIMEZONE,
  NIGHTLY_TIMEOUT_SECONDS,
} from './config.ts';
import type { StageName, StageSettings } from './config.ts';
import type { CupmarkData } from './data.ts';
import { jobsGroupName } from './export.ts';
import { cupmarkFunction, functionName } from './functions.ts';

/** Exactly what the job does to the table: a full scan, then batched puts and deletes of aggregate items. */
export const NIGHTLY_WRITE_ACTIONS = ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem'] as const;
/** Partition-key patterns the job may write (keys.ts: `BEAN#<id>` / `AGG#...`, `RANK#<facet>`). */
export const NIGHTLY_WRITE_PARTITIONS = ['BEAN#*', 'RANK#*'] as const;

export interface CupmarkNightlyProps {
  readonly stage: StageName;
  readonly data: CupmarkData;
  /** The group created by CupmarkExport; the nightly schedule joins it, a second group is never created. */
  readonly jobsGroup: scheduler.CfnScheduleGroup;
  readonly settings: StageSettings;
}

export function alertsTopicName(stage: StageName): string {
  return `${NAME_PREFIX}${stage}-alerts`;
}

export function nightlyScheduleName(stage: StageName): string {
  return `${NAME_PREFIX}${stage}-nightly-aggregates`;
}

export class CupmarkNightly extends Construct {
  public readonly function: lambda.Function;
  public readonly schedulerRole: iam.Role;
  public readonly schedule: scheduler.CfnSchedule;
  /** Present only when `failureAlarms.enabled`. */
  public readonly alertsTopic: sns.Topic | undefined;
  public readonly errorsAlarm: cloudwatch.CfnAlarm | undefined;
  public readonly missingRunAlarm: cloudwatch.CfnAlarm | undefined;

  public constructor(scope: Construct, id: string, props: CupmarkNightlyProps) {
    super(scope, id);
    const { stage, data, settings } = props;
    const fnName = functionName(stage, 'nightly-aggregates');
    const scheduleName = nightlyScheduleName(stage);

    this.function = cupmarkFunction(this, {
      stage,
      part: 'nightly-aggregates',
      id: 'Nightly',
      description: 'Nightly rebuild of the community aggregates (ADR 0035)',
      memorySize: NIGHTLY_MEMORY_MB,
      timeout: Duration.seconds(NIGHTLY_TIMEOUT_SECONDS),
      // No reserved and no provisioned concurrency: the schedule starts one run a day.
      // The Scheduler invokes asynchronously, so Lambda would retry a throwing run twice by itself
      // (up to 6 h). One retry at most overall: Lambda's are off, the Scheduler's one stays.
      retryAttempts: 0,
      environment: { TABLE_NAME: data.table.tableName },
      statements: [
        new iam.PolicyStatement({
          sid: 'ScanTable',
          actions: ['dynamodb:Scan'],
          // The table ARN only: no index/*, no stream/*. Scan carries no key, so no key condition.
          resources: [data.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'WriteAggregates',
          actions: [...NIGHTLY_WRITE_ACTIONS],
          resources: [data.table.tableArn],
          // Only the partitions the rebuild owns: BEAN#<id> (AGG# items) and RANK#<facet>. Never
          // USER#, DELETED# or BARCODE#. Key prefixes are in backend/src/repository/keys.ts.
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...NIGHTLY_WRITE_PARTITIONS] } },
        }),
      ],
    });

    const roleName = `${NAME_PREFIX}${stage}-nightly-scheduler`;
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName,
      description: `Lets the Scheduler invoke ${fnName}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        // Account-only guard. With aws:SourceArn set to this schedule's ARN, CreateSchedule was
        // refused ("must allow AWS EventBridge Scheduler to assume the role", ADR 0035
        // Addendum 3); the cause is not confirmed (the schedule-group ARN is untried). The
        // role can only invoke this one function; the aws:SourceAccount condition remains.
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        },
      }),
      inlinePolicies: {
        [roleName]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'InvokeNightlyFunction',
              actions: ['lambda:InvokeFunction'],
              resources: [this.function.functionArn],
            }),
          ],
        }),
      },
    });

    this.schedule = new scheduler.CfnSchedule(this, 'Schedule', {
      name: scheduleName,
      description: 'Nightly rebuild of the community aggregates (02:00 UTC)',
      groupName: jobsGroupName(stage),
      state: settings.nightlyScheduleEnabled ? 'ENABLED' : 'DISABLED',
      scheduleExpression: NIGHTLY_SCHEDULE,
      scheduleExpressionTimezone: NIGHTLY_SCHEDULE_TIMEZONE,
      flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: NIGHTLY_FLEXIBLE_WINDOW_MINUTES },
      target: {
        arn: this.function.functionArn,
        roleArn: this.schedulerRole.roleArn,
        // An empty event: never a dry run, no input that selects users or beans.
        input: '{}',
        retryPolicy: { maximumRetryAttempts: NIGHTLY_MAX_RETRY_ATTEMPTS },
        // No deadLetterConfig: no queue. A failed run is in the logs and, with the flag on, in the alarm.
      },
    });
    this.schedule.node.addDependency(props.jobsGroup);
    this.schedule.node.addDependency(this.schedulerRole);

    if (!settings.failureAlarms.enabled) return;

    const topic = new sns.Topic(this, 'Alerts', { topicName: alertsTopicName(stage) });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchAlarmsOfThisAccountMayPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({
              service: 'cloudwatch',
              resource: 'alarm',
              // formatArn defaults to the slash form; alarm ARNs use a colon.
              resourceName: `${NAME_PREFIX}${stage}-*`,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );
    this.alertsTopic = topic;

    const dimensions = [{ name: 'FunctionName', value: fnName }];
    this.errorsAlarm = new cloudwatch.CfnAlarm(this, 'ErrorsAlarm', {
      alarmName: `${NAME_PREFIX}${stage}-nightly-aggregates-errors`,
      alarmDescription: 'The nightly aggregates run failed (ADR 0035)',
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensions,
      statistic: 'Sum',
      period: ERRORS_ALARM_PERIOD_SECONDS,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      // No invocation, no data point: the missing-run alarm covers that case.
      treatMissingData: 'notBreaching',
      alarmActions: [topic.topicArn],
    });

    // A schedule that is disabled (prod until the owner enables it) would breach every day.
    if (settings.nightlyScheduleEnabled) {
      this.missingRunAlarm = new cloudwatch.CfnAlarm(this, 'MissingRunAlarm', {
        alarmName: `${NAME_PREFIX}${stage}-nightly-aggregates-missing-run`,
        alarmDescription: 'The nightly aggregates function was not invoked in 25 hours (ADR 0035)',
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensions,
        statistic: 'Sum',
        period: MISSING_RUN_ALARM_PERIOD_HOURS * 3600,
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: 'LessThanThreshold',
        treatMissingData: 'breaching',
        alarmActions: [topic.topicArn],
      });
    }
  }
}
