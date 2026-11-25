// From the M1-T1 review: the logical ids of the stateful resources are pinned. A
// construct rename or move changes a logical id, and CloudFormation then creates a new
// resource and (with RETAIN) orphans the old one: a new, empty table, bucket or user
// pool, with the data left behind. This test fails first. Changing an id here needs a
// migration plan, not a snapshot update. Adding a new stateful resource adds its id
// here (M1-T6: the deletion log bucket, ADR 0017); the existing ids stay as they are.
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/config.ts';
import { testApp } from './helpers.ts';

const PINNED: Readonly<Record<string, string>> = {
  DataTableFDBAD0F2: 'AWS::DynamoDB::Table',
  DataPhotoBucketAD8405B8: 'AWS::S3::Bucket',
  DataBackupBucket76592319: 'AWS::S3::Bucket',
  DataDeletionLogBucket57550E3D: 'AWS::S3::Bucket',
  IdentityUserPool96FE3B9B: 'AWS::Cognito::UserPool',
};

describe.each(STAGES)('stage %s', (stage) => {
  it('keeps the logical ids of the table, the three buckets and the user pool', () => {
    const { stages } = testApp({ context: { stage } });
    const core = stages[0]?.core;
    if (core === undefined) throw new Error(`stage ${stage} missing`);
    const all = (Template.fromStack(core).toJSON() as { Resources: Record<string, { Type: string }> }).Resources;
    const stateful = Object.fromEntries(
      Object.entries(all)
        .filter(([, r]) => Object.values(PINNED).includes(r.Type))
        .map(([id, r]) => [id, r.Type]),
    );
    expect(stateful).toEqual(PINNED);
  });
});
