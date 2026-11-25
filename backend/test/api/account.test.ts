// The profile, the tombstone guard and account deletion (M1-T6; ADR 0017 and
// its Addendum; D1, D2, D10, D11), against the in-memory store, a versioned
// S3 fake and a Cognito fake. Nothing reaches AWS. The same flows run against
// DynamoDB Local in test/integration/account.test.ts.
import { describe, expect, it } from 'vitest';
import { s3DeletionLogStore } from '../../src/account/deletion-log.ts';
import { cognitoUserDirectory } from '../../src/account/user-pool.ts';
import type { AccountDeletionConfig } from '../../src/api/account.ts';
import { ROUTES } from '../../src/api/router.ts';
import { ProfileSchema, RecipeSchema, ShelfEntrySchema, BrewSchema } from '../../src/generated/contract.ts';
import { s3PhotoDeletionStore } from '../../src/images/photo-deletion-store.ts';
import type { LabelPhotoStore, PresignedUpload, UploadRead } from '../../src/images/label-photo-store.ts';
import { createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import { TOMBSTONE_TTL_SECONDS, beanLabelPhotoKey, labelPhotoCountKey, labelPhotoKey, lookupCounterKey, pendingLabelPhotoKey, userPk } from '../../src/repository/index.ts';
import type { BeanRecord } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { minimalJpeg } from '../images/jpeg-fixtures.ts';
import { FakeUserPool, VersionedBucket, awsError } from '../s3-fakes.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BEAN, BOB_SUB, beanBody, brewBody, harness, recipeBody, shelfBody } from './helpers.ts';
import type { Harness, RequestOptions } from './helpers.ts';

const ALICE = verifiedUserId(ALICE_SUB);
const BOB = verifiedUserId(BOB_SUB);
const USERNAME = 'SignInWithApple_001234.0123456789abcdef0123456789abcdef.0123';
const BOB_USERNAME = 'SignInWithApple_009999.fedcba9876543210fedcba9876543210.0999';
const PHOTO_BUCKET = 'cupmark-dev-photos-000000000000';
const LOG_BUCKET = 'cupmark-dev-deletion-log-000000000000';
const POOL = 'eu-central-1_TestPool01';
const VERIFIED_BEAN = '01JDQ8Z6V3W4X5Y6Z7A8B9C0E1';
const REJECTED_BEAN = '01JDQ8Z6V3W4X5Y6Z7A8B9C0E2';
const PHOTO_UNVERIFIED = '01JDR0000000000000000000B1';
const PHOTO_VERIFIED = '01JDR0000000000000000000B2';
const PHOTO_REJECTED = '01JDR0000000000000000000B3';
const PHOTO_PENDING = '01JDR0000000000000000000B4';
const PHOTO_BOB = '01JDR0000000000000000000B5';
const PROFILE = { locale: 'en', consent: { contribute_to_aggregates: true } } as const;
const EAN13 = '4006381333931';

function bean(beanId: string, status: BeanRecord['status']): BeanRecord {
  return {
    bean: { bean_id: beanId, vocabulary_version: 1, verified: status === 'verified', open_food_facts_match: false, picked_attributes: {}, operator_attributes: {} },
    status,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

const id = (key: { pk: string; sk: string }): string => `${key.pk}|${key.sk}`;

interface World extends Harness {
  readonly photos: VersionedBucket;
  readonly log: VersionedBucket;
  readonly pool: FakeUserPool;
  /** Every store call, S3 command (`photos:`, `log:`) and Cognito call, in order. */
  readonly journal: string[];
  del(options?: RequestOptions): Promise<number>;
}

function world(options: { config?: Partial<Record<keyof AccountDeletionConfig, null>> } = {}): World {
  const store = new FakeStore();
  store.catalogue.set(BEAN, bean(BEAN, 'unverified'));
  store.catalogue.set(VERIFIED_BEAN, bean(VERIFIED_BEAN, 'verified'));
  store.catalogue.set(REJECTED_BEAN, bean(REJECTED_BEAN, 'rejected'));
  const photos = new VersionedBucket(PHOTO_BUCKET);
  photos.label = 'photos';
  const log = new VersionedBucket(LOG_BUCKET);
  log.label = 'log';
  const pool = new FakeUserPool(POOL, [USERNAME, BOB_USERNAME]);
  const journal = store.calls;
  photos.journal = journal;
  log.journal = journal;
  pool.journal = journal;
  const parts = options.config ?? {};
  const photoStore = s3PhotoDeletionStore(photos.client, PHOTO_BUCKET);
  const logStore = s3DeletionLogStore(log.client, LOG_BUCKET);
  const users = cognitoUserDirectory(pool.client, POOL);
  const h = harness({
    store,
    accountDeletion: {
      ...(parts.photos === null || photoStore === undefined ? {} : { photos: photoStore }),
      ...(parts.deletionLog === null || logStore === undefined ? {} : { deletionLog: logStore }),
      ...(parts.users === null || users === undefined ? {} : { users }),
    },
    retryDelayMs: () => 0,
  });
  return Object.assign(h, {
    photos,
    log,
    pool,
    journal,
    async del(request: RequestOptions = {}) {
      const response = await h.call('DELETE', '/account', { username: USERNAME, ...request });
      if (response.result.body !== undefined) throw new Error('DELETE /account must have no body');
      return response.status;
    },
  });
}

/** Alice with a bit of everything: profile, shelf, brew, recipe, label photos of three bean states, a pending upload, counters. */
async function populate(w: World): Promise<void> {
  expect((await w.call('PUT', '/profile', { json: PROFILE })).status).toBe(200);
  const shelf = ShelfEntrySchema.parse((await w.call('POST', '/shelf', { json: shelfBody() })).body);
  expect((await w.call('POST', '/brews', { json: brewBody(shelf.shelf_entry_id) })).status).toBe(201);
  expect((await w.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
  const s = w.store;
  for (const [photoId, beanId] of [
    [PHOTO_UNVERIFIED, BEAN],
    [PHOTO_VERIFIED, VERIFIED_BEAN],
    [PHOTO_REJECTED, REJECTED_BEAN],
  ] as const) {
    s.userPhotos.set(id(labelPhotoKey(ALICE, photoId)), { beanId, createdAt: 'x' });
    s.beanPhotos.set(id(beanLabelPhotoKey(beanId, photoId)), { createdAt: 'x' });
    s.photoCounts.set(id(labelPhotoCountKey(ALICE, beanId)), 1);
    w.photos.put(`labels/${photoId}.jpg`, 'stripped v1');
    w.photos.put(`labels/${photoId}.jpg`, 'stripped v2');
    w.photos.put(`uploads/${photoId}.jpg`, 'raw');
    w.photos.put(`uploads/${photoId}.jpg`, '', true);
  }
  s.pendingPhotos.set(id(pendingLabelPhotoKey(ALICE, PHOTO_PENDING)), { beanId: BEAN, expiresAt: 2_000_000_000 });
  w.photos.put(`uploads/${PHOTO_PENDING}.jpg`, 'raw');
  s.lookupCounters.set(id(lookupCounterKey(ALICE, '2026-11-25')), 4);
  // Bob, who must be untouched.
  expect((await w.call('POST', '/recipes', { sub: BOB_SUB, json: recipeBody() })).status).toBe(201);
  s.userPhotos.set(id(labelPhotoKey(BOB, PHOTO_BOB)), { beanId: BEAN, createdAt: 'x' });
  s.beanPhotos.set(id(beanLabelPhotoKey(BEAN, PHOTO_BOB)), { createdAt: 'x' });
  w.photos.put(`labels/${PHOTO_BOB}.jpg`, 'bob');
  w.photos.put(`labels/${PHOTO_UNVERIFIED}.jpg.bak`, 'not this key');
  w.journal.length = 0;
}

function logEntries(w: World): { sub: string; photo_ids: string[]; deleted_at: string }[] {
  return w.log
    .keys()
    .flatMap((key) => (w.log.objects.get(key) ?? []).map((version) => JSON.parse(version.body ?? '{}') as { sub: string; photo_ids: string[]; deleted_at: string }));
}

describe('GET and PUT /profile', () => {
  it('GET is 404 before the first PUT; PUT stores and answers 200 with the stored profile; GET then returns it', async () => {
    const h = harness();
    const before = await h.call('GET', '/profile');
    expect(before.status).toBe(404);
    expect(before.result.body).toBeUndefined();
    const put = await h.call('PUT', '/profile', { json: PROFILE });
    expect(put.status).toBe(200);
    expect(ProfileSchema.parse(put.body)).toEqual(PROFILE);
    expect((await h.call('GET', '/profile')).body).toEqual(PROFILE);
    const replaced = { locale: 'de', consent: { contribute_to_aggregates: false } };
    expect((await h.call('PUT', '/profile', { json: replaced })).body).toEqual(replaced);
    expect((await h.call('GET', '/profile')).body).toEqual(replaced);
  });

  it('is the caller’s own: Bob sees no profile of Alice’s, and his PUT changes only his', async () => {
    const h = harness();
    await h.call('PUT', '/profile', { json: PROFILE });
    expect((await h.call('GET', '/profile', { sub: BOB_SUB })).status).toBe(404);
    await h.call('PUT', '/profile', { sub: BOB_SUB, json: { locale: 'de', consent: { contribute_to_aggregates: false } } });
    expect((await h.call('GET', '/profile')).body).toEqual(PROFILE);
  });

  it.each([
    ['an unknown property', { ...PROFILE, sub: BOB_SUB }],
    ['an unknown consent property', { ...PROFILE, consent: { contribute_to_aggregates: true, marketing: true } }],
    ['a locale outside the list', { ...PROFILE, locale: 'fr' }],
    ['a free-text locale', { ...PROFILE, locale: 'English please' }],
    ['no consent', { locale: 'en' }],
    ['no locale', { consent: { contribute_to_aggregates: false } }],
    ['consent as a string', { ...PROFILE, consent: { contribute_to_aggregates: 'yes' } }],
    ['a vocabulary version (not part of Profile)', { ...PROFILE, vocabulary_version: 1 }],
    ['an array', [PROFILE]],
    ['null', null],
  ])('PUT with %s is 400 and stores nothing', async (_name, body) => {
    const h = harness();
    expect((await h.call('PUT', '/profile', { json: body })).status).toBe(400);
    expect(h.store.profiles.size).toBe(0);
  });

  it('PUT needs JSON; a query on either is 400; a body on GET is 400', async () => {
    const h = harness();
    expect((await h.call('PUT', '/profile', { body: JSON.stringify(PROFILE), headers: { 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await h.call('PUT', '/profile', { body: '{"locale":' })).status).toBe(400);
    expect((await h.call('PUT', '/profile', { json: PROFILE, query: 'sub=x' })).status).toBe(400);
    expect((await h.call('GET', '/profile', { query: 'sub=x' })).status).toBe(400);
    expect((await h.call('GET', '/profile', { json: PROFILE })).status).toBe(400);
    expect(h.store.profiles.size).toBe(0);
  });
});

// ---- the tombstone guard (ADR 0017, Addendum) ----

class StubLabelPhotos implements LabelPhotoStore {
  public readonly bucket = PHOTO_BUCKET;
  public readonly written: string[] = [];
  public presignUpload(photoId: string): Promise<PresignedUpload> {
    // The shape createPresignedPost returns; made-up values, not credentials.
    return Promise.resolve({
      url: `https://${PHOTO_BUCKET}.s3.eu-central-1.amazonaws.com/`,
      fields: {
        'Content-Type': 'image/jpeg',
        bucket: PHOTO_BUCKET,
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'TESTACCESSKEYID00000/20261125/eu-central-1/s3/aws4_request',
        'X-Amz-Date': '20261125T120000Z',
        key: `uploads/${photoId}.jpg`,
        Policy: Buffer.from('{}').toString('base64'),
        'X-Amz-Signature': '0'.repeat(64),
      },
    });
  }
  public getUpload(): Promise<UploadRead> {
    return Promise.resolve({ kind: 'found', bytes: minimalJpeg() });
  }
  public putLabel(photoId: string): Promise<void> {
    this.written.push(photoId);
    return Promise.resolve();
  }
}

/** Every write route, with a request that would succeed for a caller without a tombstone. */
interface WriteCase {
  readonly operation: string;
  readonly method: string;
  readonly path: (ids: Ids) => string;
  readonly json?: (ids: Ids) => unknown;
}
interface Ids {
  readonly shelf: string;
  /** A shelf entry without brews, which a delete would remove. */
  readonly emptyShelf: string;
  readonly brew: string;
  readonly recipe: string;
  readonly pending: string;
}

const WRITE_CASES: readonly WriteCase[] = [
  { operation: 'createShelfEntry', method: 'POST', path: () => '/shelf', json: () => shelfBody() },
  { operation: 'replaceShelfEntry', method: 'PUT', path: (ids) => `/shelf/${ids.shelf}`, json: () => shelfBody({ bag_size: 'g_1000' }) },
  { operation: 'deleteShelfEntry', method: 'DELETE', path: (ids) => `/shelf/${ids.emptyShelf}` },
  { operation: 'createBrew', method: 'POST', path: () => '/brews', json: (ids) => brewBody(ids.shelf) },
  { operation: 'replaceBrew', method: 'PUT', path: (ids) => `/brews/${ids.brew}`, json: (ids) => ({ ...brewBody(ids.shelf), brewed_at: '2026-11-26T07:00:00Z' }) },
  { operation: 'deleteBrew', method: 'DELETE', path: (ids) => `/brews/${ids.brew}` },
  { operation: 'createRecipe', method: 'POST', path: () => '/recipes', json: () => recipeBody() },
  { operation: 'replaceRecipe', method: 'PUT', path: (ids) => `/recipes/${ids.recipe}`, json: () => recipeBody({ dose_dg: 180 }) },
  { operation: 'deleteRecipe', method: 'DELETE', path: (ids) => `/recipes/${ids.recipe}` },
  { operation: 'putProfile', method: 'PUT', path: () => '/profile', json: () => PROFILE },
  { operation: 'createBean', method: 'POST', path: () => '/beans', json: () => beanBody({ barcode: EAN13 }) },
  { operation: 'createLabelPhotoUpload', method: 'POST', path: () => `/beans/${BEAN}/label_photos` },
  { operation: 'completeLabelPhoto', method: 'POST', path: (ids) => `/label_photos/${ids.pending}/complete` },
  { operation: 'lookupOpenFoodFacts', method: 'GET', path: () => '/barcodes/4006381333931/open_food_facts' },
];

function guardWorld(): { h: Harness; labels: StubLabelPhotos; fetched: string[] } {
  const store = new FakeStore();
  store.catalogue.set(BEAN, bean(BEAN, 'unverified'));
  const labels = new StubLabelPhotos();
  const fetched: string[] = [];
  const h = harness({
    store,
    labelPhotos: { store: labels },
    openFoodFacts: {
      client: createOpenFoodFactsClient({
        contact: 'operator@example.org',
        fetch: (url) => {
          fetched.push(url);
          const hit = { status: 1, product: { product_name: 'Some Coffee' } };
          return Promise.resolve(new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } }));
        },
      }),
      dailyCap: 50,
    },
    retryDelayMs: () => 0,
  });
  return { h, labels, fetched };
}

async function seed(h: Harness): Promise<Ids> {
  const shelf = ShelfEntrySchema.parse((await h.call('POST', '/shelf', { json: shelfBody() })).body).shelf_entry_id;
  const emptyShelf = ShelfEntrySchema.parse((await h.call('POST', '/shelf', { json: shelfBody() })).body).shelf_entry_id;
  // A pending upload with a known id, and its upload in the stub bucket, for the completion case.
  h.store.photoIds.push('01JDR0000000000000000000D1');
  await h.call('POST', `/beans/${BEAN}/label_photos`);
  const brew = BrewSchema.parse((await h.call('POST', '/brews', { json: brewBody(shelf) })).body).brew_id;
  const recipe = RecipeSchema.parse((await h.call('POST', '/recipes', { json: recipeBody() })).body).recipe_id;
  return { shelf, emptyShelf, brew, recipe, pending: '01JDR0000000000000000000D1' };
}

/** Everything the fake holds, to prove a request wrote nothing. */
function state(store: FakeStore): string {
  return JSON.stringify(
    {
      alice: store.snapshot(ALICE),
      maps: [store.profiles, store.lookupCounters, store.pendingPhotos, store.userPhotos, store.beanPhotos, store.photoCounts, store.uploadCounters, store.catalogue, store.barcodes, store.openFoodFactsCache].map((map) => [
        ...(map as Map<string, unknown>),
      ]),
    },
    (_key, value: unknown) => (value instanceof Set ? [...(value as Set<unknown>)] : value),
  );
}

describe('the tombstone guard: every write of a deleted account is 401, and nothing is written', () => {
  it('covers every route that writes, and only DELETE /account is exempt', () => {
    const writes = ROUTES.filter((route) => route.method !== 'GET' || route.operation === 'lookupOpenFoodFacts').map((route) => route.operation);
    expect([...writes, 'putProfile'].filter((op, i, all) => all.indexOf(op) === i).sort()).toEqual([...WRITE_CASES.map((c) => c.operation), 'deleteAccount'].sort());
  });

  it.each(WRITE_CASES.map((c) => [c.operation, c] as const))('%s', async (_operation, write) => {
    // Without a tombstone the request succeeds (so the 401 below is the guard, not something else).
    {
      const { h } = guardWorld();
      const ids = await seed(h);
      const ok = await h.call(write.method, write.path(ids), write.json === undefined ? {} : { json: write.json(ids) });
      expect(ok.status, 'succeeds without a tombstone').toBeLessThan(300);
      expect(ok.status).toBeGreaterThanOrEqual(200);
    }
    const { h, labels, fetched } = guardWorld();
    const ids = await seed(h);
    fetched.length = 0;
    h.store.tombstones.set(userPk(ALICE), { deletedAt: h.store.now.toISOString(), expiresAt: Math.floor(h.store.now.getTime() / 1000) + 60, photoIds: new Set(), logged: true });
    const before = state(h.store);
    const response = await h.call(write.method, write.path(ids), write.json === undefined ? {} : { json: write.json(ids) });
    expect(response.status).toBe(401);
    expect(response.result.body).toBeUndefined();
    expect(state(h.store)).toBe(before);
    expect(labels.written).toEqual([]);
    expect(fetched).toEqual([]);
    expect(h.logs.at(-1)).toEqual({ operation: write.operation, status: 401, request_id: 'request-1', error: 'AccountDeletedError' });
    // Another caller is not affected.
    expect((await h.call('POST', '/recipes', { sub: BOB_SUB, json: recipeBody() })).status).toBe(201);
  });

  it('reads still answer (the partition is empty after a deletion), and an expired tombstone no longer blocks', async () => {
    const { h } = guardWorld();
    const now = Math.floor(h.store.now.getTime() / 1000);
    h.store.tombstones.set(userPk(ALICE), { deletedAt: 'x', expiresAt: now + 1, photoIds: new Set(), logged: true });
    expect((await h.call('GET', '/recipes')).status).toBe(200);
    expect((await h.call('GET', '/export')).status).toBe(200);
    expect((await h.call('POST', '/recipes', { json: recipeBody() })).status).toBe(401);
    h.store.tombstones.set(userPk(ALICE), { deletedAt: 'x', expiresAt: now, photoIds: new Set(), logged: true });
    expect((await h.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
  });
});

// ---- DELETE /account ----

describe('DELETE /account', () => {
  it('deletes the partition, the photos of beans that are not verified with every version, logs, deletes the user: 204', async () => {
    const w = world();
    await populate(w);
    expect(await w.del()).toBe(204);

    // Nothing of Alice remains in the table.
    expect(w.store.partitionIsEmpty(ALICE)).toBe(true);
    expect((await w.call('GET', '/profile')).status).toBe(404);
    // Bean-side records: gone for the unverified and the rejected bean, kept for the verified bean (D10). Bob's kept.
    expect([...w.store.beanPhotos.keys()].sort()).toEqual([id(beanLabelPhotoKey(BEAN, PHOTO_BOB)), id(beanLabelPhotoKey(VERIFIED_BEAN, PHOTO_VERIFIED))].sort());
    // S3: every version and marker gone, except the verified bean's stored photo, Bob's photo and a key that only shares a prefix.
    expect(w.photos.keys()).toEqual([`labels/${PHOTO_BOB}.jpg`, `labels/${PHOTO_UNVERIFIED}.jpg.bak`, `labels/${PHOTO_VERIFIED}.jpg`].sort());
    expect(w.photos.objects.get(`labels/${PHOTO_VERIFIED}.jpg`)).toHaveLength(2);
    expect(w.photos.sent.filter((c) => c.name === 'DeleteObject').every((c) => typeof c.input.VersionId === 'string')).toBe(true);
    // The log entry: ids only.
    const entries = logEntries(w);
    expect(entries).toEqual([{ sub: ALICE_SUB, photo_ids: [PHOTO_UNVERIFIED, PHOTO_REJECTED, PHOTO_PENDING].sort(), deleted_at: '2026-11-25T12:00:00.000Z' }]);
    expect(w.log.keys()[0]).toMatch(/^entries\/[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    expect(w.log.sent[0]?.input.ContentType).toBe('application/json');
    // The Cognito user: Alice's only.
    expect(w.pool.sent).toEqual([{ UserPoolId: POOL, Username: USERNAME }]);
    expect([...w.pool.users]).toEqual([BOB_USERNAME]);
    // The tombstone stays in force for two hours.
    const tombstone = w.store.tombstones.get(userPk(ALICE));
    expect(tombstone?.expiresAt).toBe(Math.floor(w.store.now.getTime() / 1000) + TOMBSTONE_TTL_SECONDS);
    expect(TOMBSTONE_TTL_SECONDS).toBe(7200);
    // Bob is untouched.
    expect(w.store.partitionIsEmpty(BOB)).toBe(false);
    expect((await w.call('GET', '/recipes', { sub: BOB_SUB })).body).toMatchObject({ items: [{}] });
  });

  it('runs the steps in the order of ADR 0017: tombstone, S3 and bean records, partition, log, Cognito', async () => {
    const w = world();
    await populate(w);
    await w.del();
    const j = w.journal;
    const first = (entry: string): number => j.indexOf(entry);
    const last = (entry: string): number => j.lastIndexOf(entry);
    expect(first('markAccountDeleted')).toBe(0);
    expect(first('recordDeletedPhotos')).toBeLessThan(first('photos:DeleteObject'));
    expect(last('photos:DeleteObject')).toBeLessThan(first('deleteUserPartition'));
    expect(last('deleteBeanLabelPhoto')).toBeLessThan(first('deleteUserPartition'));
    expect(first('deleteUserPartition')).toBeLessThan(first('log:PutObject'));
    expect(first('log:PutObject')).toBeLessThan(first('markDeletionLogged'));
    expect(first('markDeletionLogged')).toBeLessThan(first('cognito:AdminDeleteUser'));
    expect(j.at(-1)).toBe('cognito:AdminDeleteUser');
    // A photo's S3 objects go before its bean record: the bean record is never removed while the photo is still stored.
    expect(j.filter((e) => e === 'deleteBeanLabelPhoto')).toHaveLength(2);
  });

  it('a repeat after the 204 is 204 again and adds nothing: no second log entry, the user already gone counts as success', async () => {
    const w = world();
    await populate(w);
    expect(await w.del()).toBe(204);
    const versions = w.photos.keys();
    expect(await w.del()).toBe(204);
    expect(logEntries(w)).toHaveLength(1);
    expect(w.photos.keys()).toEqual(versions);
    expect(w.pool.sent).toHaveLength(2);
  });

  it('a later write with the same token is 401 and writes nothing; export of the deleted user is the header only', async () => {
    const w = world();
    await populate(w);
    await w.del();
    expect((await w.call('POST', '/recipes', { json: recipeBody() })).status).toBe(401);
    expect((await w.call('PUT', '/profile', { json: PROFILE })).status).toBe(401);
    expect(w.store.partitionIsEmpty(ALICE)).toBe(true);
    const exported = await w.call('GET', '/export');
    expect(exported.status).toBe(200);
    expect((exported.result.body ?? '').split('\r\n')).toHaveLength(2);
  });

  describe('a failure at any step is 500, and the retry finishes the deletion', () => {
    it.each([
      ['listing versions', (w: World) => (w.photos.failWith = (c) => (c.name === 'ListObjectVersions' ? awsError('SlowDown') : undefined))],
      ['deleting a version', (w: World) => (w.photos.failWith = (c) => (c.name === 'DeleteObject' ? awsError('InternalError') : undefined))],
      ['writing the log', (w: World) => (w.log.failWith = () => awsError('AccessDenied'))],
      ['deleting the Cognito user', (w: World) => (w.pool.failWith = awsError('TooManyRequestsException'))],
      [
        'emptying the partition',
        (w: World) => {
          const original = w.store.deleteUserPartition.bind(w.store);
          let calls = 0;
          w.store.deleteUserPartition = (user) => (++calls === 1 ? Promise.reject(Object.assign(new Error('x'), { name: 'DeletionIncompleteError' })) : original(user));
        },
      ],
    ])('%s', async (_step, breakIt) => {
      const w = world();
      await populate(w);
      breakIt(w);
      expect(await w.del()).toBe(500);
      expect(w.logs.at(-1)?.status).toBe(500);
      expect(typeof w.logs.at(-1)?.error).toBe('string');
      // Writes are already refused after the failure.
      expect((await w.call('POST', '/recipes', { json: recipeBody() })).status).toBe(401);
      w.photos.failWith = undefined;
      w.log.failWith = undefined;
      w.pool.failWith = undefined;
      expect(await w.del()).toBe(204);
      expect(w.store.partitionIsEmpty(ALICE)).toBe(true);
      expect(w.photos.keys()).toEqual([`labels/${PHOTO_BOB}.jpg`, `labels/${PHOTO_UNVERIFIED}.jpg.bak`, `labels/${PHOTO_VERIFIED}.jpg`].sort());
      const entries = logEntries(w);
      expect(entries).toHaveLength(1);
      // The photo ids survive a first attempt that already deleted the user-side items: they are on the tombstone.
      expect(entries[0]?.photo_ids).toEqual([PHOTO_UNVERIFIED, PHOTO_REJECTED, PHOTO_PENDING].sort());
      expect(w.pool.users.has(USERNAME)).toBe(false);
    });

    it('a photo recorded by the first attempt is deleted in full on retry even if its bean was verified in between', async () => {
      const w = world();
      await populate(w);
      w.photos.failWith = (c) => (c.name === 'ListObjectVersions' ? awsError('SlowDown') : undefined);
      expect(await w.del()).toBe(500);
      w.store.catalogue.set(BEAN, bean(BEAN, 'verified'));
      w.photos.failWith = undefined;
      expect(await w.del()).toBe(204);
      expect(w.photos.objects.get(`labels/${PHOTO_UNVERIFIED}.jpg`)).toEqual([]);
      expect(w.store.beanPhotos.has(id(beanLabelPhotoKey(BEAN, PHOTO_UNVERIFIED)))).toBe(false);
    });
  });

  it('keeps the earlier tombstone on a retry, moving only its expiry forward; an expired one is replaced', async () => {
    const w = world();
    await populate(w);
    w.pool.failWith = awsError('InternalErrorException');
    expect(await w.del()).toBe(500);
    const first = { ...w.store.tombstones.get(userPk(ALICE)) };
    w.store.now = new Date(w.store.now.getTime() + 30 * 60 * 1000);
    w.pool.failWith = undefined;
    expect(await w.del()).toBe(204);
    const second = w.store.tombstones.get(userPk(ALICE));
    expect(second?.deletedAt).toBe(first.deletedAt);
    expect(second?.expiresAt).toBe((first.expiresAt ?? 0) + 30 * 60);
    expect(logEntries(w)[0]?.deleted_at).toBe(first.deletedAt);
  });

  it.each([
    ['photos', 'PhotoBucketNotConfigured'],
    ['deletionLog', 'DeletionLogNotConfigured'],
    ['users', 'UserPoolNotConfigured'],
  ] as const)('without %s it is 500 %s before anything changes; other routes keep working', async (part, code) => {
    const w = world({ config: { [part]: null } });
    await populate(w);
    expect(await w.del()).toBe(500);
    expect(w.logs.at(-1)).toEqual({ operation: 'deleteAccount', status: 500, request_id: 'request-1', error: code });
    expect(w.journal).toEqual([]);
    expect(w.store.tombstones.size).toBe(0);
    expect((await w.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
  });

  it('without accountDeletion at all it is 500 too', async () => {
    const h = harness();
    expect((await h.call('DELETE', '/account', { username: USERNAME })).status).toBe(500);
    expect(h.store.calls).toEqual([]);
  });

  it('a token without a valid username claim is 500 UsernameMissing before anything changes', async () => {
    const w = world();
    await populate(w);
    for (const request of [{ username: undefined }, { username: 'a b' }, { username: '' }] as RequestOptions[]) {
      const response = await w.call('DELETE', '/account', request);
      expect(response.status).toBe(500);
      expect(w.logs.at(-1)?.error).toBe('UsernameMissing');
    }
    expect(w.journal).toEqual([]);
    expect(w.pool.users.has(USERNAME)).toBe(true);
  });

  it('no token is 401; a query or a body is 400; nothing changes', async () => {
    const w = world();
    await populate(w);
    expect(await w.del({ sub: null })).toBe(401);
    expect(await w.del({ query: 'sub=x' })).toBe(400);
    expect(await w.del({ json: { sub: BOB_SUB } })).toBe(400);
    expect(w.journal).toEqual([]);
  });

  it('the user id and username come from the token only: a planted id deletes nothing of Bob', async () => {
    const w = world();
    await populate(w);
    expect(await w.del({ headers: { 'x-user-id': BOB_SUB, 'x-username': BOB_USERNAME } })).toBe(204);
    expect(w.store.partitionIsEmpty(BOB)).toBe(false);
    expect(w.pool.users.has(BOB_USERNAME)).toBe(true);
    expect(w.store.beanPhotos.has(id(beanLabelPhotoKey(BEAN, PHOTO_BOB)))).toBe(true);
  });

  it('a caller with nothing is 204 and logs an entry without photos', async () => {
    const w = world();
    expect(await w.del()).toBe(204);
    expect(logEntries(w)).toEqual([{ sub: ALICE_SUB, photo_ids: [], deleted_at: '2026-11-25T12:00:00.000Z' }]);
    expect(w.photos.sent).toEqual([]);
  });

  it('logs fixed codes only: never the sub, the username, an id, a key, a bucket, a pool or a count', async () => {
    const w = world();
    await populate(w);
    const start = w.logs.length;
    w.pool.failWith = awsError('InternalErrorException');
    await w.del();
    w.pool.failWith = undefined;
    await w.del();
    await w.del({ username: 'a b' });
    await w.call('GET', '/export');
    await w.call('GET', '/profile');
    await w.call('PUT', '/profile', { json: PROFILE });
    const text = JSON.stringify(w.logs);
    for (const leaked of [
      ALICE_SUB,
      BOB_SUB,
      USERNAME,
      'SignInWithApple',
      PHOTO_UNVERIFIED,
      PHOTO_VERIFIED,
      PHOTO_REJECTED,
      PHOTO_PENDING,
      BEAN,
      VERIFIED_BEAN,
      PHOTO_BUCKET,
      LOG_BUCKET,
      POOL,
      'cupmark-',
      'labels/',
      'uploads/',
      'entries/',
      'DELETED#',
      'USER#',
      'eu-central-1',
    ]) {
      expect(text).not.toContain(leaked);
    }
    for (const entry of w.logs) {
      expect(Object.keys(entry).every((key) => ['operation', 'status', 'request_id', 'error'].includes(key))).toBe(true);
      for (const value of Object.values(entry)) if (typeof value === 'string') expect(value).toMatch(/^[A-Za-z0-9_-]*$/);
    }
    expect(w.logs.slice(start).map((entry) => [entry.operation, entry.status, entry.error])).toEqual([
      ['deleteAccount', 500, 'InternalErrorException'],
      ['deleteAccount', 204, undefined],
      ['deleteAccount', 500, 'UsernameMissing'],
      ['exportData', 200, undefined],
      ['getProfile', 404, undefined],
      ['putProfile', 401, 'AccountDeletedError'],
    ]);
  });
});
