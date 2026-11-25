// DELETE /account (task M1-T6; ADR 0017 and its Addendum; D2, D10, D11;
// contracts/openapi.yaml, deleteAccount). Runs in the request, in this order:
//
// 0. Configuration and the caller's Cognito username: no usable PHOTO_BUCKET
//    (`PhotoBucketNotConfigured`), DELETION_LOG_BUCKET
//    (`DeletionLogNotConfigured`) or USER_POOL_ID (`UserPoolNotConfigured`),
//    or no valid `username` claim in the token (`UsernameMissing`), is 500
//    before anything is changed.
// 1. The tombstone `DELETED#<sub>` / `META` (Repository.markAccountDeleted):
//    from here on every write of the caller answers 401, so nothing can be
//    added to the partition while it is emptied, or after.
// 2. Label photos (D10). For each completed photo (`PHOTO#`): if its bean is
//    not verified (unverified, rejected or missing), the photo is deleted in
//    full: its id is first recorded on the tombstone, then every version and
//    delete marker of `labels/<id>.jpg` and `uploads/<id>.jpg` is deleted,
//    then the bean's `PHOTO#` item. A photo already recorded on the tombstone
//    by an earlier attempt is deleted in full whatever its bean's status now,
//    so a retry finishes what the first attempt began. For a verified bean
//    the stored photo and the bean's item stay (shared catalogue) and only
//    the raw upload `uploads/<id>.jpg`, which still has its metadata, is
//    deleted; the user-side item goes with the partition, which drops the
//    only link to the caller. For each pending upload (`PHOTO_PENDING#`)
//    every version of both keys is deleted too (a `labels/` copy exists if a
//    completion wrote it and then failed), and the id is recorded.
// 3. Every item of `USER#<sub>` (Repository.deleteUserPartition): profile,
//    shelf entries, brews and pointers, recipes, label photo items, pending
//    uploads, counters. The aggregator (M3) subtracts each deleted brew from
//    the stream's old image (D2).
// 4. The deletion log entry `{sub, photo_ids, deleted_at}` (ids only;
//    photo_ids are the ids recorded on the tombstone, deleted_at is when the
//    deletion began), unless this tombstone was logged already; then the
//    tombstone is marked as logged.
// 5. The Cognito user (AdminDeleteUser; a missing user is success).
//
// 204 only when every step succeeded. Any failure is 500 with the error class
// name, and the retry runs all steps again; each is idempotent, so a retry
// after a 204 (tombstone present, partition empty, user gone) is 204 too.
//
// Nothing here logs. The router logs operation, status, request id and a
// fixed error code; never the sub, the username, a photo or bean id, a key,
// a bucket, a pool id or a count.
import type { CognitoUsername, UserId } from '../auth/user-id.ts';
import type { DeletionLogStore } from '../account/deletion-log.ts';
import type { UserDirectory } from '../account/user-pool.ts';
import type { PhotoDeletionStore } from '../images/photo-deletion-store.ts';
import type { BeanStatus, LabelPhoto, Repository } from '../repository/index.ts';
import type { ApiResult } from './http.ts';
import { empty } from './http.ts';

/** S3 deletions run at most this many photos at a time, to stay well inside the 10 s timeout. */
export const PHOTO_DELETION_CONCURRENCY = 8;

/** The part of the repository account deletion uses. */
export type AccountDeletionRepository = Pick<
  Repository,
  | 'markAccountDeleted'
  | 'accountPhotos'
  | 'getBean'
  | 'recordDeletedPhotos'
  | 'deleteBeanLabelPhoto'
  | 'deleteUserPartition'
  | 'markDeletionLogged'
>;

/** What DELETE /account needs besides the table. Each part is absent without its configuration. */
export interface AccountDeletionConfig {
  readonly photos?: PhotoDeletionStore;
  readonly deletionLog?: DeletionLogStore;
  readonly users?: UserDirectory;
}

export interface AccountDeletionOutcome {
  readonly result: ApiResult;
  /** A fixed code: an error class name or one of the configuration codes above. */
  readonly error?: string;
}

function failure(error: string): AccountDeletionOutcome {
  return { result: empty(500), error };
}

/** Runs `task` for every item, at most `limit` at a time; the first failure rejects. */
async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function deleteAccount(
  store: AccountDeletionRepository,
  config: AccountDeletionConfig | undefined,
  user: UserId,
  username: CognitoUsername | undefined,
): Promise<AccountDeletionOutcome> {
  const photos = config?.photos;
  const deletionLog = config?.deletionLog;
  const users = config?.users;
  if (photos === undefined) return failure('PhotoBucketNotConfigured');
  if (deletionLog === undefined) return failure('DeletionLogNotConfigured');
  if (users === undefined) return failure('UserPoolNotConfigured');
  if (username === undefined) return failure('UsernameMissing');

  // 1. The tombstone.
  const tombstone = await store.markAccountDeleted(user);

  // 2. Label photos.
  const { photos: completed, pendingPhotoIds } = await store.accountPhotos(user);
  const recorded = new Set(tombstone.photoIds);
  const statuses = new Map<string, BeanStatus | undefined>();
  const full: LabelPhoto[] = [];
  const linkOnly: LabelPhoto[] = [];
  for (const photo of completed) {
    if (!recorded.has(photo.photoId)) {
      if (!statuses.has(photo.beanId)) statuses.set(photo.beanId, (await store.getBean(photo.beanId))?.status);
      if (statuses.get(photo.beanId) === 'verified') {
        linkOnly.push(photo);
        continue;
      }
    }
    full.push(photo);
  }
  const newlyRecorded = [...full.map((photo) => photo.photoId), ...pendingPhotoIds].filter((photoId) => !recorded.has(photoId));
  // Recorded before any of it is deleted, so a retry still knows these ids for the log.
  await store.recordDeletedPhotos(user, newlyRecorded);
  await forEachLimited(full, PHOTO_DELETION_CONCURRENCY, async ({ photoId, beanId }) => {
    await photos.deleteLabel(photoId);
    await photos.deleteUpload(photoId);
    await store.deleteBeanLabelPhoto(beanId, photoId);
  });
  await forEachLimited(linkOnly, PHOTO_DELETION_CONCURRENCY, async ({ photoId }) => {
    await photos.deleteUpload(photoId);
  });
  await forEachLimited(pendingPhotoIds, PHOTO_DELETION_CONCURRENCY, async (photoId) => {
    await photos.deleteLabel(photoId);
    await photos.deleteUpload(photoId);
  });

  // 3. The partition.
  await store.deleteUserPartition(user);

  // 4. The deletion log.
  if (!tombstone.logged) {
    const photoIds = [...new Set([...recorded, ...newlyRecorded])].sort();
    await deletionLog.append({ sub: user.value, photo_ids: photoIds, deleted_at: tombstone.deletedAt });
    await store.markDeletionLogged(user);
  }

  // 5. The Cognito user.
  await users.deleteUser(username);
  return { result: empty(204) };
}
