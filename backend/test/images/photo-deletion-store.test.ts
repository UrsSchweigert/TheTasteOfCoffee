// The S3 side of account deletion (M1-T6, D10): every version and delete
// marker of exactly `labels/<id>.jpg` or `uploads/<id>.jpg` is deleted by
// VersionId, across pages; a longer key that shares the prefix is never
// touched; a repeat deletes nothing.
import { describe, expect, it } from 'vitest';
import { DEFAULT_DELETE_TIMEOUT_MS, MAX_VERSION_PAGES, TooManyVersionsError, s3PhotoDeletionStore } from '../../src/images/photo-deletion-store.ts';
import type { PhotoDeletionStore } from '../../src/images/photo-deletion-store.ts';
import { InvalidPhotoIdError } from '../../src/images/label-photo-store.ts';
import { VersionedBucket, awsError } from '../s3-fakes.ts';

const BUCKET = 'cupmark-dev-photos-000000000000';
const PHOTO = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
const OTHER = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DG';

function store(bucket: VersionedBucket): PhotoDeletionStore {
  const created = s3PhotoDeletionStore(bucket.client, BUCKET);
  if (created === undefined) throw new Error('no store');
  return created;
}

describe('s3PhotoDeletionStore', () => {
  it('exists only for a cupmark- bucket name', () => {
    const bucket = new VersionedBucket(BUCKET);
    for (const name of [undefined, '', 'photos', 'other-project-photos', 'cupmark-', 'cupmark--x', 'Cupmark-dev']) {
      expect(s3PhotoDeletionStore(bucket.client, name)).toBeUndefined();
    }
    expect(s3PhotoDeletionStore(bucket.client, BUCKET)).toBeDefined();
    expect(DEFAULT_DELETE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it('deletes every version and delete marker of the exact key, by VersionId, and nothing else', async () => {
    const bucket = new VersionedBucket(BUCKET);
    const key = `labels/${PHOTO}.jpg`;
    bucket.put(key, 'first');
    bucket.put(key, '', true);
    bucket.put(key, 'second');
    // Keys that share the prefix, or are the same photo elsewhere, or another photo.
    for (const other of [`labels/${PHOTO}.jpg.tmp`, `labels/${PHOTO}.jpgx`, `uploads/${PHOTO}.jpg`, `labels/${OTHER}.jpg`, `catalogue/${PHOTO}.jpg`]) {
      bucket.put(other);
    }
    expect(await store(bucket).deleteLabel(PHOTO)).toBe(3);
    expect(bucket.objects.get(key)).toEqual([]);
    expect(bucket.keys()).toEqual(
      [`catalogue/${PHOTO}.jpg`, `labels/${OTHER}.jpg`, `labels/${PHOTO}.jpg.tmp`, `labels/${PHOTO}.jpgx`, `uploads/${PHOTO}.jpg`].sort(),
    );
    const deletes = bucket.sent.filter((command) => command.name === 'DeleteObject');
    expect(deletes).toHaveLength(3);
    for (const command of deletes) {
      expect(command.input.Key).toBe(key);
      expect(command.input.Bucket).toBe(BUCKET);
      expect(typeof command.input.VersionId).toBe('string');
    }
    const lists = bucket.sent.filter((command) => command.name === 'ListObjectVersions');
    expect(lists.every((command) => command.input.Prefix === key)).toBe(true);
  });

  it('deleteUpload works the same on uploads/<id>.jpg', async () => {
    const bucket = new VersionedBucket(BUCKET);
    bucket.put(`uploads/${PHOTO}.jpg`);
    bucket.put(`labels/${PHOTO}.jpg`);
    expect(await store(bucket).deleteUpload(PHOTO)).toBe(1);
    expect(bucket.keys()).toEqual([`labels/${PHOTO}.jpg`]);
  });

  it('follows every page of the version list before deleting', async () => {
    const bucket = new VersionedBucket(BUCKET, 2);
    const key = `uploads/${PHOTO}.jpg`;
    // Longer keys sort after the exact key, so the exact key's versions span pages with them.
    for (let i = 0; i < 5; i += 1) bucket.put(key, `v${String(i)}`, i === 2);
    for (let i = 0; i < 3; i += 1) bucket.put(`${key}.old`);
    expect(await store(bucket).deleteUpload(PHOTO)).toBe(5);
    expect(bucket.objects.get(key)).toEqual([]);
    expect(bucket.objects.get(`${key}.old`)).toHaveLength(3);
    const names = bucket.sent.map((command) => command.name);
    expect(names.filter((name) => name === 'ListObjectVersions')).toHaveLength(4);
    // Listed in full first, then deleted.
    expect(names.indexOf('DeleteObject')).toBeGreaterThan(names.lastIndexOf('ListObjectVersions'));
  });

  it('is idempotent: a key without versions lists once and deletes nothing', async () => {
    const bucket = new VersionedBucket(BUCKET);
    bucket.put(`labels/${PHOTO}.jpg`);
    const photos = store(bucket);
    expect(await photos.deleteLabel(PHOTO)).toBe(1);
    bucket.sent.length = 0;
    expect(await photos.deleteLabel(PHOTO)).toBe(0);
    expect(bucket.sent.map((command) => command.name)).toEqual(['ListObjectVersions']);
  });

  it('refuses a photo id that is not a ULID before S3 is asked', async () => {
    const bucket = new VersionedBucket(BUCKET);
    for (const bad of ['', '../x', `${PHOTO}/x`, PHOTO.toLowerCase(), `${PHOTO}*`]) {
      await expect(store(bucket).deleteLabel(bad)).rejects.toThrow(InvalidPhotoIdError);
      await expect(store(bucket).deleteUpload(bad)).rejects.toThrow(InvalidPhotoIdError);
    }
    expect(bucket.sent).toEqual([]);
  });

  it('passes S3 errors on, so the deletion answers 500 and is retried', async () => {
    const bucket = new VersionedBucket(BUCKET);
    bucket.put(`labels/${PHOTO}.jpg`);
    bucket.failWith = (command) => (command.name === 'DeleteObject' ? awsError('AccessDenied') : undefined);
    await expect(store(bucket).deleteLabel(PHOTO)).rejects.toThrow('the service said no');
    bucket.failWith = undefined;
    expect(await store(bucket).deleteLabel(PHOTO)).toBe(1);
  });

  it('gives up on a list that never ends', async () => {
    const endless = {
      send: () => Promise.resolve({ Versions: [], IsTruncated: true, NextKeyMarker: 'k', NextVersionIdMarker: 'v' }),
    };
    const photos = s3PhotoDeletionStore(endless as never, BUCKET);
    await expect(photos?.deleteLabel(PHOTO)).rejects.toThrow(TooManyVersionsError);
    expect(MAX_VERSION_PAGES).toBeGreaterThan(1);
  });
});
