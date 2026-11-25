// The deletion log (ADR 0017, point 4) and the Cognito user deletion (the last
// step of DELETE /account), with stubbed clients; nothing reaches AWS.
import { describe, expect, it } from 'vitest';
import { DELETION_LOG_PREFIX, InvalidDeletionLogEntryError, deletionLogBody, deletionLogKey, s3DeletionLogStore } from '../../src/account/deletion-log.ts';
import { cognitoUserDirectory, isUserPoolId } from '../../src/account/user-pool.ts';
import { cognitoUsernameFromEvent } from '../../src/auth/user-id.ts';
import { event } from '../events.ts';
import { FakeUserPool, VersionedBucket, awsError } from '../s3-fakes.ts';

const LOG_BUCKET = 'cupmark-dev-deletion-log-000000000000';
const SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718';
const PHOTO = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
const ENTRY = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DG';
const POOL = 'eu-central-1_AbC123xyz';

function username(value: string): NonNullable<ReturnType<typeof cognitoUsernameFromEvent>> {
  const parsed = cognitoUsernameFromEvent(event({ sub: SUB, username: value }));
  if (parsed === undefined) throw new Error('not a username');
  return parsed;
}

describe('deletion log', () => {
  it('writes one entries/<ulid>.json with the ids only, as application/json', async () => {
    const bucket = new VersionedBucket(LOG_BUCKET);
    const log = s3DeletionLogStore(bucket.client, LOG_BUCKET, { newId: () => ENTRY });
    await log?.append({ sub: SUB, photo_ids: [PHOTO], deleted_at: '2026-11-25T12:00:00.000Z' });
    expect(bucket.keys()).toEqual([`entries/${ENTRY}.json`]);
    const put = bucket.sent[0]?.input;
    expect(put).toMatchObject({ Bucket: LOG_BUCKET, Key: `entries/${ENTRY}.json`, ContentType: 'application/json' });
    expect(JSON.parse(String(put?.Body))).toEqual({ sub: SUB, photo_ids: [PHOTO], deleted_at: '2026-11-25T12:00:00.000Z' });
    expect(Object.keys(put ?? {}).sort()).toEqual(['Body', 'Bucket', 'ContentType', 'Key']);
  });

  it('a fresh ULID per entry, never derived from the user', async () => {
    const bucket = new VersionedBucket(LOG_BUCKET);
    const log = s3DeletionLogStore(bucket.client, LOG_BUCKET);
    await log?.append({ sub: SUB, photo_ids: [], deleted_at: '2026-11-25T12:00:00.000Z' });
    await log?.append({ sub: SUB, photo_ids: [], deleted_at: '2026-11-25T12:00:00.000Z' });
    const keys = bucket.keys();
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^entries\/[0-9A-HJKMNP-TV-Z]{26}\.json$/);
      expect(key).not.toContain(SUB);
    }
    expect(DELETION_LOG_PREFIX).toBe('entries/');
  });

  it('refuses anything but ids and a timestamp, before S3 is asked', async () => {
    const bucket = new VersionedBucket(LOG_BUCKET);
    const log = s3DeletionLogStore(bucket.client, LOG_BUCKET);
    for (const entry of [
      { sub: 'someone', photo_ids: [], deleted_at: '2026-11-25T12:00:00.000Z' },
      { sub: SUB, photo_ids: ['not a ulid'], deleted_at: '2026-11-25T12:00:00.000Z' },
      { sub: SUB, photo_ids: [], deleted_at: 'yesterday' },
    ]) {
      expect(() => deletionLogBody(entry)).toThrow(InvalidDeletionLogEntryError);
      await expect(log?.append(entry)).rejects.toThrow(InvalidDeletionLogEntryError);
    }
    expect(() => deletionLogKey('../x')).toThrow(InvalidDeletionLogEntryError);
    expect(bucket.sent).toEqual([]);
  });

  it('exists only for a cupmark- bucket name', () => {
    const bucket = new VersionedBucket(LOG_BUCKET);
    for (const name of [undefined, '', 'deletion-log', 'other-log']) expect(s3DeletionLogStore(bucket.client, name)).toBeUndefined();
  });

  it('passes an S3 failure on', async () => {
    const bucket = new VersionedBucket(LOG_BUCKET);
    bucket.failWith = () => awsError('AccessDenied');
    const log = s3DeletionLogStore(bucket.client, LOG_BUCKET);
    await expect(log?.append({ sub: SUB, photo_ids: [], deleted_at: '2026-11-25T12:00:00.000Z' })).rejects.toThrow();
  });
});

describe('Cognito user deletion', () => {
  it('USER_POOL_ID must be a pool in eu-central-1', () => {
    for (const good of [POOL, 'eu-central-1_a', `eu-central-1_${'a'.repeat(55)}`]) expect(isUserPoolId(good)).toBe(true);
    for (const bad of [undefined, '', 'eu-west-1_AbC123', 'eu-central-1_', `eu-central-1_${'a'.repeat(56)}`, 'eu-central-1_ab-c', ' eu-central-1_abc', 'eu-central-1_abc\n']) {
      expect(isUserPoolId(bad)).toBe(false);
    }
    const pool = new FakeUserPool(POOL, []);
    expect(cognitoUserDirectory(pool.client, 'eu-west-1_AbC123')).toBeUndefined();
  });

  it('AdminDeleteUser with the pool and the token username; a user already gone is success', async () => {
    const pool = new FakeUserPool(POOL, ['SignInWithApple_001234.abcdef0123456789.0123']);
    const users = cognitoUserDirectory(pool.client, POOL);
    await users?.deleteUser(username('SignInWithApple_001234.abcdef0123456789.0123'));
    expect(pool.sent).toEqual([{ UserPoolId: POOL, Username: 'SignInWithApple_001234.abcdef0123456789.0123' }]);
    expect(pool.users.size).toBe(0);
    await expect(users?.deleteUser(username('SignInWithApple_001234.abcdef0123456789.0123'))).resolves.toBeUndefined();
  });

  it('any other failure is passed on', async () => {
    const pool = new FakeUserPool(POOL, ['u']);
    pool.failWith = awsError('TooManyRequestsException');
    await expect(cognitoUserDirectory(pool.client, POOL)?.deleteUser(username('u'))).rejects.toThrow();
  });
});

describe('the username comes from the token only', () => {
  it('reads the username claim and nothing else', () => {
    expect(cognitoUsernameFromEvent(event({ sub: SUB, username: 'SignInWithApple_001.abc' }))?.value).toBe('SignInWithApple_001.abc');
    // The planted username in the body, path, query and headers of `event` is never read.
    expect(cognitoUsernameFromEvent(event({ sub: SUB }))).toBeUndefined();
    expect(cognitoUsernameFromEvent(event(undefined))).toBeUndefined();
  });

  it('refuses anything that is not a plain Cognito username', () => {
    for (const bad of ['', 'a b', 'a/b', 'a\nb', 'x'.repeat(129), 'ü', 'a:b']) {
      expect(cognitoUsernameFromEvent(event({ sub: SUB, username: bad }))).toBeUndefined();
    }
    expect(cognitoUsernameFromEvent(event({ sub: SUB, username: 7 }))).toBeUndefined();
  });
});
