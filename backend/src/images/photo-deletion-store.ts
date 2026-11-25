// Deletes label photo objects in the photo bucket for account deletion (task
// M1-T6; ADR 0017; D10). The only code that deletes in S3.
//
// - Keys come from labelKey and uploadKey (label-photo-store.ts), built from a
//   validated ULID only: `labels/<photoId>.jpg` and `uploads/<photoId>.jpg`.
//   No other key can be named.
// - The bucket is versioned, so a plain DeleteObject would only add a delete
//   marker and keep the photo as a noncurrent version for 30 days. Instead
//   every version and every delete marker of the key is deleted by its
//   VersionId (D10): ListObjectVersions with the exact key as Prefix (all
//   pages), then DeleteObject with each VersionId. A prefix also matches a
//   longer key (`labels/<id>.jpg.tmp`), so every returned Key is compared with
//   the exact key and anything else is skipped, never deleted.
// - Idempotent: a key with no versions left lists nothing and deletes nothing.
// - infra grants the API function s3:ListBucketVersions on the bucket with an
//   `s3:prefix` condition of `labels/*` or `uploads/*`, and s3:DeleteObject and
//   s3:DeleteObjectVersion on `labels/*` and `uploads/*`.
// - Errors carry no bucket, key or id; the caller logs class names only.
import { DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { isOwnBucketName } from './catalogue-store.ts';
import { labelKey, uploadKey } from './label-photo-store.ts';

/** Deadline of one S3 call. */
export const DEFAULT_DELETE_TIMEOUT_MS = 2000;
/** Pages of ListObjectVersions for one key before giving up; a photo key has a handful of versions. */
export const MAX_VERSION_PAGES = 20;

export class TooManyVersionsError extends Error {
  public override readonly name = 'TooManyVersionsError';
}

export class IncompleteVersionListError extends Error {
  public override readonly name = 'IncompleteVersionListError';
}

export interface PhotoDeletionStore {
  /** Deletes every version and delete marker of `labels/<photoId>.jpg`. Returns how many were deleted. */
  deleteLabel(photoId: string): Promise<number>;
  /** Deletes every version and delete marker of `uploads/<photoId>.jpg`. Returns how many were deleted. */
  deleteUpload(photoId: string): Promise<number>;
}

export interface S3PhotoDeletionStoreOptions {
  readonly timeoutMs?: number;
}

/** The store for `bucket`, or undefined if the name is missing or not one of this project's buckets. */
export function s3PhotoDeletionStore(
  client: Pick<S3Client, 'send'>,
  bucket: string | undefined,
  options: S3PhotoDeletionStoreOptions = {},
): PhotoDeletionStore | undefined {
  if (!isOwnBucketName(bucket)) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
  const signal = (): { abortSignal: AbortSignal } => ({ abortSignal: AbortSignal.timeout(timeoutMs) });

  /** Every VersionId under exactly `key` (versions and delete markers), all pages. */
  const versionsOf = async (key: string): Promise<string[]> => {
    const versionIds: string[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_VERSION_PAGES) throw new TooManyVersionsError('too many versions to list');
      const result = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }),
        signal(),
      );
      for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
        // The exact key only: a prefix match on a longer key is another object.
        if (entry.Key === key && typeof entry.VersionId === 'string' && entry.VersionId !== '') versionIds.push(entry.VersionId);
      }
      if (result.IsTruncated !== true) return versionIds;
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
      // A truncated list without a marker cannot be continued; returning would leave versions behind.
      if (keyMarker === undefined) throw new IncompleteVersionListError('a truncated version list has no next marker');
    }
  };

  const deleteAll = async (key: string): Promise<number> => {
    // Listed in full first, then deleted, so the deletes cannot move the list's markers.
    const versionIds = await versionsOf(key);
    for (const versionId of versionIds) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), signal());
    }
    return versionIds.length;
  };

  return {
    deleteLabel: async (photoId) => deleteAll(labelKey(photoId)),
    deleteUpload: async (photoId) => deleteAll(uploadKey(photoId)),
  };
}
