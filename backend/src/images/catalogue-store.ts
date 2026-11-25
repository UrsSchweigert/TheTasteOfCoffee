// The catalogue's copies of Open Food Facts images in the photo bucket
// (task M1-T4c; ADR 0011; docs/05-system-design.md, Barcode lookup). The only
// code that reads or writes S3.
//
// - Key `catalogue/<imageId>.jpg`, built here from a validated ULID only.
//   infra grants the API function s3:GetObject and s3:PutObject on
//   `catalogue/*` and nothing else in the bucket.
// - The bucket name comes from `PHOTO_BUCKET` and must be one this project
//   owns (`cupmark-` prefix, CLAUDE.md invariant 9). Without it there is no
//   store: lookups cache hits without an image, and GET /catalogue_images
//   answers 404.
// - Objects are written once under a fresh ULID and never overwritten or
//   deleted by the API. A read refuses anything over MAX_CATALOGUE_IMAGE_BYTES,
//   so the base64 response stays far below the 6 MB Lambda limit.
// - Errors carry no bucket, key or id; the caller logs class names only.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { IdSchema } from '../generated/contract.ts';
import { MAX_CATALOGUE_IMAGE_BYTES } from './limits.ts';

export { MAX_CATALOGUE_IMAGE_BYTES };

/** Prefix of every catalogue image key; equal to infra's CATALOGUE_IMAGE_PREFIX. */
export const CATALOGUE_IMAGE_PREFIX = 'catalogue/';

/** Deadline of one S3 call. The lookup's put shares the API function's 10 s with two Open Food Facts calls. */
export const DEFAULT_S3_TIMEOUT_MS = 2000;

/** A bucket this project owns: `cupmark-` and a valid bucket name. */
const OWN_BUCKET = /^cupmark-[a-z0-9][a-z0-9-]{0,53}[a-z0-9]$/;

export class InvalidImageIdError extends Error {
  public override readonly name = 'InvalidImageIdError';
}

export class CatalogueImageTooLargeError extends Error {
  public override readonly name = 'CatalogueImageTooLargeError';
}

/** `catalogue/<imageId>.jpg`; throws InvalidImageIdError unless the id is a contract `Id` (a ULID). */
export function catalogueImageKey(imageId: string): string {
  if (!IdSchema.safeParse(imageId).success) throw new InvalidImageIdError('invalid image id');
  return `${CATALOGUE_IMAGE_PREFIX}${imageId}.jpg`;
}

export function isOwnBucketName(name: string | undefined): name is string {
  return name !== undefined && OWN_BUCKET.test(name) && !name.includes('--');
}

export type CatalogueImageRead =
  | { readonly kind: 'found'; readonly bytes: Uint8Array }
  /** No such object. S3 answers AccessDenied instead of NoSuchKey to a role without s3:ListBucket. */
  | { readonly kind: 'missing'; readonly reason: 'NoSuchKey' | 'AccessDenied' };

export interface CatalogueImageStore {
  /** Writes a stripped JPEG under a new id. Throws on any failure. */
  put(imageId: string, jpeg: Uint8Array): Promise<void>;
  /** Reads a stored image. Throws CatalogueImageTooLargeError over the limit, and on other S3 errors. */
  get(imageId: string): Promise<CatalogueImageRead>;
}

export interface S3CatalogueImageStoreOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
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
export function s3CatalogueImageStore(
  client: Pick<S3Client, 'send'>,
  bucket: string | undefined,
  options: S3CatalogueImageStoreOptions = {},
): CatalogueImageStore | undefined {
  if (!isOwnBucketName(bucket)) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_S3_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_CATALOGUE_IMAGE_BYTES;

  return {
    async put(imageId, jpeg) {
      const key = catalogueImageKey(imageId);
      if (jpeg.byteLength > maxBytes) throw new CatalogueImageTooLargeError('image over the limit');
      // No user metadata, no tags: the object is the stripped bytes and its type.
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: jpeg, ContentType: 'image/jpeg', ContentLength: jpeg.byteLength }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
    },

    async get(imageId) {
      const key = catalogueImageKey(imageId);
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const name = errorName(error);
        if (name === 'NoSuchKey' || name === 'NotFound') return { kind: 'missing', reason: 'NoSuchKey' };
        if (name === 'AccessDenied') return { kind: 'missing', reason: 'AccessDenied' };
        throw error;
      }
      const length = response.ContentLength;
      if (response.Body === undefined || length === undefined || length > maxBytes) {
        discard(response.Body);
        throw new CatalogueImageTooLargeError('stored image over the limit or of unknown size');
      }
      const bytes = await response.Body.transformToByteArray();
      if (bytes.byteLength > maxBytes) throw new CatalogueImageTooLargeError('stored image over the limit');
      return { kind: 'found', bytes };
    },
  };
}
