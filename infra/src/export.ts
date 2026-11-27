// The weekly full table export (docs/05-system-design.md, Persistence and recovery; M3-T11).
// An EventBridge Scheduler schedule calls DynamoDB's ExportTableToPointInTime directly
// through a universal target: no Lambda, no code, nothing to patch. The export reads the
// table's point-in-time-recovery data, so it uses no read capacity. The files land in the
// stage's backup bucket, whose lifecycle moves them to archive storage after 30 days and
// deletes them after 365 (src/data.ts).

import { Aws, Fn } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { NAME_PREFIX } from './config.ts';
import type { StageName } from './config.ts';
import type { CupmarkData } from './data.ts';

/** Every export goes under this prefix of the backup bucket; the role may write nowhere else. */
export const EXPORT_PREFIX = 'exports/';

/** Sundays at 03:00 UTC, an hour after the nightly rebuild (02:00), so the export holds fresh aggregates. */
export const EXPORT_SCHEDULE = 'cron(0 3 ? * SUN *)';
export const EXPORT_SCHEDULE_TIMEZONE = 'UTC';

/** The universal target: Scheduler calls this SDK action with the schedule's input as the request. */
export const EXPORT_TARGET_ARN = 'arn:aws:scheduler:::aws-sdk:dynamodb:exportTableToPointInTime';

export const EXPORT_FORMAT = 'DYNAMODB_JSON';
export const EXPORT_TYPE = 'FULL_EXPORT';

/** At most two retries of a failed call. Scheduler's retries reuse the same ClientToken. */
export const EXPORT_MAX_RETRY_ATTEMPTS = 2;

/**
 * The actions an export needs on its bucket (AWS documentation, "Requesting a table
 * export in DynamoDB"). The boundary today allows only PutObject of these (see the
 * M3-T11 note in backlog/BACKLOG.md).
 */
export const EXPORT_S3_ACTIONS = ['s3:AbortMultipartUpload', 's3:PutObject', 's3:PutObjectAcl'] as const;

export interface CupmarkExportProps {
  readonly stage: StageName;
  readonly data: CupmarkData;
}

/** `cupmark-<stage>-jobs`: the schedule group of the stage (M3-T9 puts the nightly schedule in it too). */
export function jobsGroupName(stage: StageName): string {
  return `${NAME_PREFIX}${stage}-jobs`;
}

export class CupmarkExport extends Construct {
  public readonly role: iam.Role;
  public readonly group: scheduler.CfnScheduleGroup;
  public readonly schedule: scheduler.CfnSchedule;

  public constructor(scope: Construct, id: string, props: CupmarkExportProps) {
    super(scope, id);
    const { stage, data } = props;
    const roleName = `${NAME_PREFIX}${stage}-export-scheduler`;
    const scheduleName = `${NAME_PREFIX}${stage}-weekly-export`;

    this.role = new iam.Role(this, 'Role', {
      roleName,
      description: `Lets the Scheduler start the weekly export of cupmark-${stage}-main`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        // Account-only guard. With aws:SourceArn set to this schedule's ARN, CreateSchedule was
        // refused ("must allow AWS EventBridge Scheduler to assume the role", ADR 0035
        // Addendum 3); the cause is not confirmed (the schedule-group ARN is untried). The
        // role can only start this one table export; the aws:SourceAccount condition remains.
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        },
      }),
      inlinePolicies: {
        [roleName]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ExportTable',
              actions: ['dynamodb:ExportTableToPointInTime'],
              // The table ARN only: no index, no stream.
              resources: [data.table.tableArn],
            }),
            new iam.PolicyStatement({
              sid: 'WriteExportFiles',
              actions: [...EXPORT_S3_ACTIONS],
              resources: [`${data.backupBucket.bucketArn}/${EXPORT_PREFIX}*`],
            }),
          ],
        }),
      },
    });

    this.group = new scheduler.CfnScheduleGroup(this, 'Group', { name: jobsGroupName(stage) });

    this.schedule = new scheduler.CfnSchedule(this, 'Schedule', {
      name: scheduleName,
      description: 'Weekly full export of the table to the backup bucket (DynamoDB JSON)',
      groupName: jobsGroupName(stage),
      state: 'ENABLED',
      scheduleExpression: EXPORT_SCHEDULE,
      scheduleExpressionTimezone: EXPORT_SCHEDULE_TIMEZONE,
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: EXPORT_TARGET_ARN,
        roleArn: this.role.roleArn,
        retryPolicy: { maximumRetryAttempts: EXPORT_MAX_RETRY_ATTEMPTS },
        // Scheduler fills the context attribute when it calls: the scheduled time (ISO 8601,
        // so the prefix is dated and sorts). It is the same on every retry of one run, so
        // it is also the ClientToken: a retried call should not start a second export
        // (to be verified on the first run).
        input: Fn.join('', [
          '{"TableArn":"',
          data.table.tableArn,
          '","S3Bucket":"',
          data.backupBucket.bucketName,
          `","S3Prefix":"${EXPORT_PREFIX}<aws.scheduler.scheduled-time>`,
          `","ExportFormat":"${EXPORT_FORMAT}","ExportType":"${EXPORT_TYPE}",`,
          '"ClientToken":"<aws.scheduler.scheduled-time>"}',
        ]),
      },
    });
    this.schedule.node.addDependency(this.group);
    this.schedule.node.addDependency(this.role);
  }
}
