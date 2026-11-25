// M1-T1: the table and both buckets of each stage, with the safety properties of
// docs/05-system-design.md (Data model, Persistence and recovery) pinned one by one.
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/config.ts';
import type { StageName } from '../src/config.ts';
import { LABEL_PHOTO_PREFIX, TTL_ATTRIBUTE, UPLOAD_PHOTO_PREFIX } from '../src/data.ts';
import { testApp } from './helpers.ts';

type Resource = { Type: string; Properties: Record<string, unknown> } & Record<string, unknown>;

function templateOf(stage: StageName): Template {
  const { stages } = testApp({ context: { stage } });
  const s = stages[0];
  if (s === undefined) throw new Error(`stage ${stage} missing`);
  return Template.fromStack(s.core);
}

function only(template: Template, type: string): [string, Resource] {
  const found = Object.entries(template.findResources(type)) as [string, Resource][];
  expect(found).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error(`no ${type}`);
  return first;
}

/** The bucket whose name starts with `cupmark-<stage>-<part>-`, and its logical id. */
function bucket(template: Template, stage: StageName, part: string): [string, Resource] {
  const prefix = `cupmark-${stage}-${part}-`;
  const hits = (Object.entries(template.findResources('AWS::S3::Bucket')) as [string, Resource][]).filter(
    ([, r]) => JSON.stringify(r.Properties.BucketName).includes(`"${prefix}"`),
  );
  expect(hits, prefix).toHaveLength(1);
  const hit = hits[0];
  if (hit === undefined) throw new Error(`no bucket ${prefix}`);
  return hit;
}

const TAGS = (stage: StageName) =>
  Match.arrayWith([{ Key: 'project', Value: 'cupmark' }, { Key: 'stage', Value: stage }]);

describe.each(STAGES)('stage %s', (stage) => {
  const template = templateOf(stage);

  describe('the table', () => {
    const [tableId, table] = only(template, 'AWS::DynamoDB::Table');
    const props = table.Properties;

    it(`is named cupmark-${stage}-main and tagged`, () => {
      expect(props.TableName).toBe(`cupmark-${stage}-main`);
      template.hasResourceProperties('AWS::DynamoDB::Table', { Tags: TAGS(stage) });
    });

    it('has the generic keys pk (S) and sk (S)', () => {
      expect(props.KeySchema).toEqual([
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]);
      expect(props.AttributeDefinitions).toEqual(
        expect.arrayContaining([
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ]),
      );
    });

    it('is on-demand, with no provisioned throughput anywhere', () => {
      expect(props.BillingMode).toBe('PAY_PER_REQUEST');
      expect(JSON.stringify(table)).not.toContain('ProvisionedThroughput');
    });

    it('has point-in-time recovery on, with the 35-day window', () => {
      expect(props.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 35,
      });
    });

    it('has deletion protection on', () => {
      expect(props.DeletionProtectionEnabled).toBe(true);
    });

    it('streams NEW_AND_OLD_IMAGES, and has no Kinesis stream', () => {
      expect(props.StreamSpecification).toEqual({ StreamViewType: 'NEW_AND_OLD_IMAGES' });
      expect(props.KinesisStreamSpecification).toBeUndefined();
    });

    it('is RETAIN on delete and on replacement', () => {
      expect(table.DeletionPolicy).toBe('Retain');
      expect(table.UpdateReplacePolicy).toBe('Retain');
    });

    it('uses the AWS-owned key: no KMS key, no SSE-KMS', () => {
      expect(props.SSESpecification).toEqual({ SSEEnabled: false });
      expect(JSON.stringify(table)).not.toMatch(/KMSMasterKeyId|"SSEType"/);
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('expires items by TTL on expires_at only (Open Food Facts misses and lookup counters)', () => {
      expect(TTL_ATTRIBUTE).toBe('expires_at');
      expect(props.TimeToLiveSpecification).toEqual({ AttributeName: 'expires_at', Enabled: true });
    });

    it('has exactly one index: the sparse review queue gsi1 (gsi1pk, gsi1sk), on-demand', () => {
      expect(props.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ]);
      expect(props.LocalSecondaryIndexes).toBeUndefined();
      expect(props.AttributeDefinitions).toEqual(
        expect.arrayContaining([
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'S' },
        ]),
      );
    });

    it('outputs its name and stream ARN, without exports', () => {
      const outputs = template.toJSON() as { Outputs: Record<string, { Value: unknown; Export?: unknown }> };
      const values = Object.values(outputs.Outputs);
      expect(values.map((o) => o.Value)).toEqual(
        expect.arrayContaining([{ Ref: tableId }, { 'Fn::GetAtt': [tableId, 'StreamArn'] }]),
      );
      expect(values.every((o) => o.Export === undefined)).toBe(true);
    });
  });

  describe.each(['photos', 'backups'])('the %s bucket', (part) => {
    const [bucketId, b] = bucket(template, stage, part);
    const props = b.Properties;

    it(`is named cupmark-${stage}-${part}-<account> and tagged`, () => {
      expect(props.BucketName).toEqual({ 'Fn::Join': ['', [`cupmark-${stage}-${part}-`, { Ref: 'AWS::AccountId' }]] });
      expect(props.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'project', Value: 'cupmark' },
          { Key: 'stage', Value: stage },
        ]),
      );
    });

    it('blocks all public access', () => {
      expect(props.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    });

    it('enforces bucket-owner object ownership (ACLs disabled)', () => {
      expect(props.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    });

    it('keeps versions', () => {
      expect(props.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    });

    it('is encrypted with S3-managed keys, never KMS', () => {
      expect(props.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      });
    });

    it('is RETAIN on delete and on replacement', () => {
      expect(b.DeletionPolicy).toBe('Retain');
      expect(b.UpdateReplacePolicy).toBe('Retain');
    });

    it('has a TLS-only bucket policy (TLS 1.2 or later)', () => {
      const resources = [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, '/*']] }];
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        Bucket: { Ref: bucketId },
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Resource: resources,
            },
            {
              Action: 's3:*',
              Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } },
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Resource: resources,
            },
          ]),
        },
      });
    });

    it('has no access logging, replication, website, CORS or notifications', () => {
      for (const key of [
        'LoggingConfiguration',
        'ReplicationConfiguration',
        'WebsiteConfiguration',
        'CorsConfiguration',
        'NotificationConfiguration',
      ]) {
        expect(props[key], key).toBeUndefined();
      }
    });

    it('outputs its name, without an export', () => {
      const outputs = template.toJSON() as { Outputs: Record<string, { Value: unknown; Export?: unknown }> };
      const hit = Object.values(outputs.Outputs).filter((o) => JSON.stringify(o.Value) === JSON.stringify({ Ref: bucketId }));
      expect(hit).toHaveLength(1);
      expect(hit[0]?.Export).toBeUndefined();
    });
  });

  it('archives backups after 30 days and expires them after a year', () => {
    const [, b] = bucket(template, stage, 'backups');
    expect(b.Properties.LifecycleConfiguration).toEqual({
      Rules: [
        {
          Id: 'archive-then-expire-exports',
          Status: 'Enabled',
          Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
          ExpirationInDays: 365,
        },
        {
          Id: 'expire-noncurrent-versions',
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        },
        { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
      ],
    });
  });

  it('expires verified label photos after 90 days and cleans up versions and uploads', () => {
    const [, b] = bucket(template, stage, 'photos');
    expect(b.Properties.LifecycleConfiguration).toEqual({
      Rules: [
        { Id: 'expire-verified-label-photos', Status: 'Enabled', Prefix: 'verified/', ExpirationInDays: 90 },
        {
          Id: 'expire-noncurrent-versions',
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
        { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
        {
          Id: 'expire-raw-uploads',
          Status: 'Enabled',
          Prefix: 'uploads/',
          ExpirationInDays: 1,
          NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        },
      ],
    });
    // Unverified photos (the review queue) never expire by lifecycle.
    const rules = (b.Properties.LifecycleConfiguration as { Rules: Record<string, unknown>[] }).Rules;
    expect(rules.filter((r) => r.ExpirationInDays !== undefined && r.Prefix === undefined)).toEqual([]);
  });

  it('expires raw label photo uploads after 1 day, and their noncurrent versions 1 day later (ADR 0016)', () => {
    const [, b] = bucket(template, stage, 'photos');
    const rules = (b.Properties.LifecycleConfiguration as { Rules: Record<string, unknown>[] }).Rules;
    expect(UPLOAD_PHOTO_PREFIX).toBe('uploads/');
    expect(rules.filter((r) => r.Prefix === UPLOAD_PHOTO_PREFIX)).toEqual([
      {
        Id: 'expire-raw-uploads',
        Status: 'Enabled',
        Prefix: 'uploads/',
        ExpirationInDays: 1,
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      },
    ]);
    // Only uploads/ and verified/ expire; stripped photos under labels/ and catalogue
    // images never do (the whole-bucket rule only removes noncurrent versions).
    expect(LABEL_PHOTO_PREFIX).toBe('labels/');
    expect(rules.filter((r) => r.ExpirationInDays !== undefined).map((r) => r.Prefix).sort()).toEqual(['uploads/', 'verified/']);
    // The whole-bucket noncurrent rule (30 days) also matches uploads/; S3 applies the
    // shorter of two matching expirations, so the upload rule's 1 day wins there.
    expect(rules.filter((r) => r.Prefix === undefined && r.NoncurrentVersionExpiration !== undefined)).toHaveLength(1);
  });

  it('has no CORS configuration on the photo bucket (the iOS app is not a browser, ADR 0016)', () => {
    const [, b] = bucket(template, stage, 'photos');
    expect(b.Properties.CorsConfiguration).toBeUndefined();
  });

  it('uses no Fn::ImportValue and no exports', () => {
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toContain('Fn::ImportValue');
    expect(text).not.toContain('"Export"');
  });
});
