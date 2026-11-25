// The deletion log (task M1-T6; ADR 0017, point 4; D11). One object per
// account deletion, `entries/<ulid>.json` in the bucket DELETION_LOG_BUCKET
// (`cupmark-<stage>-deletion-log-<account>`), holding ids only:
// `{ "sub", "photo_ids", "deleted_at" }`. Every restore from point-in-time
// recovery or a weekly export re-applies these entries before the restored
// data is used (M5 restore drill).
//
// - The bucket lives outside the table, so a table restore cannot lose it.
// - The API role may only s3:PutObject on `entries/*`; it never reads the log.
// - The key is a fresh ULID, never derived from the user, so a key in a log
//   or in tooling does not identify anyone.
// - Errors carry no bucket, key or id; the caller logs class names only.
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { IdSchema } from '../generated/contract.ts';
import { isOwnBucketName } from '../images/catalogue-store.ts';
import { newUlid } from '../ids/ulid.ts';

/** Prefix of every entry; equal to infra's grant on the deletion log bucket. */
export const DELETION_LOG_PREFIX = 'entries/';
/** Deadline of the one S3 write. */
export const DEFAULT_LOG_WRITE_TIMEOUT_MS = 2000;

/** Cognito `sub`: a lower-case UUID (src/auth/user-id.ts). */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXED_WIDTH_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class InvalidDeletionLogEntryError extends Error {
  public override readonly name = 'InvalidDeletionLogEntryError';
}

/** One entry, exactly as stored. */
export interface DeletionLogEntry {
  readonly sub: string;
  readonly photo_ids: readonly string[];
  readonly deleted_at: string;
}

export interface DeletionLogStore {
  /** Writes one entry under a new `entries/<ulid>.json`. Throws on any failure. */
  append(entry: DeletionLogEntry): Promise<void>;
}

export interface S3DeletionLogStoreOptions {
  readonly timeoutMs?: number;
  /** Id of the next entry, for tests. Must be a ULID. */
  readonly newId?: () => string;
}

/** `entries/<ulid>.json`; throws unless the id is a contract `Id` (a ULID). */
export function deletionLogKey(entryId: string): string {
  if (!IdSchema.safeParse(entryId).success) throw new InvalidDeletionLogEntryError('invalid entry id');
  return `${DELETION_LOG_PREFIX}${entryId}.json`;
}

/** The entry's JSON, after checking that it holds ids and a timestamp only. */
export function deletionLogBody(entry: DeletionLogEntry): string {
  if (!SUB.test(entry.sub) || !FIXED_WIDTH_UTC.test(entry.deleted_at) || !entry.photo_ids.every((id) => IdSchema.safeParse(id).success)) {
    throw new InvalidDeletionLogEntryError('a deletion log entry holds ids and a timestamp only');
  }
  return JSON.stringify({ sub: entry.sub, photo_ids: [...entry.photo_ids], deleted_at: entry.deleted_at });
}

/** The store for `bucket`, or undefined if the name is missing or not one of this project's buckets. */
export function s3DeletionLogStore(
  client: Pick<S3Client, 'send'>,
  bucket: string | undefined,
  options: S3DeletionLogStoreOptions = {},
): DeletionLogStore | undefined {
  if (!isOwnBucketName(bucket)) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOG_WRITE_TIMEOUT_MS;
  const newId = options.newId ?? (() => newUlid());
  return {
    async append(entry) {
      const body = deletionLogBody(entry);
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: deletionLogKey(newId()), Body: body, ContentType: 'application/json' }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
    },
  };
}
