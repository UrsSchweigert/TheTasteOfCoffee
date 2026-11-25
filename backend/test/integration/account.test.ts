// Account deletion, the tombstone guard, the profile and the export (M1-T6;
// ADR 0017 and its Addendum; D10, D11) end to end against DynamoDB Local, with
// the real router and repository, a versioned in-memory photo bucket and
// deletion log (S3 is faked), and a fake Cognito pool. Nothing calls AWS.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s3DeletionLogStore } from '../../src/account/deletion-log.ts';
import { cognitoUserDirectory } from '../../src/account/user-pool.ts';
import { createApi } from '../../src/api/router.ts';
import type { LogEntry } from '../../src/api/router.ts';
import { BrewSchema, RecipeSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { EXPORT_CSV_COLUMNS } from '../../src/generated/export.ts';
import type { LabelPhotoStore, PresignedUpload, UploadRead } from '../../src/images/label-photo-store.ts';
import { s3PhotoDeletionStore } from '../../src/images/photo-deletion-store.ts';
import { createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import { Repository, TOMBSTONE_TTL_SECONDS, beanLabelPhotoKey, beanPk, tombstoneKey, userPk } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent, beanBody, brewBody, recipeBody, shelfBody, testSigner } from '../api/helpers.ts';
import type { RequestOptions } from '../api/helpers.ts';
import { minimalJpeg } from '../images/jpeg-fixtures.ts';
import { FakeUserPool, VersionedBucket } from '../s3-fakes.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();

const PHOTO_BUCKET = 'cupmark-dev-photos-000000000000';
const LOG_BUCKET = 'cupmark-dev-deletion-log-000000000000';
const POOL = 'eu-central-1_TestPool01';
/** Shares all but the last character with ALICE_SUB: a `begins_with` on the key would catch it. */
const ALICIA_SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60719';
const CAROL_SUB = '7c7c7c7c-1111-4222-8333-944444444444';
const ALICE_USERNAME = 'SignInWithApple_000001.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.0001';
const ALICIA_USERNAME = 'SignInWithApple_000002.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.0002';
const BOB_USERNAME = 'SignInWithApple_000003.cccccccccccccccccccccccccccccccc.0003';
const DAVE_SUB = '8d8d8d8d-4444-4555-8666-977777777777';
const DAVE_USERNAME = 'SignInWithApple_000004.dddddddddddddddddddddddddddddddd.0004';

/** A label photo store for the upload routes; nothing it writes is expected in these tests. */
class StubLabelPhotos implements LabelPhotoStore {
  public readonly bucket = PHOTO_BUCKET;
  public readonly written: string[] = [];
  public presignUpload(photoId: string): Promise<PresignedUpload> {
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

describe.skipIf(!local.reachable)('account deletion on DynamoDB Local', () => {
  let tableName = '';
  let repository: Repository;
  let api: ReturnType<typeof createApi>;
  let unverifiedBean = '';
  let verifiedBean = '';
  const logs: LogEntry[] = [];
  const fetched: string[] = [];
  const labelPhotos = new StubLabelPhotos();
  const photos = new VersionedBucket(PHOTO_BUCKET, 3);
  const deletionLog = new VersionedBucket(LOG_BUCKET);
  const pool = new FakeUserPool(POOL, [ALICE_USERNAME, ALICIA_USERNAME, BOB_USERNAME, DAVE_USERNAME]);
  const { client, documentClient } = local;

  async function call(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: unknown; text: string | undefined }> {
    const result = await api(apiEvent(method, path, options));
    const text = result.body;
    const json = String(result.headers?.['content-type'] ?? '').startsWith('application/json');
    return { status: result.statusCode ?? 0, text, body: text === undefined || !json ? undefined : (JSON.parse(text) as unknown) };
  }

  async function partition(sub: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': userPk(verifiedUserId(sub)) },
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      start = result.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  async function wholeTable(): Promise<string> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const result = await documentClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      start = result.LastEvaluatedKey;
    } while (start !== undefined);
    const key = (item: Record<string, unknown>): string => `${String(item.pk)}|${String(item.sk)}`;
    return JSON.stringify(
      items.sort((a, b) => (key(a) < key(b) ? -1 : 1)),
      (_k, value: unknown) => (value instanceof Set ? [...(value as Set<unknown>)].sort() : value),
    );
  }

  /** Completes a label photo for `sub` through the repository and puts versions of both S3 keys in the photo bucket. */
  async function labelPhoto(sub: string, beanId: string): Promise<string> {
    const user = verifiedUserId(sub);
    const photoId = await repository.createPendingLabelPhoto(user, beanId);
    await repository.completeLabelPhoto(user, photoId, beanId);
    photos.put(`labels/${photoId}.jpg`, 'stripped v1');
    photos.put(`labels/${photoId}.jpg`, '', true);
    photos.put(`labels/${photoId}.jpg`, 'stripped v2');
    photos.put(`uploads/${photoId}.jpg`, 'raw');
    photos.put(`uploads/${photoId}.jpg`, '', true);
    return photoId;
  }

  /** A user with a bit of everything. Returns the photo ids. */
  async function populate(sub: string): Promise<{ unverified: string; verified: string; pending: string }> {
    const user = verifiedUserId(sub);
    expect((await call('PUT', '/profile', { sub, json: { locale: 'de', consent: { contribute_to_aggregates: true } } })).status).toBe(200);
    const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: unverifiedBean }) })).body);
    // Enough brews for the deletion to need more than one batch of 25 (each brew is two items).
    for (let i = 0; i < 14; i += 1) {
      const brew = { ...brewBody(shelf.shelf_entry_id), brewed_at: `2026-11-${String(10 + i)}T07:00:00Z` };
      expect((await call('POST', '/brews', { sub, json: brew })).status).toBe(201);
    }
    expect((await call('POST', '/recipes', { sub, json: recipeBody() })).status).toBe(201);
    const unverified = await labelPhoto(sub, unverifiedBean);
    const verified = await labelPhoto(sub, verifiedBean);
    const pending = await repository.createPendingLabelPhoto(user, unverifiedBean);
    photos.put(`uploads/${pending}.jpg`, 'raw');
    expect(await repository.countLookup(user, 50)).toBe(true);
    expect(await repository.countLabelPhotoUpload(user, 50)).toBe(true);
    return { unverified, verified, pending };
  }

  beforeAll(async () => {
    tableName = await createTestTable(client);
    repository = new Repository({ client: documentClient, tableName });
    unverifiedBean = (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    verifiedBean = (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    // The bean's photo record is written while it is unverified; the operator verifies it afterwards.
    const signer = testSigner();
    const photoStore = s3PhotoDeletionStore(photos.client, PHOTO_BUCKET);
    const logStore = s3DeletionLogStore(deletionLog.client, LOG_BUCKET);
    const users = cognitoUserDirectory(pool.client, POOL);
    if (photoStore === undefined || logStore === undefined || users === undefined) throw new Error('configuration');
    api = createApi({
      store: repository,
      cursorSigner: () => Promise.resolve(signer),
      labelPhotos: { store: labelPhotos },
      openFoodFacts: {
        client: createOpenFoodFactsClient({
          contact: 'operator@example.org',
          fetch: (url) => {
            fetched.push(url);
            return Promise.resolve(new Response(JSON.stringify({ status: 1, product: { product_name: 'X' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
          },
        }),
        dailyCap: 50,
      },
      accountDeletion: { photos: photoStore, deletionLog: logStore, users },
      log: (entry) => logs.push(entry),
      retryDelayMs: () => 0,
    });
  });

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  it('GET /profile is 404 before the first PUT, then the stored profile', async () => {
    expect((await call('GET', '/profile', { sub: CAROL_SUB })).status).toBe(404);
    const profile = { locale: 'en', consent: { contribute_to_aggregates: false } };
    expect((await call('PUT', '/profile', { sub: CAROL_SUB, json: profile })).body).toEqual(profile);
    expect((await call('GET', '/profile', { sub: CAROL_SUB })).body).toEqual(profile);
    const stored = await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: userPk(verifiedUserId(CAROL_SUB)), sk: 'PROFILE' }, ConsistentRead: true }));
    expect(stored.Item).toMatchObject({ type: 'PROFILE', values: profile });
  });

  it('deletes everything of the user, and nothing of anyone else', async () => {
    // Alicia's sub shares a prefix with Alice's; Bob is unrelated.
    const alice = await populate(ALICE_SUB);
    // The photo records of the verified bean exist before the bean is verified (completion needs an unverified bean).
    await repository.verifyBean(verifiedBean);
    const alicia = await labelPhoto(ALICIA_SUB, unverifiedBean);
    expect((await call('POST', '/recipes', { sub: ALICIA_SUB, json: recipeBody() })).status).toBe(201);
    expect((await call('POST', '/recipes', { sub: BOB_SUB, json: recipeBody() })).status).toBe(201);
    const aliciaBefore = await partition(ALICIA_SUB);
    const bobBefore = await partition(BOB_SUB);
    expect((await partition(ALICE_SUB)).length).toBeGreaterThan(30);

    // An export before the deletion has every kind of row.
    const before = await call('GET', '/export');
    expect(before.status).toBe(200);
    expect((before.text ?? '').split('\r\n').length - 2).toBe(1 + 1 + 14 + 1 + 2);

    expect((await call('DELETE', '/account', { username: ALICE_USERNAME })).status).toBe(204);

    // Nothing of Alice remains in USER#<sub>.
    expect(await partition(ALICE_SUB)).toEqual([]);
    // Bean-side records: the unverified bean's photo is gone, the verified bean's stays (D10).
    const beanSide = async (beanId: string, photoId: string): Promise<unknown> =>
      (await documentClient.send(new GetCommand({ TableName: tableName, Key: beanLabelPhotoKey(beanId, photoId), ConsistentRead: true }))).Item;
    expect(await beanSide(unverifiedBean, alice.unverified)).toBeUndefined();
    expect(await beanSide(verifiedBean, alice.verified)).toBeDefined();
    expect(await beanSide(unverifiedBean, alicia)).toBeDefined();
    // S3: every version and marker of the unverified photo, both keys, and of the pending upload; the raw upload of the verified one.
    for (const key of [`labels/${alice.unverified}.jpg`, `uploads/${alice.unverified}.jpg`, `uploads/${alice.pending}.jpg`, `uploads/${alice.verified}.jpg`]) {
      expect(photos.objects.get(key) ?? [], key).toEqual([]);
    }
    expect(photos.objects.get(`labels/${alice.verified}.jpg`)).toHaveLength(3);
    expect(photos.objects.get(`labels/${alicia}.jpg`)).toHaveLength(3);
    const deletes = photos.sent.filter((c) => c.name === 'DeleteObject');
    expect(deletes).toHaveLength(3 + 2 + 2 + 1);
    expect(deletes.every((c) => typeof c.input.VersionId === 'string')).toBe(true);
    expect(deletes.some((c) => String(c.input.Key).includes(alicia))).toBe(false);
    // The deletion log: one entry with ids only.
    expect(deletionLog.keys()).toHaveLength(1);
    const entry = JSON.parse(deletionLog.objects.get(deletionLog.keys()[0] ?? '')?.[0]?.body ?? '{}') as Record<string, unknown>;
    expect(entry).toEqual({ sub: ALICE_SUB, photo_ids: [alice.unverified, alice.pending].sort(), deleted_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown });
    // Cognito: Alice only.
    expect(pool.sent).toEqual([{ UserPoolId: POOL, Username: ALICE_USERNAME }]);
    expect(pool.users.has(ALICE_USERNAME)).toBe(false);
    expect(pool.users.has(ALICIA_USERNAME) && pool.users.has(BOB_USERNAME)).toBe(true);
    // The tombstone, in its own partition, about 2 hours ahead.
    const tombstone = (await documentClient.send(new GetCommand({ TableName: tableName, Key: tombstoneKey(verifiedUserId(ALICE_SUB)), ConsistentRead: true }))).Item;
    expect(tombstone).toMatchObject({ type: 'ACCOUNT_TOMBSTONE', loggedAt: expect.any(String) as unknown });
    const now = Math.floor(Date.now() / 1000);
    expect(Number(tombstone?.expires_at)).toBeGreaterThan(now + TOMBSTONE_TTL_SECONDS - 60);
    expect(Number(tombstone?.expires_at)).toBeLessThanOrEqual(now + TOMBSTONE_TTL_SECONDS);
    // Everyone else is untouched, including the user whose sub shares a prefix.
    expect(await partition(ALICIA_SUB)).toEqual(aliciaBefore);
    expect(await partition(BOB_SUB)).toEqual(bobBefore);
    // Catalogue items of both beans are still there.
    const meta = await documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': beanPk(verifiedBean) } }));
    expect(meta.Items?.some((item) => item.sk === 'META')).toBe(true);

    // A later write with the same token is 401 and writes nothing; reads see nothing.
    const table = await wholeTable();
    expect((await call('POST', '/recipes', { json: recipeBody() })).status).toBe(401);
    expect((await call('PUT', '/profile', { json: { locale: 'en', consent: { contribute_to_aggregates: true } } })).status).toBe(401);
    expect((await call('POST', '/beans', { json: beanBody() })).status).toBe(401);
    expect(await wholeTable()).toBe(table);
    expect((await call('GET', '/profile')).status).toBe(404);
    // Export of the deleted user: the header only.
    const exported = await call('GET', '/export');
    expect(exported.status).toBe(200);
    expect(exported.text).toBe(`${EXPORT_CSV_COLUMNS.map((c) => `"${c}"`).join(',')}\r\n`);

    // A repeat is 204 again, with no second log entry and nothing else deleted.
    const sentBefore = photos.sent.length;
    expect((await call('DELETE', '/account', { username: ALICE_USERNAME })).status).toBe(204);
    expect(deletionLog.keys()).toHaveLength(1);
    expect(photos.sent.slice(sentBefore).filter((c) => c.name === 'DeleteObject')).toEqual([]);
    expect(await partition(ALICIA_SUB)).toEqual(aliciaBefore);
  });

  describe('the tombstone guard: a write while the account is being deleted is 401, and nothing is written', () => {
    let ids: { shelf: string; emptyShelf: string; brew: string; recipe: string; pending: string } = { shelf: '', emptyShelf: '', brew: '', recipe: '', pending: '' };
    const sub = '5e5e5e5e-2222-4333-8444-955555555555';

    beforeAll(async () => {
      // Items exist (a deletion has started but not emptied the partition yet, or an old token races it).
      const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: unverifiedBean }) })).body).shelf_entry_id;
      const emptyShelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: unverifiedBean }) })).body).shelf_entry_id;
      const brew = BrewSchema.parse((await call('POST', '/brews', { sub, json: brewBody(shelf) })).body).brew_id;
      const recipe = RecipeSchema.parse((await call('POST', '/recipes', { sub, json: recipeBody() })).body).recipe_id;
      const pending = await repository.createPendingLabelPhoto(verifiedUserId(sub), unverifiedBean);
      ids = { shelf, emptyShelf, brew, recipe, pending };
      await repository.markAccountDeleted(verifiedUserId(sub));
      fetched.length = 0;
    });

    const writes: [operation: string, method: string, path: () => string, json: (() => unknown) | undefined][] = [
      ['createShelfEntry', 'POST', () => '/shelf', () => shelfBody({ bean_id: unverifiedBean })],
      ['replaceShelfEntry', 'PUT', () => `/shelf/${ids.shelf}`, () => shelfBody({ bean_id: unverifiedBean, bag_size: 'g_1000' })],
      ['deleteShelfEntry', 'DELETE', () => `/shelf/${ids.emptyShelf}`, undefined],
      ['createBrew', 'POST', () => '/brews', () => brewBody(ids.shelf)],
      ['replaceBrew', 'PUT', () => `/brews/${ids.brew}`, () => ({ ...brewBody(ids.shelf), brewed_at: '2026-11-26T07:00:00Z' })],
      ['deleteBrew', 'DELETE', () => `/brews/${ids.brew}`, undefined],
      ['createRecipe', 'POST', () => '/recipes', () => recipeBody()],
      ['replaceRecipe', 'PUT', () => `/recipes/${ids.recipe}`, () => recipeBody({ dose_dg: 180 })],
      ['deleteRecipe', 'DELETE', () => `/recipes/${ids.recipe}`, undefined],
      ['putProfile', 'PUT', () => '/profile', () => ({ locale: 'en', consent: { contribute_to_aggregates: true } })],
      ['createBean', 'POST', () => '/beans', () => beanBody({ barcode: '4006381333931' })],
      ['createLabelPhotoUpload', 'POST', () => `/beans/${unverifiedBean}/label_photos`, undefined],
      ['completeLabelPhoto', 'POST', () => `/label_photos/${ids.pending}/complete`, undefined],
      ['lookupOpenFoodFacts', 'GET', () => '/barcodes/4006381333931/open_food_facts', undefined],
    ];

    it.each(writes)('%s', async (operation, method, path, json) => {
      const table = await wholeTable();
      const response = await call(method, path(), { sub, ...(json === undefined ? {} : { json: json() }) });
      expect(response.status).toBe(401);
      expect(response.text).toBeUndefined();
      expect(await wholeTable()).toBe(table);
      expect(labelPhotos.written).toEqual([]);
      expect(fetched).toEqual([]);
      expect(logs.at(-1)).toEqual({ operation, status: 401, request_id: 'request-1', error: 'AccountDeletedError' });
    });

    it('an expired tombstone no longer blocks', async () => {
      const other = '6f6f6f6f-3333-4444-8555-966666666666';
      // Written by a clock just over TOMBSTONE_TTL_SECONDS ago; the API's repository uses the real clock.
      const expired = new Repository({ client: documentClient, tableName, now: () => new Date(Date.now() - (TOMBSTONE_TTL_SECONDS + 1) * 1000) });
      await expired.markAccountDeleted(verifiedUserId(other));
      expect((await call('POST', '/recipes', { sub: other, json: recipeBody() })).status).toBe(201);
    });
  });

  it('a completion that races the deletion leaves no labels/ copy behind', async () => {
    const dave = verifiedUserId(DAVE_SUB);
    const photoId = await repository.createPendingLabelPhoto(dave, unverifiedBean);
    photos.put(`uploads/${photoId}.jpg`, 'raw');
    let deletion = 0;
    const racing: { api?: ReturnType<typeof createApi> } = {};
    // The photo bucket as the completion sees it; the deletion runs inside putLabel, before the copy is written.
    const racingLabels: LabelPhotoStore = {
      bucket: PHOTO_BUCKET,
      presignUpload: () => Promise.reject(new Error('not used')),
      getUpload: () => Promise.resolve({ kind: 'found', bytes: minimalJpeg() }),
      putLabel: async (id) => {
        const result = await racing.api?.(apiEvent('DELETE', '/account', { sub: DAVE_SUB, username: DAVE_USERNAME }));
        deletion = result?.statusCode ?? 0;
        photos.put(`labels/${id}.jpg`, 'stripped');
      },
    };
    const photoStore = s3PhotoDeletionStore(photos.client, PHOTO_BUCKET);
    const logStore = s3DeletionLogStore(deletionLog.client, LOG_BUCKET);
    const users = cognitoUserDirectory(pool.client, POOL);
    if (photoStore === undefined || logStore === undefined || users === undefined) throw new Error('configuration');
    const raceLogs: LogEntry[] = [];
    const racingApi = createApi({
      store: repository,
      cursorSigner: () => Promise.resolve(testSigner()),
      labelPhotos: { store: racingLabels, cleanup: photoStore },
      accountDeletion: { photos: photoStore, deletionLog: logStore, users },
      log: (entry) => raceLogs.push(entry),
      retryDelayMs: () => 0,
    });
    racing.api = racingApi;
    const result = await racingApi(apiEvent('POST', `/label_photos/${photoId}/complete`, { sub: DAVE_SUB }));
    expect(deletion).toBe(204);
    expect(result.statusCode).toBe(401);
    expect(raceLogs.at(-1)).toEqual({ operation: 'completeLabelPhoto', status: 401, request_id: 'request-1', error: 'AccountDeletedError', reason: 'label_deleted' });
    expect(photos.keys().filter((key) => key.includes(photoId))).toEqual([]);
    expect(await partition(DAVE_SUB)).toEqual([]);
    expect((await documentClient.send(new GetCommand({ TableName: tableName, Key: beanLabelPhotoKey(unverifiedBean, photoId), ConsistentRead: true }))).Item).toBeUndefined();
  });
});
