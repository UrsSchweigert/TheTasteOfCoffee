// The label photo routes (M1-T4d, ADR 0016) against DynamoDB Local, with the
// real repository and an in-memory photo bucket (S3 is stubbed; nothing calls
// AWS): the items each step writes and where, the 400-then-404 rule, the
// cross-user 404, a bean reviewed meanwhile, the expiry of a pending upload,
// and the 3-photo cap under 4 parallel completions.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/router.ts';
import type { LogEntry } from '../../src/api/router.ts';
import { LabelPhotoUploadSchema } from '../../src/generated/contract.ts';
import { stripJpeg } from '../../src/images/jpeg.ts';
import type { LabelPhotoStore, PresignedUpload, UploadRead } from '../../src/images/label-photo-store.ts';
import {
  BeanNotUnverifiedError,
  ItemNotFoundError,
  LabelPhotoCompletedError,
  Repository,
  beanLabelPhotoKey,
  beanPk,
  labelPhotoCountKey,
  labelPhotoKey,
  pendingLabelPhotoKey,
  userPk,
} from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent } from '../api/helpers.ts';
import { contains, jpegWithMetadata, minimalJpeg } from '../images/jpeg-fixtures.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();
const BUCKET = 'cupmark-dev-photos-000000000000';

class MemoryBucket implements LabelPhotoStore {
  public readonly bucket = BUCKET;
  public readonly objects = new Map<string, Uint8Array>();

  public presignUpload(photoId: string): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `https://${BUCKET}.s3.eu-central-1.amazonaws.com/`,
      fields: {
        'Content-Type': 'image/jpeg',
        bucket: BUCKET,
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'TESTACCESSKEYID00000/20261125/eu-central-1/s3/aws4_request',
        'X-Amz-Date': '20261125T120000Z',
        key: `uploads/${photoId}.jpg`,
        Policy: Buffer.from('{}').toString('base64'),
        'X-Amz-Signature': '0'.repeat(64),
      },
    });
  }

  public getUpload(photoId: string): Promise<UploadRead> {
    const bytes = this.objects.get(`uploads/${photoId}.jpg`);
    return Promise.resolve(bytes === undefined ? { kind: 'missing', reason: 'NoSuchKey' } : { kind: 'found', bytes });
  }

  public putLabel(photoId: string, jpeg: Uint8Array): Promise<void> {
    this.objects.set(`labels/${photoId}.jpg`, jpeg);
    return Promise.resolve();
  }

  public upload(photoId: string, bytes: Uint8Array = jpegWithMetadata()): void {
    this.objects.set(`uploads/${photoId}.jpg`, bytes);
  }
}

describe.skipIf(!local.reachable)('label photos on DynamoDB Local', () => {
  let tableName = '';
  let repository: Repository;
  let api: ReturnType<typeof createApi>;
  let clock = new Date('2026-11-25T12:00:00.000Z');
  const bucket = new MemoryBucket();
  const logs: LogEntry[] = [];
  const { client, documentClient } = local;
  const alice = verifiedUserId(ALICE_SUB);

  async function call(method: string, path: string, sub = ALICE_SUB): Promise<{ status: number; body: unknown }> {
    const result = await api(apiEvent(method, path, { sub }));
    return { status: result.statusCode ?? 0, body: result.body === undefined ? undefined : (JSON.parse(result.body) as unknown) };
  }

  async function newBean(): Promise<string> {
    return (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
  }

  async function startUpload(beanId: string, sub = ALICE_SUB): Promise<string> {
    const response = await call('POST', `/beans/${beanId}/label_photos`, sub);
    expect(response.status).toBe(201);
    return LabelPhotoUploadSchema.parse(response.body).photo_id;
  }

  async function item(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    return result.Item as Record<string, unknown> | undefined;
  }

  async function query(pk: string, prefix: string): Promise<Record<string, unknown>[]> {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  beforeAll(async () => {
    tableName = await createTestTable(client);
    repository = new Repository({ client: documentClient, tableName, now: () => clock });
    api = createApi({
      store: repository,
      cursorSigner: () => Promise.resolve(undefined),
      labelPhotos: { store: bucket, now: () => clock },
      log: (entry) => logs.push(entry),
    });
  });

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  it('the full flow: pending item, stripped label, one transaction of user, bean and count items', async () => {
    const beanId = await newBean();
    const photoId = await startUpload(beanId);
    const pending = await item(pendingLabelPhotoKey(alice, photoId));
    expect(pending).toMatchObject({ type: 'PHOTO_PENDING', photoId, beanId, expires_at: clock.getTime() / 1000 + 86400 });
    expect(await query(userPk(alice), 'PHOTO_UPLOADS#2026-11-25')).toEqual([
      expect.objectContaining({ uploads: 1, type: 'PHOTO_UPLOADS' }),
    ]);

    bucket.upload(photoId);
    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(204);
    const label = bucket.objects.get(`labels/${photoId}.jpg`) ?? new Uint8Array();
    expect(label).toEqual(stripJpeg(jpegWithMetadata()));
    expect(contains(label, 'GPSLatitude')).toBe(false);

    expect(await item(pendingLabelPhotoKey(alice, photoId))).toBeUndefined();
    expect(await item(labelPhotoKey(alice, photoId))).toEqual({
      ...labelPhotoKey(alice, photoId),
      type: 'LABEL_PHOTO',
      photoId,
      beanId,
      createdAt: clock.toISOString(),
    });
    const beanPhoto = await item(beanLabelPhotoKey(beanId, photoId));
    expect(beanPhoto).toEqual({ ...beanLabelPhotoKey(beanId, photoId), type: 'BEAN_LABEL_PHOTO', photoId, createdAt: clock.toISOString() });
    expect(JSON.stringify(beanPhoto)).not.toContain(ALICE_SUB);
    expect(await item(labelPhotoCountKey(alice, beanId))).toMatchObject({ type: 'BEAN_PHOTOS', beanId, photos: 1 });
    // M1-T6: export finds the photo under PHOTO#; deletion also under PHOTO_PENDING# and BEANPHOTOS#.
    expect((await query(userPk(alice), 'PHOTO#')).map((i) => i.photoId)).toContain(photoId);
    expect(await query(beanPk(beanId), 'PHOTO#')).toHaveLength(1);

    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(409);
  });

  it('400 rejects for good: the pending item is deleted and the next call is 404', async () => {
    const beanId = await newBean();
    const photoId = await startUpload(beanId);
    bucket.upload(photoId, Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(400);
    expect(await item(pendingLabelPhotoKey(alice, photoId))).toBeUndefined();
    bucket.upload(photoId, minimalJpeg());
    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(404);
    expect(await query(userPk(alice), `PHOTO#${photoId}`)).toEqual([]);
  });

  it("another caller's photo id is 404 and changes nothing", async () => {
    const beanId = await newBean();
    const photoId = await startUpload(beanId);
    bucket.upload(photoId);
    expect((await call('POST', `/label_photos/${photoId}/complete`, BOB_SUB)).status).toBe(404);
    expect(await item(pendingLabelPhotoKey(alice, photoId))).toBeDefined();
    expect(await query(userPk(verifiedUserId(BOB_SUB)), 'PHOTO')).toEqual([]);
    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(204);
  });

  it('a bean verified or rejected after the upload started: 409, from the pre-check and from the transaction condition', async () => {
    const verified = await newBean();
    const photoId = await startUpload(verified);
    bucket.upload(photoId);
    await repository.verifyBean(verified);
    expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(409);
    expect((await call('POST', `/beans/${verified}/label_photos`)).status).toBe(409);
    // The transaction's own ConditionCheck, without the API's pre-check.
    await expect(repository.completeLabelPhoto(alice, photoId, verified)).rejects.toThrow(BeanNotUnverifiedError);
    expect(await item(labelPhotoKey(alice, photoId))).toBeUndefined();

    const rejected = await newBean();
    const other = await startUpload(rejected);
    await repository.rejectBean(rejected);
    await expect(repository.completeLabelPhoto(alice, other, rejected)).rejects.toThrow(BeanNotUnverifiedError);
    expect((await call('POST', `/beans/${rejected}/label_photos`)).status).toBe(404);
  });

  it('the transaction tells completed from gone, and refuses a pending item for another bean', async () => {
    const beanId = await newBean();
    const photoId = await startUpload(beanId);
    await expect(repository.completeLabelPhoto(alice, photoId, await newBean())).rejects.toThrow(ItemNotFoundError);
    await repository.completeLabelPhoto(alice, photoId, beanId);
    await expect(repository.completeLabelPhoto(alice, photoId, beanId)).rejects.toThrow(LabelPhotoCompletedError);
    await expect(repository.completeLabelPhoto(alice, '01ARZ3NDEKTSV4RRFFQ69G5FAV', beanId)).rejects.toThrow(ItemNotFoundError);
  });

  it('a pending upload expires after a day, even before TTL deletes it', async () => {
    const beanId = await newBean();
    const photoId = await startUpload(beanId);
    bucket.upload(photoId);
    const started = clock;
    clock = new Date(started.getTime() + 86_400_000);
    try {
      expect(await repository.getPendingLabelPhoto(alice, photoId)).toBeUndefined();
      expect((await call('POST', `/label_photos/${photoId}/complete`)).status).toBe(404);
      await expect(repository.completeLabelPhoto(alice, photoId, beanId)).rejects.toThrow(ItemNotFoundError);
    } finally {
      clock = started;
    }
  });

  it('the race: 4 parallel completions for one bean record exactly 3', async () => {
    const beanId = await newBean();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await startUpload(beanId));
    for (const id of ids) bucket.upload(id, minimalJpeg());
    const statuses = await Promise.all(ids.map(async (id) => (await call('POST', `/label_photos/${id}/complete`)).status));
    expect(statuses.filter((s) => s === 204)).toHaveLength(3);
    expect(statuses.filter((s) => s !== 204)).toEqual([409]);
    expect(await item(labelPhotoCountKey(alice, beanId))).toMatchObject({ photos: 3 });
    const photos = (await query(userPk(alice), 'PHOTO#')).filter((i) => i.beanId === beanId);
    expect(photos).toHaveLength(3);
    expect(await query(beanPk(beanId), 'PHOTO#')).toHaveLength(3);
    // The loser's pending item stays (it can never complete: the cap holds); TTL removes it.
    expect((await call('POST', `/beans/${beanId}/label_photos`)).status).toBe(409);
  });

  it('the race at the transaction alone (no pre-check): 4 parallel repository completions, never more than 3 recorded', async () => {
    const beanId = await newBean();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await repository.createPendingLabelPhoto(alice, beanId));
    const settled = await Promise.allSettled(ids.map((id) => repository.completeLabelPhoto(alice, id, beanId)));
    const done = settled.filter((r) => r.status === 'fulfilled').length;
    const reasons = settled.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).name] : []));
    // A loser fails on the cap, or on a concurrent transaction (WriteConflictError, retried by the API).
    for (const reason of reasons) expect(['LabelPhotoCapReachedError', 'WriteConflictError']).toContain(reason);
    expect(done).toBeLessThanOrEqual(3);
    expect(done).toBeGreaterThanOrEqual(1);
    expect(await item(labelPhotoCountKey(alice, beanId))).toMatchObject({ photos: done });
    expect((await query(userPk(alice), 'PHOTO#')).filter((i) => i.beanId === beanId)).toHaveLength(done);
    // Whatever raced, the rest can complete up to the cap and no further.
    const results: string[] = [];
    for (const [index, id] of ids.entries()) {
      if (settled[index]?.status === 'fulfilled') continue;
      results.push(await repository.completeLabelPhoto(alice, id, beanId).then(() => 'ok', (error: unknown) => (error as Error).name));
    }
    expect(results.filter((r) => r === 'ok')).toHaveLength(3 - done);
    expect(results.filter((r) => r !== 'ok')).toEqual(['LabelPhotoCapReachedError']);
    expect(await item(labelPhotoCountKey(alice, beanId))).toMatchObject({ photos: 3 });
  });

  it('the daily cap: 20 creates per UTC day, then 429', async () => {
    const bob = BOB_SUB;
    const beans: string[] = [];
    for (let i = 0; i < 7; i += 1) beans.push(await newBean());
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await call('POST', `/beans/${beans[i % 7] ?? ''}/label_photos`, bob)).status);
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(await query(userPk(verifiedUserId(bob)), 'PHOTO_UPLOADS#')).toEqual([expect.objectContaining({ uploads: 20 })]);
  });

  it('logs carry no ids', () => {
    const text = JSON.stringify(logs);
    expect(text).not.toContain(ALICE_SUB);
    expect(text).not.toContain(BOB_SUB);
    expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
  });
});
