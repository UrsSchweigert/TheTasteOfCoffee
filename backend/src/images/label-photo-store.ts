// Label photos in the photo bucket (task M1-T4d; ADR 0016; D10, D12). The only
// code that signs uploads, reads uploads or writes stripped label photos.
//
// - Keys are built here from a validated ULID only, never from request input:
//   `uploads/<photoId>.jpg` for the raw upload the app POSTs straight to S3,
//   `labels/<photoId>.jpg` for the stripped copy the operator's tooling reads.
//   No user id in any key (S3 keys show up in logs and tooling).
// - infra grants the API function s3:PutObject on `uploads/*` (needed to sign
//   the POST), s3:GetObject on `uploads/*` and s3:PutObject on `labels/*`.
//   Nothing here deletes: a lifecycle rule expires `uploads/` after 1 day, and
//   account deletion (M1-T6) deletes through photo-deletion-store.ts.
// - The presigned POST (@aws-sdk/s3-presigned-post) has the exact key, the
//   field `Content-Type: image/jpeg`, and a policy with: the exact key,
//   `content-length-range` 1 to MAX_LABEL_PHOTO_BYTES, `Content-Type` equal
//   to `image/jpeg`, the bucket, and an expiry of UPLOAD_EXPIRES_SECONDS.
// - Errors carry no bucket, key or id; the caller logs class names only.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { PresignedPost, PresignedPostOptions } from '@aws-sdk/s3-presigned-post';
import { IdSchema } from '../generated/contract.ts';
import { isOwnBucketName } from './catalogue-store.ts';
import { MAX_LABEL_PHOTO_BYTES } from './limits.ts';

export { MAX_LABEL_PHOTO_BYTES };

/** Prefix of raw uploads; equal to infra's lifecycle rule and grants. */
export const UPLOAD_PREFIX = 'uploads/';
/** Prefix of stripped label photos. */
export const LABEL_PREFIX = 'labels/';
/** How long a presigned POST works: 10 minutes (ADR 0016; the contract's `expires_at`). */
export const UPLOAD_EXPIRES_SECONDS = 600;
/** The only content type a label photo upload may have. */
export const LABEL_PHOTO_CONTENT_TYPE = 'image/jpeg';

/** Deadline of reading one upload of up to 8 MiB within the region. */
export const DEFAULT_UPLOAD_READ_TIMEOUT_MS = 4000;
/** Deadline of writing one stripped label photo. */
export const DEFAULT_LABEL_WRITE_TIMEOUT_MS = 3000;

export class InvalidPhotoIdError extends Error {
  public override readonly name = 'InvalidPhotoIdError';
}

function validPhotoId(photoId: string): string {
  if (!IdSchema.safeParse(photoId).success) throw new InvalidPhotoIdError('invalid photo id');
  return photoId;
}

/** `uploads/<photoId>.jpg`; throws InvalidPhotoIdError unless the id is a contract `Id` (a ULID). */
export function uploadKey(photoId: string): string {
  return `${UPLOAD_PREFIX}${validPhotoId(photoId)}.jpg`;
}

/** `labels/<photoId>.jpg`; throws InvalidPhotoIdError unless the id is a contract `Id` (a ULID). */
export function labelKey(photoId: string): string {
  return `${LABEL_PREFIX}${validPhotoId(photoId)}.jpg`;
}

export type UploadRead =
  | { readonly kind: 'found'; readonly bytes: Uint8Array }
  /** No such object. S3 answers AccessDenied instead of NoSuchKey to a role without s3:ListBucket. */
  | { readonly kind: 'missing'; readonly reason: 'NoSuchKey' | 'AccessDenied' }
  /** Over MAX_LABEL_PHOTO_BYTES, or of unknown size; the body was not read (or not kept). */
  | { readonly kind: 'too_large' };

/** What createPresignedPost returns: the form's URL and its fields under their S3 names. */
export type PresignedUpload = PresignedPost;

export interface LabelPhotoStore {
  /** The bucket name, for checking the presigned POST against it. */
  readonly bucket: string;
  /** A presigned POST for `uploads/<photoId>.jpg`. Throws on any failure (credentials, region). */
  presignUpload(photoId: string): Promise<PresignedUpload>;
  /** Reads `uploads/<photoId>.jpg`. Throws on S3 errors other than a missing object. */
  getUpload(photoId: string): Promise<UploadRead>;
  /** Writes the stripped bytes to `labels/<photoId>.jpg`. Throws on any failure. */
  putLabel(photoId: string, jpeg: Uint8Array): Promise<void>;
}

export type Presigner = (client: S3Client, options: PresignedPostOptions) => Promise<PresignedPost>;

export interface S3LabelPhotoStoreOptions {
  /** createPresignedPost, replaceable in tests. */
  readonly presign?: Presigner;
  readonly readTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly maxBytes?: number;
}

/** The POST options for one photo: what the policy allows, nothing taken from a request. */
export function presignedPostOptions(bucket: string, photoId: string, maxBytes = MAX_LABEL_PHOTO_BYTES): PresignedPostOptions {
  const key = uploadKey(photoId);
  return {
    Bucket: bucket,
    Key: key,
    Fields: { 'Content-Type': LABEL_PHOTO_CONTENT_TYPE },
    Conditions: [
      ['eq', '$key', key],
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', LABEL_PHOTO_CONTENT_TYPE],
      ['eq', '$bucket', bucket],
    ],
    Expires: UPLOAD_EXPIRES_SECONDS,
  };
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** Releases a body that is not read. */
function discard(body: unknown): void {
  if (typeof body === 'object' && body !== null && 'destroy' in body && typeof body.destroy === 'function') {
    (body as { destroy: () => void }).destroy();
  }
}

/** The store for `bucket`, or undefined if the name is missing or not one of this project's buckets. */
export function s3LabelPhotoStore(
  client: S3Client,
  bucket: string | undefined,
  options: S3LabelPhotoStoreOptions = {},
): LabelPhotoStore | undefined {
  if (!isOwnBucketName(bucket)) return undefined;
  const presign = options.presign ?? createPresignedPost;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_UPLOAD_READ_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_LABEL_WRITE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_LABEL_PHOTO_BYTES;

  return {
    bucket,

    async presignUpload(photoId) {
      const presigned = await presign(client, presignedPostOptions(bucket, photoId, maxBytes));
      return presigned;
    },

    async getUpload(photoId) {
      const key = uploadKey(photoId);
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(readTimeoutMs) });
      } catch (error) {
        const name = errorName(error);
        if (name === 'NoSuchKey' || name === 'NotFound') return { kind: 'missing', reason: 'NoSuchKey' };
        if (name === 'AccessDenied') return { kind: 'missing', reason: 'AccessDenied' };
        throw error;
      }
      const length = response.ContentLength;
      if (response.Body === undefined || length === undefined || length > maxBytes) {
        discard(response.Body);
        return { kind: 'too_large' };
      }
      const bytes = await response.Body.transformToByteArray();
      if (bytes.byteLength > maxBytes) return { kind: 'too_large' };
      return { kind: 'found', bytes };
    },

    async putLabel(photoId, jpeg) {
      const key = labelKey(photoId);
      // No user metadata, no tags: the object is the stripped bytes and its type.
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: jpeg, ContentType: LABEL_PHOTO_CONTENT_TYPE, ContentLength: jpeg.byteLength }),
        { abortSignal: AbortSignal.timeout(writeTimeoutMs) },
      );
    },
  };
}
