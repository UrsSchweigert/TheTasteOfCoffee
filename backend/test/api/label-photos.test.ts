// The label photo routes (M1-T4d, ADR 0016) through the router, with the
// in-memory store and an in-memory photo bucket (stubbed presigner, uploads
// put there by the test as the app's POST would): every status of both
// routes, the field mapping, the 3-photo cap at creation and at completion,
// stripping, the 400-then-404 rule, cross-user 404s and logs without ids.
// No test reaches AWS; the real presigner is covered in
// test/images/label-photo-store.test.ts and once here with fake credentials.
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { LABEL_PHOTO_DAILY_CAP } from '../../src/api/label-photos.ts';
import { LabelPhotoUploadSchema } from '../../src/generated/contract.ts';
import type { LabelPhotoUpload } from '../../src/generated/contract.ts';
import { stripJpeg } from '../../src/images/jpeg.ts';
import { MAX_LABEL_PHOTO_BYTES, s3LabelPhotoStore } from '../../src/images/label-photo-store.ts';
import type { LabelPhotoStore, PresignedUpload, UploadRead } from '../../src/images/label-photo-store.ts';
import { BeanNotUnverifiedError, LabelPhotoCapReachedError, WriteConflictError } from '../../src/repository/index.ts';
import type { BeanRecord } from '../../src/repository/index.ts';
import { contains, jpegWithMetadata, minimalJpeg } from '../images/jpeg-fixtures.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BEAN, BOB_SUB, harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

const BUCKET = 'cupmark-dev-photos-000000000000';
const URL = `https://${BUCKET}.s3.eu-central-1.amazonaws.com/`;
const NOW = new Date('2026-11-25T12:00:00.000Z');
const PHOTO_IDS = ['01JDR0000000000000000000A1', '01JDR0000000000000000000A2', '01JDR0000000000000000000A3', '01JDR0000000000000000000A4', '01JDR0000000000000000000A5'];
const SIGNATURE = 'a'.repeat(64);
const POLICY = Buffer.from('{"made-up":"policy"}').toString('base64');
const TOKEN = 'U0VTU0lPTi1UT0tFTi1GQUtF';
const CREDENTIAL = 'TESTACCESSKEYID00000/20261125/eu-central-1/s3/aws4_request';

/** What createPresignedPost returns, for a key. */
function sdkPost(key: string, overrides: Partial<Record<string, string>> = {}, url = URL): PresignedUpload {
  const fields: Record<string, string> = {
    'Content-Type': 'image/jpeg',
    bucket: BUCKET,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': CREDENTIAL,
    'X-Amz-Date': '20261125T120000Z',
    'X-Amz-Security-Token': TOKEN,
    key,
    Policy: POLICY,
    'X-Amz-Signature': SIGNATURE,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(fields, name);
    else fields[name] = value;
  }
  return { url, fields };
}

class MemoryBucket implements LabelPhotoStore {
  public readonly bucket = BUCKET;
  public readonly objects = new Map<string, Uint8Array>();
  public readonly calls: string[] = [];
  public presigned: ((photoId: string) => Promise<PresignedUpload>) | undefined;
  public getResult: (() => Promise<UploadRead>) | undefined;
  public failPut = false;

  public presignUpload(photoId: string): Promise<PresignedUpload> {
    this.calls.push('presign');
    return this.presigned?.(photoId) ?? Promise.resolve(sdkPost(`uploads/${photoId}.jpg`));
  }

  public getUpload(photoId: string): Promise<UploadRead> {
    this.calls.push('get');
    if (this.getResult !== undefined) return this.getResult();
    const bytes = this.objects.get(`uploads/${photoId}.jpg`);
    if (bytes === undefined) return Promise.resolve({ kind: 'missing', reason: 'NoSuchKey' });
    return Promise.resolve(bytes.byteLength > MAX_LABEL_PHOTO_BYTES ? { kind: 'too_large' } : { kind: 'found', bytes });
  }

  public putLabel(photoId: string, jpeg: Uint8Array): Promise<void> {
    this.calls.push('put');
    if (this.failPut) return Promise.reject(Object.assign(new Error('s3 down'), { name: 'InternalError' }));
    this.objects.set(`labels/${photoId}.jpg`, jpeg);
    return Promise.resolve();
  }

  /** The app's POST to S3. */
  public upload(photoId: string, bytes: Uint8Array = jpegWithMetadata()): void {
    this.objects.set(`uploads/${photoId}.jpg`, bytes);
  }
}

interface Setup extends Harness {
  readonly bucket: MemoryBucket;
}

function setup(options: { dailyCap?: number; bucket?: MemoryBucket | null } = {}): Setup {
  const store = new FakeStore();
  store.now = new Date(NOW);
  store.photoIds.push(...PHOTO_IDS);
  store.catalogue.set(BEAN, unverified(BEAN));
  const bucket = options.bucket ?? new MemoryBucket();
  const h = harness({
    store,
    ...(options.bucket === null ? {} : { labelPhotos: { store: bucket, dailyCap: options.dailyCap ?? LABEL_PHOTO_DAILY_CAP, now: () => new Date(store.now) } }),
    retryDelayMs: () => 0,
  });
  return Object.assign(h, { bucket });
}

function unverified(beanId: string, status: BeanRecord['status'] = 'unverified'): BeanRecord {
  return {
    bean: { bean_id: beanId, vocabulary_version: 1, verified: status === 'verified', open_food_facts_match: false, picked_attributes: {}, operator_attributes: {} },
    status,
    createdAt: NOW.toISOString(),
  };
}

const start = (h: Harness, sub = ALICE_SUB, bean = BEAN, options: Parameters<Harness['call']>[2] = {}): ReturnType<Harness['call']> =>
  h.call('POST', `/beans/${bean}/label_photos`, { sub, ...options });
const complete = (h: Harness, photoId: string, sub = ALICE_SUB, options: Parameters<Harness['call']>[2] = {}): ReturnType<Harness['call']> =>
  h.call('POST', `/label_photos/${photoId}/complete`, { sub, ...options });

async function started(h: Setup, sub = ALICE_SUB): Promise<LabelPhotoUpload> {
  const response = await start(h, sub);
  expect(response.status).toBe(201);
  return LabelPhotoUploadSchema.parse(response.body);
}

const pendingKey = (photoId: string, sub = ALICE_SUB): string => `USER#${sub}|PHOTO_PENDING#${photoId}`;
const countKey = (sub = ALICE_SUB, bean = BEAN): string => `USER#${sub}|BEANPHOTOS#${bean}`;

describe('POST /beans/{bean_id}/label_photos', () => {
  it('201: a photo id, the presigned POST under the contract names, expires_at 10 minutes ahead and max_bytes', async () => {
    const h = setup();
    const response = await start(h);
    expect(response.status).toBe(201);
    expect(response.result.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    const photoId = PHOTO_IDS[0] ?? '';
    expect(LabelPhotoUploadSchema.parse(response.body)).toEqual({
      photo_id: photoId,
      upload: {
        url: URL,
        fields: {
          key: `uploads/${photoId}.jpg`,
          bucket: BUCKET,
          content_type: 'image/jpeg',
          policy: POLICY,
          x_amz_algorithm: 'AWS4-HMAC-SHA256',
          x_amz_credential: CREDENTIAL,
          x_amz_date: '20261125T120000Z',
          x_amz_security_token: TOKEN,
          x_amz_signature: SIGNATURE,
        },
      },
      expires_at: '2026-11-25T12:10:00.000Z',
      max_bytes: 8388608,
    });
    // The pending item, in Alice's partition, names the bean and lives a day.
    expect(h.store.pendingPhotos.get(pendingKey(photoId))).toEqual({ beanId: BEAN, expiresAt: NOW.getTime() / 1000 + 86400 });
    expect([...h.store.uploadCounters.entries()]).toEqual([[`USER#${ALICE_SUB}|PHOTO_UPLOADS#2026-11-25`, 1]]);
    expect(h.bucket.calls).toEqual(['presign']);
    expect(h.logs.at(-1)).toEqual({ operation: 'createLabelPhotoUpload', status: 201, request_id: 'request-1' });
  });

  it('without a session token the field is left out', async () => {
    const h = setup();
    h.bucket.presigned = (id) => Promise.resolve(sdkPost(`uploads/${id}.jpg`, { 'X-Amz-Security-Token': undefined }));
    const body = (await started(h)).upload.fields;
    expect(body.x_amz_security_token).toBeUndefined();
    expect(Object.keys(body)).not.toContain('x_amz_security_token');
  });

  it('with the real presigner (made-up credentials, nothing sent): the policy names the key, 1 byte to 8 MiB, image/jpeg and the bucket', async () => {
    const client = new S3Client({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'TESTACCESSKEYID00000', secretAccessKey: 'not-a-real-secret' },
      requestHandler: { handle: () => Promise.reject(new Error('no request may be sent')) },
    });
    const real = s3LabelPhotoStore(client, BUCKET);
    if (real === undefined) throw new Error('no store');
    const store = new FakeStore();
    store.catalogue.set(BEAN, unverified(BEAN));
    const h = harness({ store, labelPhotos: { store: real } });
    const response = await h.call('POST', `/beans/${BEAN}/label_photos`);
    expect(response.status).toBe(201);
    const upload = LabelPhotoUploadSchema.parse(response.body);
    expect(upload.upload.url).toBe(URL);
    expect(upload.upload.fields.key).toBe(`uploads/${upload.photo_id}.jpg`);
    const policy = JSON.parse(Buffer.from(upload.upload.fields.policy, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
    expect(policy.conditions).toContainEqual(['eq', '$key', `uploads/${upload.photo_id}.jpg`]);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 8388608]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/jpeg']);
    expect(policy.conditions).toContainEqual(['eq', '$bucket', BUCKET]);
    const lifetime = Date.parse(policy.expiration) - Date.parse(upload.expires_at);
    expect(Math.abs(lifetime)).toBeLessThan(2000);
  });

  it.each([
    ['a query', { query: 'key=uploads/x.jpg' }],
    ['a JSON body', { json: { key: 'uploads/x.jpg' } }],
    ['an empty JSON object', { json: {} }],
  ])('400 for %s, before anything is read', async (_name, options) => {
    const h = setup();
    const response = await start(h, ALICE_SUB, BEAN, options);
    expect(response.status).toBe(400);
    expect(response.result.body).toBeUndefined();
    expect(h.store.calls).toEqual([]);
    expect(h.bucket.calls).toEqual([]);
  });

  it.each(['abc', BEAN.toLowerCase(), `${BEAN}X`, '..%2Fx'])('400 for the bean id %s', async (bad) => {
    const h = setup();
    expect((await start(h, ALICE_SUB, bad)).status).toBe(400);
    expect(h.store.calls).toEqual([]);
  });

  it('401 without a token', async () => {
    const h = setup();
    const response = await start(h, null as unknown as string);
    expect(response.status).toBe(401);
    expect(h.store.calls).toEqual([]);
  });

  it('404 for an unknown bean and for a rejected one; nothing is written or signed', async () => {
    const h = setup();
    expect((await start(h, ALICE_SUB, '01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
    h.store.catalogue.set(BEAN, unverified(BEAN, 'rejected'));
    const response = await start(h);
    expect(response.status).toBe(404);
    expect(response.result.body).toBeUndefined();
    expect(h.store.pendingPhotos.size).toBe(0);
    expect(h.store.uploadCounters.size).toBe(0);
    expect(h.bucket.calls).toEqual([]);
    expect(h.logs.at(-1)?.error).toBe('BeanNotFoundError');
  });

  it('409 for a verified bean; nothing is written or signed', async () => {
    const h = setup();
    h.store.catalogue.set(BEAN, unverified(BEAN, 'verified'));
    const response = await start(h);
    expect(response.status).toBe(409);
    expect(h.store.pendingPhotos.size).toBe(0);
    expect(h.store.uploadCounters.size).toBe(0);
    expect(h.bucket.calls).toEqual([]);
  });

  it('409 once the caller has 3 completed photos for the bean; pending uploads do not count', async () => {
    const h = setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await started(h)).photo_id);
    for (const id of ids.slice(0, 3)) {
      h.bucket.upload(id);
      expect((await complete(h, id)).status).toBe(204);
    }
    const response = await start(h);
    expect(response.status).toBe(409);
    expect(h.logs.at(-1)?.error).toBe('LabelPhotoCapReachedError');
    // Bob's count is his own.
    expect((await start(h, BOB_SUB)).status).toBe(201);
  });

  it(`429 over the daily cap (default ${String(LABEL_PHOTO_DAILY_CAP)} a UTC day), per caller; the next day works again`, async () => {
    expect(LABEL_PHOTO_DAILY_CAP).toBe(20);
    const h = setup({ dailyCap: 2 });
    expect((await start(h)).status).toBe(201);
    expect((await start(h)).status).toBe(201);
    const response = await start(h);
    expect(response.status).toBe(429);
    expect(response.result.body).toBeUndefined();
    expect(h.store.pendingPhotos.size).toBe(2);
    expect(h.logs.at(-1)).toEqual({ operation: 'createLabelPhotoUpload', status: 429, request_id: 'request-1', error: 'LabelPhotoUploadCapReached' });
    expect((await start(h, BOB_SUB)).status).toBe(201);
    h.store.now = new Date('2026-11-26T00:00:00.000Z');
    expect((await start(h)).status).toBe(201);
  });

  it('refused requests (404, 409) do not count against the daily cap', async () => {
    const h = setup({ dailyCap: 1 });
    expect((await start(h, ALICE_SUB, '01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
    expect((await start(h)).status).toBe(201);
  });

  it('500 without a photo bucket, before anything is read', async () => {
    const h = setup({ bucket: null });
    const response = await start(h);
    expect(response.status).toBe(500);
    expect(h.logs.at(-1)?.error).toBe('PhotoBucketNotConfigured');
    expect(h.store.calls).toEqual([]);
  });

  it('500 if signing fails, logged by class name only', async () => {
    const h = setup();
    h.bucket.presigned = () => Promise.reject(Object.assign(new Error(`no credentials for ${BUCKET}`), { name: 'CredentialsProviderError' }));
    const response = await start(h);
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(h.logs.at(-1)).toEqual({ operation: 'createLabelPhotoUpload', status: 500, request_id: 'request-1', error: 'CredentialsProviderError' });
  });

  it.each<[string, (id: string) => PresignedUpload]>([
    ['an unknown field', (id) => sdkPost(`uploads/${id}.jpg`, { 'x-amz-meta-user': 'x' })],
    ['a missing signature', (id) => sdkPost(`uploads/${id}.jpg`, { 'X-Amz-Signature': undefined })],
    ['a missing policy', (id) => sdkPost(`uploads/${id}.jpg`, { Policy: undefined })],
    ['another key', () => sdkPost(`uploads/${PHOTO_IDS[4] ?? ''}.jpg`)],
    ['a key with a user id', (id) => sdkPost(`uploads/${ALICE_SUB}/${id}.jpg`)],
    ['another bucket in the fields', (id) => sdkPost(`uploads/${id}.jpg`, { bucket: 'cupmark-other-bucket' })],
    ['another bucket in the URL', (id) => sdkPost(`uploads/${id}.jpg`, {}, 'https://cupmark-other-bucket.s3.eu-central-1.amazonaws.com/')],
    ['another region', (id) => sdkPost(`uploads/${id}.jpg`, {}, `https://${BUCKET}.s3.us-east-1.amazonaws.com/`)],
    ['a path-style URL', (id) => sdkPost(`uploads/${id}.jpg`, {}, `https://s3.eu-central-1.amazonaws.com/${BUCKET}/`)],
    ['another content type', (id) => sdkPost(`uploads/${id}.jpg`, { 'Content-Type': 'image/png' })],
    ['a credential in another region', (id) => sdkPost(`uploads/${id}.jpg`, { 'X-Amz-Credential': CREDENTIAL.replace('eu-central-1', 'us-east-1') })],
  ])('500 LabelPhotoUploadInvalid for a presigned POST with %s', async (_name, post) => {
    const h = setup();
    h.bucket.presigned = (id) => Promise.resolve(post(id));
    const response = await start(h);
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(h.logs.at(-1)).toEqual({ operation: 'createLabelPhotoUpload', status: 500, request_id: 'request-1', error: 'LabelPhotoUploadInvalid' });
  });
});

describe('POST /label_photos/{photo_id}/complete', () => {
  it('204: the upload is stripped of all metadata and stored under labels/, then recorded for the user and the bean', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    const original = jpegWithMetadata();
    h.bucket.upload(photoId, original);
    const response = await complete(h, photoId);
    expect(response.status).toBe(204);
    expect(response.result.body).toBeUndefined();

    const stored = h.bucket.objects.get(`labels/${photoId}.jpg`);
    expect(stored).toEqual(stripJpeg(original));
    for (const secret of ['Exif', 'GPSLatitude', 'CAM-SECRET-123', 'XMP-AUTHOR', 'ICC_PROFILE', 'IPTC', 'COMMENT-SECRET', 'TRAILING-SECRET', 'THUMBNAIL-JFXX']) {
      expect(contains(original, secret)).toBe(true);
      expect(contains(stored ?? new Uint8Array(), secret)).toBe(false);
    }
    // The raw upload is left for the lifecycle rule; the API deletes nothing in S3.
    expect(h.bucket.objects.has(`uploads/${photoId}.jpg`)).toBe(true);

    expect(h.store.pendingPhotos.size).toBe(0);
    expect([...h.store.userPhotos.entries()]).toEqual([[`USER#${ALICE_SUB}|PHOTO#${photoId}`, { beanId: BEAN, createdAt: NOW.toISOString() }]]);
    expect([...h.store.beanPhotos.entries()]).toEqual([[`BEAN#${BEAN}|PHOTO#${photoId}`, { createdAt: NOW.toISOString() }]]);
    expect(JSON.stringify([...h.store.beanPhotos])).not.toContain(ALICE_SUB);
    expect(h.store.photoCounts.get(countKey())).toBe(1);
    expect(h.logs.at(-1)).toEqual({ operation: 'completeLabelPhoto', status: 204, request_id: 'request-1' });
  });

  it('409 when called again for a completed photo', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId, minimalJpeg());
    expect((await complete(h, photoId)).status).toBe(204);
    const again = await complete(h, photoId);
    expect(again.status).toBe(409);
    expect(h.logs.at(-1)?.error).toBe('LabelPhotoCompletedError');
    expect(h.store.photoCounts.get(countKey())).toBe(1);
  });

  it('404 for an unknown photo id, before S3 is read', async () => {
    const h = setup();
    const response = await complete(h, PHOTO_IDS[4] ?? '');
    expect(response.status).toBe(404);
    expect(response.result.body).toBeUndefined();
    expect(h.bucket.calls).toEqual([]);
    expect(h.logs.at(-1)?.error).toBe('LabelPhotoNotPending');
  });

  it("another caller's photo id is 404, pending or completed, exactly like an unknown one; nothing of the owner's changes", async () => {
    const h = setup();
    const first = (await started(h)).photo_id;
    const second = (await started(h)).photo_id;
    h.bucket.upload(first);
    h.bucket.upload(second);
    expect((await complete(h, first)).status).toBe(204);
    const before = structuredClone({ pending: [...h.store.pendingPhotos], photos: [...h.store.userPhotos], counts: [...h.store.photoCounts] });
    const unknown = await complete(h, PHOTO_IDS[4] ?? '', BOB_SUB);
    const unknownLog = h.logs.at(-1);
    expect(unknownLog?.status).toBe(404);
    for (const id of [first, second]) {
      const response = await complete(h, id, BOB_SUB);
      expect(response.status).toBe(404);
      expect(response.result).toEqual(unknown.result);
      expect(h.logs.at(-1)).toEqual(unknownLog);
    }
    expect({ pending: [...h.store.pendingPhotos], photos: [...h.store.userPhotos], counts: [...h.store.photoCounts] }).toEqual(before);
    expect(h.bucket.calls.filter((c) => c === 'get')).toHaveLength(1);
    // Alice can still complete her pending one.
    expect((await complete(h, second)).status).toBe(204);
  });

  it('404 once the pending upload has expired (1 day)', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId);
    h.store.now = new Date(NOW.getTime() + 86_400_000);
    expect((await complete(h, photoId)).status).toBe(404);
    expect(h.bucket.calls).toEqual(['presign']);
  });

  it.each<[string, () => Promise<UploadRead>, string]>([
    ['NoSuchKey', () => Promise.resolve({ kind: 'missing', reason: 'NoSuchKey' }), 'NoSuchKey'],
    ['AccessDenied (no s3:ListBucket)', () => Promise.resolve({ kind: 'missing', reason: 'AccessDenied' }), 'AccessDenied'],
  ])('404 when nothing was uploaded (%s); the upload stays pending, so a later call works', async (_name, answer, reason) => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.getResult = answer;
    const response = await complete(h, photoId);
    expect(response.status).toBe(404);
    expect(h.logs.at(-1)).toEqual({ operation: 'completeLabelPhoto', status: 404, request_id: 'request-1', error: 'LabelPhotoUploadMissing', reason });
    expect(h.store.pendingPhotos.size).toBe(1);
    h.bucket.getResult = undefined;
    h.bucket.upload(photoId);
    expect((await complete(h, photoId)).status).toBe(204);
  });

  it.each<[string, Uint8Array, string]>([
    ['larger than 8 MiB', new Uint8Array(MAX_LABEL_PHOTO_BYTES + 1), 'LabelPhotoTooLarge'],
    ['not a JPEG', Uint8Array.from(Buffer.from('\x89PNG\r\n\x1a\n')), 'LabelPhotoNotJpeg'],
    ['a truncated JPEG', minimalJpeg().subarray(0, 30), 'LabelPhotoNotJpeg'],
    ['empty', new Uint8Array(0), 'LabelPhotoNotJpeg'],
  ])('400 for an upload that is %s; the photo is rejected for good, so the next call is 404', async (_name, bytes, error) => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId, bytes);
    const response = await complete(h, photoId);
    expect(response.status).toBe(400);
    expect(response.result.body).toBeUndefined();
    expect(h.logs.at(-1)).toEqual({ operation: 'completeLabelPhoto', status: 400, request_id: 'request-1', error });
    expect(h.store.pendingPhotos.size).toBe(0);
    expect(h.store.userPhotos.size).toBe(0);
    expect(h.store.photoCounts.size).toBe(0);
    expect(h.bucket.objects.has(`labels/${photoId}.jpg`)).toBe(false);
    // Even a valid JPEG uploaded afterwards does not revive it.
    h.bucket.upload(photoId, minimalJpeg());
    expect((await complete(h, photoId)).status).toBe(404);
  });

  it('a too-large answer from the store (by ContentLength) is the same 400', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.getResult = () => Promise.resolve({ kind: 'too_large' });
    expect((await complete(h, photoId)).status).toBe(400);
    expect((await complete(h, photoId)).status).toBe(404);
  });

  it('400 for a query, a body or a malformed photo id, before anything is read', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    const calls = h.store.calls.length;
    expect((await complete(h, photoId, ALICE_SUB, { query: 'x=1' })).status).toBe(400);
    expect((await complete(h, photoId, ALICE_SUB, { json: { bean_id: BEAN } })).status).toBe(400);
    expect((await complete(h, photoId.toLowerCase())).status).toBe(400);
    expect((await complete(h, `${photoId}.jpg`)).status).toBe(400);
    expect(h.store.calls).toHaveLength(calls);
  });

  it('401 without a token', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    expect((await complete(h, photoId, null as unknown as string)).status).toBe(401);
    expect(h.store.pendingPhotos.size).toBe(1);
  });

  it('409 if the bean was verified or rejected after the upload started, before S3 is read', async () => {
    for (const status of ['verified', 'rejected'] as const) {
      const h = setup();
      const { photo_id: photoId } = await started(h);
      h.bucket.upload(photoId);
      h.store.catalogue.set(BEAN, unverified(BEAN, status));
      const response = await complete(h, photoId);
      expect(response.status).toBe(409);
      expect(h.logs.at(-1)?.error).toBe('BeanNotUnverifiedError');
      expect(h.bucket.calls).toEqual(['presign']);
      expect(h.store.userPhotos.size).toBe(0);
    }
  });

  it('the cap at completion: four uploads started, three complete, the fourth is 409', async () => {
    const h = setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await started(h)).photo_id);
    for (const id of ids) h.bucket.upload(id);
    const statuses: number[] = [];
    for (const id of ids) statuses.push((await complete(h, id)).status);
    expect(statuses).toEqual([204, 204, 204, 409]);
    expect(h.logs.at(-1)?.error).toBe('LabelPhotoCapReachedError');
    expect(h.store.photoCounts.get(countKey())).toBe(3);
    expect(h.store.userPhotos.size).toBe(3);
    expect(h.bucket.objects.has(`labels/${ids[3] ?? ''}.jpg`)).toBe(false);
  });

  it('409 from the transaction itself (cap or bean raced after the checks), with the labels/ object logged as an orphan', async () => {
    for (const failure of [new LabelPhotoCapReachedError('cap'), new BeanNotUnverifiedError('not unverified')]) {
      const h = setup();
      const { photo_id: photoId } = await started(h);
      h.bucket.upload(photoId);
      h.store.failComplete = failure;
      const response = await complete(h, photoId);
      expect(response.status).toBe(409);
      expect(h.logs.at(-1)).toEqual({ operation: 'completeLabelPhoto', status: 409, request_id: 'request-1', error: failure.name, reason: 'label_orphaned' });
      expect(h.bucket.objects.has(`labels/${photoId}.jpg`)).toBe(true);
    }
  });

  it('a transaction that keeps racing is tried three times, then 500', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId);
    h.store.failComplete = new WriteConflictError('raced');
    const response = await complete(h, photoId);
    expect(response.status).toBe(500);
    expect(h.store.calls.filter((c) => c === 'completeLabelPhoto')).toHaveLength(3);
    expect(h.logs.at(-1)?.reason).toBe('label_orphaned');
  });

  it('500 for an S3 read or write error; nothing is recorded and the upload stays pending', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId);
    h.bucket.getResult = () => Promise.reject(Object.assign(new Error('x'), { name: 'SlowDown' }));
    expect((await complete(h, photoId)).status).toBe(500);
    expect(h.logs.at(-1)?.error).toBe('SlowDown');
    h.bucket.getResult = undefined;
    h.bucket.failPut = true;
    expect((await complete(h, photoId)).status).toBe(500);
    expect(h.logs.at(-1)?.error).toBe('InternalError');
    expect(h.store.userPhotos.size).toBe(0);
    expect(h.store.pendingPhotos.size).toBe(1);
    h.bucket.failPut = false;
    expect((await complete(h, photoId)).status).toBe(204);
  });

  it('500 without a photo bucket', async () => {
    const h = setup({ bucket: null });
    expect((await complete(h, PHOTO_IDS[0] ?? '')).status).toBe(500);
    expect(h.store.calls).toEqual([]);
  });

  it('the user id comes from the token only: a sub in the query, headers or body never selects a partition', async () => {
    const h = setup();
    const { photo_id: photoId } = await started(h);
    h.bucket.upload(photoId);
    const response = await complete(h, photoId, BOB_SUB, { headers: { 'x-user-id': ALICE_SUB } });
    expect(response.status).toBe(404);
    expect(h.store.pendingPhotos.has(pendingKey(photoId))).toBe(true);
    expect(h.store.userPhotos.size).toBe(0);
  });
});

describe('logging', () => {
  it('no log line carries a user id, photo id, bean id, key, bucket, URL, policy, signature, credential or token', async () => {
    const h = setup({ dailyCap: 6 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await started(h)).photo_id);
    h.bucket.upload(ids[0] ?? '');
    h.bucket.upload(ids[1] ?? '', Uint8Array.of(1, 2, 3));
    await complete(h, ids[0] ?? '');
    await complete(h, ids[0] ?? '');
    await complete(h, ids[1] ?? '');
    await complete(h, ids[2] ?? '');
    await complete(h, ids[3] ?? '', BOB_SUB);
    h.bucket.presigned = (id) => Promise.resolve(sdkPost(`uploads/${id}.jpg`, { bucket: 'cupmark-leaky-bucket' }));
    await start(h);
    h.bucket.presigned = () => Promise.reject(Object.assign(new Error(`${BUCKET} ${SIGNATURE}`), { name: 'CredentialsProviderError' }));
    await start(h);
    await start(h);
    await start(h, ALICE_SUB, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(h.logs.length).toBeGreaterThan(10);
    const text = JSON.stringify(h.logs);
    for (const leaked of [ALICE_SUB, BOB_SUB, BEAN, '01ARZ3NDEKTSV4RRFFQ69G5FAV', ...PHOTO_IDS, BUCKET, 'cupmark-', 'uploads/', 'labels/', 'amazonaws', POLICY, SIGNATURE, CREDENTIAL, 'TESTACCESSKEYID', TOKEN, 'AWS4']) {
      expect(text).not.toContain(leaked);
    }
    for (const entry of h.logs) {
      expect(Object.keys(entry).every((key) => ['operation', 'status', 'request_id', 'error', 'reason'].includes(key))).toBe(true);
    }
  });
});
