// The stateful core of a stage (docs/05-system-design.md, Data model and Persistence
// and recovery): one DynamoDB table and three private S3 buckets. Every resource here is
// RETAIN: deleting the stack, or a change that would replace a resource, never deletes
// data. Deleting data is a human decision (CLAUDE.md, stop-and-ask rules).

import { Aws, CfnOutput, Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NAME_PREFIX } from './config.ts';
import type { StageName } from './config.ts';

/** Attribute names of the table. Generic, because one table holds every item type. */
export const TABLE_KEYS = {
  partitionKey: 'pk',
  sortKey: 'sk',
} as const;

/**
 * The sparse review-queue index. Only unverified bean items (`BEAN#<beanId>` / `META`
 * with status unverified) carry these attributes; verifying a bean removes them, so the
 * index holds exactly the review queue. See infra/README.md.
 */
export const REVIEW_QUEUE_INDEX = {
  indexName: 'gsi1',
  partitionKey: 'gsi1pk',
  sortKey: 'gsi1sk',
} as const;

/**
 * The TTL attribute (epoch seconds). Only short-lived items carry it: an Open Food
 * Facts miss in the catalogue cache (`BARCODE#<ean>` / `OFF`) and the per-user daily
 * lookup counter (`USER#<id>` / `LOOKUPS#<date>`). DynamoDB deletes them some time
 * after the time passes, at no charge; the deletes appear in the stream.
 */
export const TTL_ATTRIBUTE = 'expires_at';

/** Days after which a weekly export moves to S3 Glacier Flexible Retrieval. */
export const BACKUP_ARCHIVE_AFTER_DAYS = 30;
/** Days after which a weekly export is deleted. */
export const BACKUP_EXPIRE_AFTER_DAYS = 365;
/** Days a deleted or overwritten backup object is kept as a noncurrent version. */
export const BACKUP_NONCURRENT_DAYS = 30;

/**
 * docs/06-cost-estimate.md: "delete label photos 90 days after the bean is verified".
 * A lifecycle rule counts from the object's creation, so verification copies the photo
 * to this prefix (a new object, new creation date) and deletes the original.
 */
export const VERIFIED_PHOTO_PREFIX = 'verified/';
export const VERIFIED_PHOTO_EXPIRE_AFTER_DAYS = 90;
/** Days a deleted or overwritten photo is kept as a noncurrent version. */
export const PHOTO_NONCURRENT_DAYS = 30;

/**
 * ADR 0016: the app uploads a label photo with a presigned POST to
 * `uploads/<photoId>.jpg`. The raw upload still has its metadata; the API strips it and
 * writes the result to `labels/<photoId>.jpg`. The API never deletes the upload: a
 * lifecycle rule expires it after 1 day and its noncurrent version 1 day later.
 */
export const UPLOAD_PHOTO_PREFIX = 'uploads/';
export const UPLOAD_EXPIRE_AFTER_DAYS = 1;
export const UPLOAD_NONCURRENT_DAYS = 1;
/** Stripped label photos of unverified beans (ADR 0016); they never expire by lifecycle. */
export const LABEL_PHOTO_PREFIX = 'labels/';

/**
 * ADR 0017: the deletion log. One object per deleted account, `entries/<ulid>.json`,
 * holding ids only. Entries expire after 400 days, which outlives the 365-day exports
 * and the 35-day point-in-time recovery window, so the restore procedure (M5) can
 * re-delete every account deleted after a restore point.
 */
export const DELETION_LOG_PREFIX = 'entries/';
export const DELETION_LOG_EXPIRE_AFTER_DAYS = 400;
/** Days a deleted or overwritten log entry is kept as a noncurrent version. */
export const DELETION_LOG_NONCURRENT_DAYS = 30;

export interface CupmarkDataProps {
  readonly stage: StageName;
}

/** `cupmark-<stage>-<part>`, the name every resource of a stage must carry. */
function resourceName(stage: StageName, part: string): string {
  return `${NAME_PREFIX}${stage}-${part}`;
}

/**
 * Bucket names are global, so they carry the account id: `cupmark-<stage>-<part>-<account>`.
 * The literal prefix keeps the name inside CupmarkCfnExecution's `cupmark-*` resources.
 */
function bucketName(stage: StageName, part: string): string {
  return Fn.join('', [`${resourceName(stage, part)}-`, Aws.ACCOUNT_ID]);
}

/** Properties every bucket shares: private, versioned, TLS only, S3-managed keys, RETAIN. */
function privateBucketProps(): s3.BucketProps {
  return {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    minimumTLSVersion: 1.2,
    versioned: true,
    removalPolicy: RemovalPolicy.RETAIN,
  };
}

export class CupmarkData extends Construct {
  public readonly table: dynamodb.Table;
  public readonly photoBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly deletionLogBucket: s3.Bucket;

  public constructor(scope: Construct, id: string, props: CupmarkDataProps) {
    super(scope, id);
    const { stage } = props;

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: resourceName(stage, 'main'),
      partitionKey: { name: TABLE_KEYS.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE_KEYS.sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // AWS-owned key: encrypted at rest, no KMS key and no KMS charges (invariant 5).
      encryption: dynamodb.TableEncryption.DEFAULT,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 35 },
      deletionProtection: true,
      // The aggregator applies the difference between old and new brew (docs/05).
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      tableClass: dynamodb.TableClass.STANDARD,
      removalPolicy: RemovalPolicy.RETAIN,
      timeToLiveAttribute: TTL_ATTRIBUTE,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: REVIEW_QUEUE_INDEX.indexName,
      partitionKey: { name: REVIEW_QUEUE_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: REVIEW_QUEUE_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // What lives here, by prefix (no CORS: the iOS app is not a browser):
    // - `uploads/`: raw label photo uploads (presigned POST, ADR 0016), metadata not yet
    //   stripped. Read only by the API's completion call; expire after 1 day, and their
    //   noncurrent version 1 day after that.
    // - `labels/`: stripped label photos of unverified beans (docs/04 F1, ADR 0016),
    //   read only by the operator's review tooling, never shown to other users. Never
    //   expire by lifecycle while the bean is in review.
    // - `verified/`: photos of verified beans, expired 90 days after the copy.
    // - `catalogue/`: the catalogue's copies of Open Food Facts images (ADR 0011), which
    //   never expire.
    // The whole-bucket `expire-noncurrent-versions` rule (30 days) also matches
    // `uploads/`; where two rules expire the same object S3 applies the shorter period,
    // so noncurrent versions under `uploads/` go after 1 day.
    this.photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      ...privateBucketProps(),
      bucketName: bucketName(stage, 'photos'),
      lifecycleRules: [
        {
          id: 'expire-verified-label-photos',
          prefix: VERIFIED_PHOTO_PREFIX,
          expiration: Duration.days(VERIFIED_PHOTO_EXPIRE_AFTER_DAYS),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(PHOTO_NONCURRENT_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
        {
          id: 'expire-raw-uploads',
          prefix: UPLOAD_PHOTO_PREFIX,
          expiration: Duration.days(UPLOAD_EXPIRE_AFTER_DAYS),
          noncurrentVersionExpiration: Duration.days(UPLOAD_NONCURRENT_DAYS),
        },
      ],
    });

    // Weekly full table export (docs/05, Persistence and recovery): archive after 30
    // days, keep for a year.
    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      ...privateBucketProps(),
      bucketName: bucketName(stage, 'backups'),
      lifecycleRules: [
        {
          id: 'archive-then-expire-exports',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(BACKUP_ARCHIVE_AFTER_DAYS) },
          ],
          expiration: Duration.days(BACKUP_EXPIRE_AFTER_DAYS),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(BACKUP_NONCURRENT_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
      ],
    });

    // The deletion log (ADR 0017). Outside the table, so restoring the table from
    // point-in-time recovery or an export cannot lose entries written after the
    // restore point. The API may only put entries; the operator's restore procedure
    // reads them.
    this.deletionLogBucket = new s3.Bucket(this, 'DeletionLogBucket', {
      ...privateBucketProps(),
      bucketName: bucketName(stage, 'deletion-log'),
      lifecycleRules: [
        {
          id: 'expire-entries',
          prefix: DELETION_LOG_PREFIX,
          expiration: Duration.days(DELETION_LOG_EXPIRE_AFTER_DAYS),
        },
        { id: 'expire-noncurrent-versions', noncurrentVersionExpiration: Duration.days(DELETION_LOG_NONCURRENT_DAYS) },
        { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
      ],
    });

    // Outputs of this stack only; no exports, nothing is imported elsewhere.
    const streamArn = this.table.tableStreamArn;
    if (streamArn === undefined) throw new Error('the table must have a stream');
    new CfnOutput(this, 'TableName', { value: this.table.tableName, description: 'DynamoDB table' });
    new CfnOutput(this, 'TableStreamArn', {
      value: streamArn,
      description: 'DynamoDB stream (NEW_AND_OLD_IMAGES) for the aggregator',
    });
    new CfnOutput(this, 'PhotoBucketName', { value: this.photoBucket.bucketName, description: 'Label photo bucket' });
    new CfnOutput(this, 'BackupBucketName', { value: this.backupBucket.bucketName, description: 'Weekly export bucket' });
    new CfnOutput(this, 'DeletionLogBucketName', {
      value: this.deletionLogBucket.bucketName,
      description: 'Account deletion log bucket (ADR 0017)',
    });
  }
}
