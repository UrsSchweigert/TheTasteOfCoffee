// The repository against DynamoDB Local (M1-T3): every item type round-trips,
// conditional writes fail as documented, the review-queue index is sparse, and
// one user cannot read, change, delete or list another user's items.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITE_ATTEMPTS } from '../../src/api/router.ts';
import type { UserId } from '../../src/auth/user-id.ts';
import { BrewInputSchema, ProfileSchema, RecipeInputSchema, ShelfEntryInputSchema } from '../../src/generated/contract.ts';
import type { BrewInput, RecipeInput, ShelfEntryInput } from '../../src/generated/contract.ts';
import { newUlid } from '../../src/ids/ulid.ts';
import {
  BarcodeTakenError,
  BeanNotFoundError,
  BeanNotUnverifiedError,
  CorruptItemError,
  InvalidCursorError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  REVIEW_QUEUE_INDEX,
  REVIEW_QUEUE_PK,
  Repository,
  ShelfEntryBeanLockedError,
  ShelfEntryInUseError,
  ShelfEntryNotFoundError,
  WriteConflictError,
  aggregateAllKey,
  aggregateMethodKey,
  barcodeKey,
  beanMetaKey,
  brewRefKey,
  rankingKey,
  shelfEntryKey,
  userPk,
} from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { validBrewInput } from '../fixtures.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();

const ALICE = verifiedUserId('3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718');
const BOB = verifiedUserId('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
/** A catalogue bean, created in beforeAll: a shelf entry needs its bean to exist. */
let BEAN_ID = '';

function shelfInput(overrides: Partial<ShelfEntryInput> = {}): ShelfEntryInput {
  return ShelfEntryInputSchema.parse({
    vocabulary_version: 1,
    bean_id: BEAN_ID,
    purchase_date: '2026-11-20',
    roast_date: '2026-11-10',
    bag_size: 'g_250',
    price_band: 'from_15_to_30',
    ...overrides,
  });
}

function brewInput(shelfEntryId: string, brewedAt: string, overall = 8): BrewInput {
  const input = validBrewInput();
  const rating = input.rating as { scores: Record<string, number> };
  rating.scores.overall = overall;
  return BrewInputSchema.parse({ ...input, shelf_entry_id: shelfEntryId, brewed_at: brewedAt });
}

function recipeInput(dose = 150): RecipeInput {
  return RecipeInputSchema.parse({ vocabulary_version: 1, parameters: { method: 'aeropress', dose_dg: dose, water_g: 200 } });
}

describe.skipIf(!local.reachable)('repository on DynamoDB Local', () => {
  let tableName = '';
  let repo: Repository;
  const { client, documentClient } = local;

  /** Every item in a partition, read directly from the table. */
  async function partition(pk: string): Promise<Record<string, unknown>[]> {
    const result = await documentClient.send(
      new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk } }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  async function raw(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    return result.Item as Record<string, unknown> | undefined;
  }

  async function reviewQueue(): Promise<string[]> {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: REVIEW_QUEUE_INDEX.indexName,
        KeyConditionExpression: 'gsi1pk = :q',
        ExpressionAttributeValues: { ':q': REVIEW_QUEUE_PK },
      }),
    );
    return (result.Items ?? []).map((item) => String(item.beanId));
  }

  /** A repository whose clock and ids the test controls. */
  function repoWith(options: { now?: () => Date; newId?: (now: Date) => string }): Repository {
    return new Repository({ client: documentClient, tableName, ...options });
  }

  beforeAll(async () => {
    tableName = await createTestTable(client);
    repo = new Repository({ client: documentClient, tableName });
    BEAN_ID = (await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
  });

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  describe('profile', () => {
    it('is absent, then created, then replaced', async () => {
      const user = verifiedUserId('11111111-1111-4111-8111-111111111111');
      expect(await repo.getProfile(user)).toBeUndefined();
      const first = ProfileSchema.parse({ locale: 'de', consent: { contribute_to_aggregates: true } });
      expect(await repo.putProfile(user, first)).toEqual(first);
      expect(await repo.getProfile(user)).toEqual(first);
      const second = ProfileSchema.parse({ locale: 'en', consent: { contribute_to_aggregates: false } });
      await repo.putProfile(user, second);
      expect(await repo.getProfile(user)).toEqual(second);
      expect((await raw({ pk: userPk(user), sk: 'PROFILE' }))?.type).toBe('PROFILE');
    });

    it('keeps other profile attributes (the entitlement, M4) when consent and locale change', async () => {
      const user = verifiedUserId('22222222-2222-4222-8222-222222222222');
      await repo.putProfile(user, { locale: 'de', consent: { contribute_to_aggregates: true } });
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: userPk(user), sk: 'PROFILE' },
          UpdateExpression: 'SET entitlement = :e',
          ExpressionAttributeValues: { ':e': 'paid' },
        }),
      );
      await repo.putProfile(user, { locale: 'en', consent: { contribute_to_aggregates: true } });
      expect((await raw({ pk: userPk(user), sk: 'PROFILE' }))?.entitlement).toBe('paid');
    });
  });

  describe('shelf entries', () => {
    it('round-trip: create, get, replace, list, delete', async () => {
      const user = verifiedUserId('33333333-3333-4333-8333-333333333333');
      const created = await repo.createShelfEntry(user, shelfInput());
      expect(created.values).toEqual(shelfInput());
      expect(await repo.getShelfEntry(user, created.shelf_entry_id)).toEqual(created);

      const stored = await raw(shelfEntryKey(user, created.shelf_entry_id));
      expect(stored).toMatchObject({ type: 'SHELF', beanId: BEAN_ID, purchaseDate: '2026-11-20' });

      const replaced = await repo.replaceShelfEntry(user, created.shelf_entry_id, shelfInput({ price_band: 'from_80' }));
      expect(replaced.values.price_band).toBe('from_80');
      expect(await repo.getShelfEntry(user, created.shelf_entry_id)).toEqual(replaced);
      expect((await raw(shelfEntryKey(user, created.shelf_entry_id)))?.createdAt).toBe(stored?.createdAt);

      expect((await repo.listShelfEntries(user)).items).toEqual([replaced]);
      await repo.deleteShelfEntry(user, created.shelf_entry_id);
      expect(await repo.getShelfEntry(user, created.shelf_entry_id)).toBeUndefined();
      expect(await partition(userPk(user))).toEqual([]);
    });

    it('keeps two purchases of the same bean on the same day apart (ADR 0010)', async () => {
      const user = verifiedUserId('44444444-4444-4444-8444-444444444444');
      const a = await repo.createShelfEntry(user, shelfInput());
      const b = await repo.createShelfEntry(user, shelfInput());
      expect(a.shelf_entry_id).not.toBe(b.shelf_entry_id);
      expect((await repo.listShelfEntries(user)).items).toHaveLength(2);
    });

    it('create is conditional on the item not existing', async () => {
      const user = verifiedUserId('55555555-5555-4555-8555-555555555555');
      const fixed = newUlid();
      const sameId = repoWith({ newId: () => fixed });
      await sameId.createShelfEntry(user, shelfInput());
      await expect(sameId.createShelfEntry(user, shelfInput({ price_band: 'from_80' }))).rejects.toThrow(ItemExistsError);
      expect((await repo.getShelfEntry(user, fixed))?.values.price_band).toBe('from_15_to_30');
    });

    it('replace and delete are conditional on the item existing', async () => {
      const user = verifiedUserId('66666666-6666-4666-8666-666666666666');
      const missing = newUlid();
      await expect(repo.replaceShelfEntry(user, missing, shelfInput())).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteShelfEntry(user, missing)).rejects.toThrow(ItemNotFoundError);
      // The failed replace must not have created the item (no upsert).
      expect(await partition(userPk(user))).toEqual([]);
    });

    it('pages with cursors, newest first', async () => {
      const user = verifiedUserId('77777777-7777-4777-8777-777777777777');
      let t = Date.UTC(2026, 10, 1);
      const ticking = repoWith({ now: () => new Date((t += 1000)) });
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await ticking.createShelfEntry(user, shelfInput())).shelf_entry_id);
      const first = await repo.listShelfEntries(user, { limit: 2 });
      expect(first.items.map((e) => e.shelf_entry_id)).toEqual([ids[4], ids[3]]);
      expect(first.nextCursor).toBeDefined();
      const second = await repo.listShelfEntries(user, { limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
      expect(second.items.map((e) => e.shelf_entry_id)).toEqual([ids[2], ids[1]]);
      const third = await repo.listShelfEntries(user, { limit: 2, ...(second.nextCursor ? { cursor: second.nextCursor } : {}) });
      expect(third.items.map((e) => e.shelf_entry_id)).toEqual([ids[0]]);
      await expect(repo.listShelfEntries(user, { cursor: 'not!a!cursor' })).rejects.toThrow(InvalidCursorError);
      await expect(repo.listShelfEntries(user, { limit: 101 })).rejects.toThrow();
    });
  });

  describe('brews', () => {
    it('round-trip: create, get by id, replace, delete; brew and pointer move together', async () => {
      const user = verifiedUserId('88888888-8888-4888-8888-888888888888');
      const shelf = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const shelfSk = `SHELF#${shelf}`;
      const created = await repo.createBrew(user, brewInput(shelf, '2026-11-25T07:30:00.250+01:00'));
      expect(await repo.getBrew(user, created.brew_id)).toEqual(created);

      const items = await partition(userPk(user));
      expect(items.map((i) => i.sk).sort()).toEqual(
        [`BREW#2026-11-25T06:30:00.250Z#${created.brew_id}`, `BREWID#${created.brew_id}`, shelfSk].sort(),
      );
      expect(items.find((i) => i.type === 'BREW')).toMatchObject({ values: created.values, shelfEntryId: shelf, beanId: BEAN_ID });
      expect((await raw(shelfEntryKey(user, shelf)))?.brewCount).toBe(1);

      // Same time: updated in place.
      const sameTime = await repo.replaceBrew(user, created.brew_id, brewInput(shelf, '2026-11-25T07:30:00.250+01:00', 9));
      expect((await repo.getBrew(user, created.brew_id))?.values.rating?.scores.overall).toBe(9);
      expect(sameTime.brew_id).toBe(created.brew_id);

      // New time: the brew item moves to its new sort key, the pointer follows.
      await repo.replaceBrew(user, created.brew_id, brewInput(shelf, '2026-11-26T08:00:00Z', 6));
      const moved = await partition(userPk(user));
      expect(moved.map((i) => i.sk).sort()).toEqual(
        [`BREW#2026-11-26T08:00:00.000Z#${created.brew_id}`, `BREWID#${created.brew_id}`, shelfSk].sort(),
      );
      expect((await raw(shelfEntryKey(user, shelf)))?.brewCount).toBe(1);
      expect((await raw(brewRefKey(user, created.brew_id)))?.brewSk).toBe(`BREW#2026-11-26T08:00:00.000Z#${created.brew_id}`);
      const read = await repo.getBrew(user, created.brew_id);
      expect(read?.values.brewed_at).toBe('2026-11-26T08:00:00Z');
      expect(read?.values.rating?.scores.overall).toBe(6);

      await repo.deleteBrew(user, created.brew_id);
      expect(await repo.getBrew(user, created.brew_id)).toBeUndefined();
      expect((await partition(userPk(user))).map((i) => i.sk)).toEqual([shelfSk]);
      expect((await raw(shelfEntryKey(user, shelf)))?.brewCount).toBe(0);
    });

    it('lists newest brewed_at first, whatever the creation order or offset, and pages', async () => {
      const user = verifiedUserId('99999999-9999-4999-8999-999999999999');
      const shelf = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const times = ['2026-11-20T10:00:00Z', '2026-11-25T10:00:00+05:00', '2026-11-22T10:00:00Z', '2026-11-25T06:00:00Z'];
      const ids = new Map<string, string>();
      for (const t of times) ids.set(t, (await repo.createBrew(user, brewInput(shelf, t))).brew_id);
      const order = ['2026-11-25T06:00:00Z', '2026-11-25T10:00:00+05:00', '2026-11-22T10:00:00Z', '2026-11-20T10:00:00Z'];
      const all = await repo.listBrews(user);
      expect(all.items.map((b) => b.values.brewed_at)).toEqual(order);
      expect(all.items.map((b) => b.brew_id)).toEqual(order.map((t) => ids.get(t)));

      const page1 = await repo.listBrews(user, { limit: 3 });
      expect(page1.items).toHaveLength(3);
      const page2 = await repo.listBrews(user, { limit: 3, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) });
      expect(page2.items.map((b) => b.values.brewed_at)).toEqual([order[3]]);
      // The pointer items are never listed as brews.
      await expect(repo.listBrews(user, { cursor: Buffer.from(`BREWID#${String(ids.get(order[0] ?? ''))}`).toString('base64url') })).rejects.toThrow(
        InvalidCursorError,
      );
    });

    it('create is conditional; replace and delete need the brew to exist', async () => {
      const user = verifiedUserId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const shelf = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const fixed = newUlid();
      const sameId = repoWith({ newId: () => fixed });
      await sameId.createBrew(user, brewInput(shelf, '2026-11-25T07:00:00Z'));
      // Same id at another time: the pointer exists, so nothing is written, and the count stays.
      await expect(sameId.createBrew(user, brewInput(shelf, '2026-11-24T07:00:00Z'))).rejects.toThrow(ItemExistsError);
      expect(await partition(userPk(user))).toHaveLength(3);
      expect((await raw(shelfEntryKey(user, shelf)))?.brewCount).toBe(1);

      const missing = newUlid();
      await expect(repo.replaceBrew(user, missing, brewInput(shelf, '2026-11-25T07:00:00Z'))).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteBrew(user, missing)).rejects.toThrow(ItemNotFoundError);
      expect(await partition(userPk(user))).toHaveLength(3);
    });
  });

  describe('references (ADR 0012)', () => {
    it('a shelf entry needs its bean in the catalogue, on create and on replace', async () => {
      const user = verifiedUserId('d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1');
      await expect(repo.createShelfEntry(user, shelfInput({ bean_id: newUlid() }))).rejects.toThrow(BeanNotFoundError);
      expect(await partition(userPk(user))).toEqual([]);
      const entry = await repo.createShelfEntry(user, shelfInput());
      await expect(repo.replaceShelfEntry(user, entry.shelf_entry_id, shelfInput({ bean_id: newUlid() }))).rejects.toThrow(
        BeanNotFoundError,
      );
      expect((await repo.getShelfEntry(user, entry.shelf_entry_id))?.values.bean_id).toBe(BEAN_ID);
    });

    it('a brew needs a shelf entry in the caller’s own partition', async () => {
      const user = verifiedUserId('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2');
      await expect(repo.createBrew(user, brewInput(newUlid(), '2026-11-25T07:00:00Z'))).rejects.toThrow(ShelfEntryNotFoundError);
      const alices = await repo.createShelfEntry(ALICE, shelfInput());
      await expect(repo.createBrew(user, brewInput(alices.shelf_entry_id, '2026-11-25T07:00:00Z'))).rejects.toThrow(
        ShelfEntryNotFoundError,
      );
      expect(await partition(userPk(user))).toEqual([]);
      expect((await raw(shelfEntryKey(ALICE, alices.shelf_entry_id)))?.brewCount).toBe(0);
    });

    it('a shelf entry with brews cannot be deleted; once they are gone it can', async () => {
      const user = verifiedUserId('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const a = await repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'));
      const b = await repo.createBrew(user, brewInput(entry, '2026-11-25T08:00:00Z'));
      expect((await raw(shelfEntryKey(user, entry)))?.brewCount).toBe(2);
      await expect(repo.deleteShelfEntry(user, entry)).rejects.toThrow(ShelfEntryInUseError);
      await repo.deleteBrew(user, a.brew_id);
      await expect(repo.deleteShelfEntry(user, entry)).rejects.toThrow(ShelfEntryInUseError);
      await repo.deleteBrew(user, b.brew_id);
      await repo.deleteShelfEntry(user, entry);
      expect(await partition(userPk(user))).toEqual([]);
    });

    it('moving a brew to another shelf entry moves the count; a missing target changes nothing', async () => {
      const user = verifiedUserId('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4');
      const first = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const second = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const brew = await repo.createBrew(user, brewInput(first, '2026-11-25T07:00:00Z'));
      const before = await partition(userPk(user));
      await expect(repo.replaceBrew(user, brew.brew_id, brewInput(newUlid(), '2026-11-25T07:00:00Z'))).rejects.toThrow(
        ShelfEntryNotFoundError,
      );
      expect(await partition(userPk(user))).toEqual(before);

      // Same time, other entry.
      await repo.replaceBrew(user, brew.brew_id, brewInput(second, '2026-11-25T07:00:00Z'));
      expect((await raw(shelfEntryKey(user, first)))?.brewCount).toBe(0);
      expect((await raw(shelfEntryKey(user, second)))?.brewCount).toBe(1);
      // Other time, back to the first entry: the brew item moves and so does the count.
      await repo.replaceBrew(user, brew.brew_id, brewInput(first, '2026-11-26T07:00:00Z'));
      expect((await raw(shelfEntryKey(user, first)))?.brewCount).toBe(1);
      expect((await raw(shelfEntryKey(user, second)))?.brewCount).toBe(0);
      const stored = (await partition(userPk(user))).find((i) => i.type === 'BREW');
      expect(stored).toMatchObject({ shelfEntryId: first, beanId: BEAN_ID });
      await repo.deleteShelfEntry(user, second);
      await expect(repo.deleteShelfEntry(user, first)).rejects.toThrow(ShelfEntryInUseError);
    });

    it('the brew records the bean of its shelf entry at the time of the write', async () => {
      const user = verifiedUserId('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5');
      const other = (await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
      const entry = (await repo.createShelfEntry(user, shelfInput({ bean_id: other }))).shelf_entry_id;
      await repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'));
      expect((await partition(userPk(user))).find((i) => i.type === 'BREW')).toMatchObject({ shelfEntryId: entry, beanId: other });
    });
  });

  describe('changing the bean of a shelf entry (D14)', () => {
    let OTHER_BEAN = '';
    beforeAll(async () => {
      OTHER_BEAN = (await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    });

    /** Every brew item of the user names the bean its shelf entry names now, and each entry counts its brews. */
    async function expectConsistent(user: UserId): Promise<{ brews: number }> {
      const items = await partition(userPk(user));
      const entries = items.filter((i) => i.type === 'SHELF');
      const brews = items.filter((i) => i.type === 'BREW');
      for (const entry of entries) {
        const own = brews.filter((b) => b.shelfEntryId === entry.shelfEntryId);
        for (const brew of own) expect(brew.beanId).toBe(entry.beanId);
        expect(entry.brewCount).toBe(own.length);
      }
      expect(items.filter((i) => i.type === 'BREW_REF')).toHaveLength(brews.length);
      return { brews: brews.length };
    }

    it('a bean change with no brews passes', async () => {
      const user = verifiedUserId('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const replaced = await repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }));
      expect(replaced.values.bean_id).toBe(OTHER_BEAN);
      expect(await raw(shelfEntryKey(user, entry))).toMatchObject({ beanId: OTHER_BEAN, brewCount: 0 });
    });

    it('a bean change on an entry stored without brewCount passes (attribute_not_exists)', async () => {
      const user = verifiedUserId('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      await documentClient.send(
        new UpdateCommand({ TableName: tableName, Key: shelfEntryKey(user, entry), UpdateExpression: 'REMOVE brewCount' }),
      );
      await repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }));
      expect((await raw(shelfEntryKey(user, entry)))?.beanId).toBe(OTHER_BEAN);
    });

    it('a bean change with one brew is ShelfEntryBeanLockedError and writes nothing', async () => {
      const user = verifiedUserId('e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      await repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'));
      const before = await partition(userPk(user));
      await expect(repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }))).rejects.toThrow(ShelfEntryBeanLockedError);
      expect(await partition(userPk(user))).toEqual(before);
      // An unknown bean is still 404, and a missing entry too, brews or not.
      await expect(repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: newUlid() }))).rejects.toThrow(BeanNotFoundError);
      await expect(repo.replaceShelfEntry(user, newUlid(), shelfInput({ bean_id: OTHER_BEAN }))).rejects.toThrow(ItemNotFoundError);
      expect(await partition(userPk(user))).toEqual(before);
    });

    it('a change that keeps the bean passes while brews reference the entry', async () => {
      const user = verifiedUserId('e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      await repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'));
      await repo.createBrew(user, brewInput(entry, '2026-11-25T08:00:00Z'));
      const replaced = await repo.replaceShelfEntry(user, entry, shelfInput({ price_band: 'from_80', bag_size: 'g_1000' }));
      expect(await repo.getShelfEntry(user, entry)).toEqual(replaced);
      expect(await raw(shelfEntryKey(user, entry))).toMatchObject({ beanId: BEAN_ID, brewCount: 2 });
      expect(await expectConsistent(user)).toEqual({ brews: 2 });
    });

    it('after the brews are deleted, a bean change passes', async () => {
      const user = verifiedUserId('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const a = await repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'));
      const b = await repo.createBrew(user, brewInput(entry, '2026-11-25T08:00:00Z'));
      await repo.deleteBrew(user, a.brew_id);
      await expect(repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }))).rejects.toThrow(ShelfEntryBeanLockedError);
      await repo.deleteBrew(user, b.brew_id);
      await repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }));
      expect(await raw(shelfEntryKey(user, entry))).toMatchObject({ beanId: OTHER_BEAN, brewCount: 0 });
      // A brew logged now records the new bean.
      await repo.createBrew(user, brewInput(entry, '2026-11-25T09:00:00Z'));
      expect((await partition(userPk(user))).find((i) => i.type === 'BREW')).toMatchObject({ beanId: OTHER_BEAN });
    });

    it('moving a brew onto an entry whose bean was just changed records the new bean', async () => {
      const user = verifiedUserId('e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6');
      const first = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const second = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      const brew = await repo.createBrew(user, brewInput(first, '2026-11-25T07:00:00Z'));
      await repo.replaceShelfEntry(user, second, shelfInput({ bean_id: OTHER_BEAN }));
      await repo.replaceBrew(user, brew.brew_id, brewInput(second, '2026-11-25T07:00:00Z'));
      // Now the second entry has a brew: its bean is locked; the first has none: its bean is free.
      await expect(repo.replaceShelfEntry(user, second, shelfInput())).rejects.toThrow(ShelfEntryBeanLockedError);
      await repo.replaceShelfEntry(user, first, shelfInput({ bean_id: OTHER_BEAN }));
      expect(await expectConsistent(user)).toEqual({ brews: 1 });
      expect((await partition(userPk(user))).find((i) => i.type === 'BREW')).toMatchObject({ shelfEntryId: second, beanId: OTHER_BEAN });
    });

    /** As the API does: a write that raced is tried up to WRITE_ATTEMPTS times in all. */
    async function withRetry<T>(write: () => Promise<T>): Promise<T> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await write();
        } catch (error) {
          if (!(error instanceof WriteConflictError) || attempt >= WRITE_ATTEMPTS) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        }
      }
    }

    it('a brew that read the old bean before a bean change lands fails its condition and, retried, records the new bean', async () => {
      const user = verifiedUserId('e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7');
      const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
      // Hold the brew transaction after its read of the shelf entry until the bean change is done.
      let release: () => void = () => undefined;
      let held: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (held = resolve));
      let gated = 0;
      const gatedClient = {
        send: async (command: unknown, ...rest: unknown[]) => {
          if (command instanceof TransactWriteCommand && gated++ === 0) {
            held();
            await gate;
          }
          return (documentClient.send as (c: unknown, ...r: unknown[]) => Promise<unknown>)(command, ...rest);
        },
      } as unknown as DynamoDBDocumentClient;
      const slow = new Repository({ client: gatedClient, tableName });

      const brewing = withRetry(() => slow.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z')));
      await reached;
      await repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }));
      release();
      const brew = await brewing;
      expect(gated).toBe(2); // the first transaction failed its condition; the retry read the new bean
      expect(await raw(shelfEntryKey(user, entry))).toMatchObject({ beanId: OTHER_BEAN, brewCount: 1 });
      expect((await partition(userPk(user))).find((i) => i.type === 'BREW')).toMatchObject({ brewId: brew.brew_id, beanId: OTHER_BEAN });
      // And the bean is locked again now.
      await expect(repo.replaceShelfEntry(user, entry, shelfInput())).rejects.toThrow(ShelfEntryBeanLockedError);
    });

    it('the race: parallel brew creates and a bean change always leave every brew under its entry’s bean', async () => {
      const outcomes = { replaced: 0, locked: 0, brewsFailed: 0 };
      for (let round = 0; round < 25; round += 1) {
        const user = verifiedUserId(`f0f0f0f0-f0f0-4f0f-8f0f-${String(round).padStart(12, '0')}`);
        const entry = (await repo.createShelfEntry(user, shelfInput())).shelf_entry_id;
        // A random head start for each write, so both orders occur (the replace sends no read first).
        const later = async <T>(write: () => Promise<T>): Promise<T> => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 12));
          return withRetry(write);
        };
        const settled = await Promise.allSettled([
          later(() => repo.createBrew(user, brewInput(entry, '2026-11-25T07:00:00Z'))),
          later(() => repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: OTHER_BEAN }))),
          later(() => repo.createBrew(user, brewInput(entry, '2026-11-25T08:00:00Z'))),
        ]);
        const [brewA, replace, brewB] = settled;
        if (replace.status === 'fulfilled') outcomes.replaced += 1;
        else {
          expect(replace.reason).toBeInstanceOf(ShelfEntryBeanLockedError);
          outcomes.locked += 1;
        }
        for (const result of [brewA, brewB]) {
          if (result.status === 'rejected') {
            // Only a race that kept losing may fail a brew, and then it wrote nothing.
            expect(result.reason).toBeInstanceOf(WriteConflictError);
            outcomes.brewsFailed += 1;
          }
        }
        const stored = await raw(shelfEntryKey(user, entry));
        expect(stored?.beanId).toBe(replace.status === 'fulfilled' ? OTHER_BEAN : BEAN_ID);
        await expectConsistent(user);
      }
      expect(outcomes.replaced + outcomes.locked).toBe(25);
    });
  });

  describe('rejected beans on shelves (M1-T11)', () => {
    async function newBean(): Promise<string> {
      return (await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    }

    it('a new shelf entry for a rejected bean is BeanNotFoundError and writes nothing; a verified bean passes', async () => {
      const user = verifiedUserId('f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1');
      const rejected = await newBean();
      await repo.rejectBean(rejected);
      await expect(repo.createShelfEntry(user, shelfInput({ bean_id: rejected }))).rejects.toThrow(BeanNotFoundError);
      expect(await partition(userPk(user))).toEqual([]);
      const verified = await newBean();
      await repo.verifyBean(verified);
      expect((await repo.createShelfEntry(user, shelfInput({ bean_id: verified }))).values.bean_id).toBe(verified);
    });

    it('an entry whose bean is rejected later can be listed, read, brewed on and replaced keeping that bean', async () => {
      const user = verifiedUserId('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2');
      const bean = await newBean();
      const entry = await repo.createShelfEntry(user, shelfInput({ bean_id: bean }));
      await repo.createBrew(user, brewInput(entry.shelf_entry_id, '2026-11-25T07:00:00Z'));
      await repo.rejectBean(bean);

      expect((await repo.listShelfEntries(user)).items).toEqual([entry]);
      expect(await repo.getShelfEntry(user, entry.shelf_entry_id)).toEqual(entry);
      const brew = await repo.createBrew(user, brewInput(entry.shelf_entry_id, '2026-11-25T08:00:00Z'));
      expect(await repo.getBrew(user, brew.brew_id)).toEqual(brew);

      // Same bean, other fields, while brews reference the entry: the fallback write passes.
      const replaced = await repo.replaceShelfEntry(user, entry.shelf_entry_id, shelfInput({ bean_id: bean, price_band: 'from_80' }));
      expect(replaced).toEqual({ shelf_entry_id: entry.shelf_entry_id, values: shelfInput({ bean_id: bean, price_band: 'from_80' }) });
      expect(await repo.getShelfEntry(user, entry.shelf_entry_id)).toEqual(replaced);
      expect(await raw(shelfEntryKey(user, entry.shelf_entry_id))).toMatchObject({ beanId: bean, brewCount: 2 });
    });

    it('a replace that switches to a rejected bean is BeanNotFoundError and writes nothing; leaving one passes', async () => {
      const user = verifiedUserId('f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3');
      const kept = await newBean();
      const rejected = await newBean();
      const entry = (await repo.createShelfEntry(user, shelfInput({ bean_id: kept }))).shelf_entry_id;
      const onRejected = (await repo.createShelfEntry(user, shelfInput({ bean_id: rejected }))).shelf_entry_id;
      await repo.rejectBean(rejected);
      const before = await partition(userPk(user));
      await expect(repo.replaceShelfEntry(user, entry, shelfInput({ bean_id: rejected }))).rejects.toThrow(BeanNotFoundError);
      expect(await partition(userPk(user))).toEqual(before);
      // An entry on a rejected bean, with no brews, may move to a bean that is not rejected.
      await repo.replaceShelfEntry(user, onRejected, shelfInput({ bean_id: kept }));
      expect((await raw(shelfEntryKey(user, onRejected)))?.beanId).toBe(kept);
    });

    it('a same-bean replace on a missing entry is still ItemNotFoundError', async () => {
      const user = verifiedUserId('f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4');
      const rejected = await newBean();
      await repo.rejectBean(rejected);
      await expect(repo.replaceShelfEntry(user, newUlid(), shelfInput({ bean_id: rejected }))).rejects.toThrow(ItemNotFoundError);
    });
  });

  describe('recipes', () => {
    it('round-trip and conditions', async () => {
      const user = verifiedUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const created = await repo.createRecipe(user, recipeInput());
      expect(await repo.getRecipe(user, created.recipe_id)).toEqual(created);
      const replaced = await repo.replaceRecipe(user, created.recipe_id, recipeInput(180));
      expect(replaced.values.parameters.dose_dg).toBe(180);
      expect((await repo.listRecipes(user)).items).toEqual([replaced]);
      await repo.deleteRecipe(user, created.recipe_id);
      expect(await repo.getRecipe(user, created.recipe_id)).toBeUndefined();

      const missing = newUlid();
      await expect(repo.replaceRecipe(user, missing, recipeInput())).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteRecipe(user, missing)).rejects.toThrow(ItemNotFoundError);
      const fixed = newUlid();
      const sameId = repoWith({ newId: () => fixed });
      await sameId.createRecipe(user, recipeInput());
      await expect(sameId.createRecipe(user, recipeInput())).rejects.toThrow(ItemExistsError);
    });
  });

  describe('bean catalogue and the sparse review queue', () => {
    it('an unverified bean carries the gsi1 keys; verifying removes both', async () => {
      const createdAt = new Date('2026-11-25T08:15:30.5+01:00');
      const record = await repoWith({ now: () => createdAt }).createBean({
        vocabularyVersion: 1,
        openFoodFactsMatch: false,
        pickedAttributes: { process: 'washed' },
      });
      const id = record.bean.bean_id;
      expect(record).toMatchObject({ status: 'unverified', createdAt: '2026-11-25T07:15:30.500Z' });
      expect(record.bean).toEqual({
        bean_id: id,
        vocabulary_version: 1,
        verified: false,
        open_food_facts_match: false,
        picked_attributes: { process: 'washed' },
        operator_attributes: {},
      });
      const stored = await raw(beanMetaKey(id));
      expect(stored?.gsi1pk).toBe('REVIEW#UNVERIFIED');
      expect(stored?.gsi1sk).toBe(`2026-11-25T07:15:30.500Z#${id}`);
      expect(await reviewQueue()).toContain(id);
      expect(await repo.getBean(id)).toEqual(record);

      const verified = await repo.verifyBean(id, { process: 'natural', roast_level: 'light' });
      expect(verified.bean.verified).toBe(true);
      expect(verified.bean.operator_attributes).toEqual({ process: 'natural', roast_level: 'light' });
      const after = await raw(beanMetaKey(id));
      expect(after).not.toHaveProperty('gsi1pk');
      expect(after).not.toHaveProperty('gsi1sk');
      expect(await reviewQueue()).not.toContain(id);
      await expect(repo.verifyBean(id)).rejects.toThrow(BeanNotUnverifiedError);
      await expect(repo.rejectBean(id)).rejects.toThrow(BeanNotUnverifiedError);
    });

    it('rejecting removes both gsi1 keys too', async () => {
      const { bean } = await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} });
      expect(await reviewQueue()).toContain(bean.bean_id);
      const rejected = await repo.rejectBean(bean.bean_id);
      expect(rejected.status).toBe('rejected');
      expect(rejected.bean.verified).toBe(false);
      const after = await raw(beanMetaKey(bean.bean_id));
      expect(after).not.toHaveProperty('gsi1pk');
      expect(after).not.toHaveProperty('gsi1sk');
      expect(await reviewQueue()).not.toContain(bean.bean_id);
    });

    it('rejecting frees the barcode in the same write; the rejected bean stays recorded and a new create succeeds', async () => {
      const barcode = '5449000000996';
      const created = await repo.createBean({ vocabularyVersion: 2, barcode, openFoodFactsMatch: false, pickedAttributes: { origin: 'kenya' } });
      const id = created.bean.bean_id;
      expect((await repo.getBeanByBarcode(barcode))?.bean).toEqual(created.bean);

      const rejected = await repo.rejectBean(id);
      expect(rejected).toEqual({ ...created, status: 'rejected' });
      expect(await raw(barcodeKey(barcode))).toBeUndefined();
      expect(await repo.getBeanByBarcode(barcode)).toBeUndefined();
      const meta = await raw(beanMetaKey(id));
      expect(meta).toMatchObject({ status: 'rejected', barcode, beanId: id, pickedAttributes: { origin: 'kenya' } });
      expect(meta).not.toHaveProperty('gsi1pk');
      expect(await repo.getBean(id)).toEqual(rejected);

      const fresh = await repo.createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: false, pickedAttributes: { process: 'honey' } });
      expect(fresh.bean.bean_id).not.toBe(id);
      expect((await repo.getBeanByBarcode(barcode))?.bean).toEqual(fresh.bean);
      expect(await raw(barcodeKey(barcode))).toMatchObject({ beanId: fresh.bean.bean_id });
      // Rejecting the old bean again changes nothing, and never touches the new pointer.
      await expect(repo.rejectBean(id)).rejects.toThrow(BeanNotUnverifiedError);
      expect(await raw(barcodeKey(barcode))).toMatchObject({ beanId: fresh.bean.bean_id });
    });

    it('verifying keeps the barcode pointer', async () => {
      const barcode = '0012000161155';
      const { bean } = await repo.createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: false, pickedAttributes: {} });
      await repo.verifyBean(bean.bean_id);
      expect(await raw(barcodeKey(barcode))).toMatchObject({ beanId: bean.bean_id });
      expect((await repo.getBeanByBarcode(barcode))?.bean.verified).toBe(true);
    });

    it('a reject leaves a pointer that names another bean alone', async () => {
      const barcode = '0012000161162';
      const { bean } = await repo.createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: false, pickedAttributes: {} });
      const other = newUlid();
      // Planted directly: a pointer can only name another bean through corruption or a future merge.
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...barcodeKey(barcode), type: 'BARCODE', beanId: other, barcode } }));
      expect((await repo.rejectBean(bean.bean_id)).status).toBe('rejected');
      expect(await raw(barcodeKey(barcode))).toMatchObject({ beanId: other });
    });

    it('verifying an unknown bean is not found', async () => {
      await expect(repo.verifyBean(newUlid())).rejects.toThrow(ItemNotFoundError);
      await expect(repo.rejectBean(newUlid())).rejects.toThrow(ItemNotFoundError);
    });

    it('a barcode points to its bean; a second bean cannot take it and nothing of it is written', async () => {
      const barcode = '4006381333931';
      const { bean } = await repo.createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: true, pickedAttributes: {} });
      expect(bean.barcode).toBe(barcode);
      expect(await repo.findBeanIdByBarcode(barcode)).toBe(bean.bean_id);
      expect(await raw(barcodeKey(barcode))).toMatchObject({ type: 'BARCODE', beanId: bean.bean_id });
      expect(await repo.findBeanIdByBarcode('0012345678905')).toBeUndefined();

      const fixed = newUlid();
      await expect(
        repoWith({ newId: () => fixed }).createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: true, pickedAttributes: {} }),
      ).rejects.toThrow(BarcodeTakenError);
      expect(await repo.getBean(fixed)).toBeUndefined();
      expect(await reviewQueue()).not.toContain(fixed);
    });

    it('one product by its UPC-A and its EAN-13 form is one barcode', async () => {
      const upcA = '036000291452';
      const ean13 = '0036000291452';
      const { bean } = await repo.createBean({ vocabularyVersion: 1, barcode: upcA, openFoodFactsMatch: true, pickedAttributes: {} });
      expect(bean.barcode).toBe(ean13);
      expect((await raw(beanMetaKey(bean.bean_id)))?.barcode).toBe(ean13);
      expect(await raw({ pk: `BARCODE#${ean13}`, sk: 'BEAN' })).toMatchObject({ beanId: bean.bean_id, barcode: ean13 });
      expect(await raw({ pk: `BARCODE#${upcA}`, sk: 'BEAN' })).toBeUndefined();

      const fixed = newUlid();
      await expect(
        repoWith({ newId: () => fixed }).createBean({ vocabularyVersion: 1, barcode: ean13, openFoodFactsMatch: true, pickedAttributes: {} }),
      ).rejects.toThrow(BarcodeTakenError);
      expect(await repo.getBean(fixed)).toBeUndefined();
      expect(await repo.findBeanIdByBarcode(upcA)).toBe(bean.bean_id);
      expect(await repo.findBeanIdByBarcode(ean13)).toBe(bean.bean_id);
    });

    it('a barcode with a wrong check digit is refused and writes nothing', async () => {
      const fixed = newUlid();
      await expect(
        repoWith({ newId: () => fixed }).createBean({ vocabularyVersion: 1, barcode: '0012345678901', openFoodFactsMatch: true, pickedAttributes: {} }),
      ).rejects.toThrow(InvalidValuesError);
      expect(await repo.getBean(fixed)).toBeUndefined();
      await expect(repo.findBeanIdByBarcode('0012345678901')).rejects.toThrow(InvalidKeyError);
    });

    it('bean create is conditional on the item not existing', async () => {
      const fixed = newUlid();
      const sameId = repoWith({ newId: () => fixed });
      await sameId.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} });
      await expect(sameId.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).rejects.toThrow(
        ItemExistsError,
      );
    });

    it('lists the queue oldest first, in pages', async () => {
      // A separate table, so beans from the other tests do not interleave.
      const own = await createTestTable(client);
      try {
        let t = Date.UTC(2026, 10, 1, 9);
        const r = new Repository({ client: documentClient, tableName: own, now: () => new Date((t += 60_000)) });
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          ids.push((await r.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id);
        }
        await r.verifyBean(ids[1] ?? '');
        const page1 = await r.listReviewQueue({ limit: 1 });
        expect(page1.items.map((b) => b.bean.bean_id)).toEqual([ids[0]]);
        const page2 = await r.listReviewQueue({ limit: 1, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) });
        expect(page2.items.map((b) => b.bean.bean_id)).toEqual([ids[2]]);
        const page3 = await r.listReviewQueue({ limit: 1, ...(page2.nextCursor ? { cursor: page2.nextCursor } : {}) });
        expect(page3.items).toEqual([]);
        await expect(r.listReviewQueue({ cursor: Buffer.from(`SHELF#${ids[0] ?? ''}`).toString('base64url') })).rejects.toThrow(
          InvalidCursorError,
        );
      } finally {
        await deleteTestTable(client, own);
      }
    });
  });

  describe('aggregate and ranking keys (written by the nightly rebuild, M3)', () => {
    it('address distinct items in the bean partition and the ranking partitions', async () => {
      const { bean } = await repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} });
      const keys = [
        aggregateAllKey(bean.bean_id),
        aggregateMethodKey(bean.bean_id, 'v60'),
        aggregateMethodKey(bean.bean_id, 'espresso'),
      ];
      for (const key of keys) {
        await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...key }, ConditionExpression: 'attribute_not_exists(pk)' }));
      }
      const items = await partition(beanMetaKey(bean.bean_id).pk);
      expect(items.map((i) => i.sk).sort()).toEqual(
        ['AGG#ALL', 'AGG#METHOD#espresso', 'AGG#METHOD#v60', 'META'].sort(),
      );
      // The bean is still readable and still in the queue: the other items do not disturb it.
      expect((await repo.getBean(bean.bean_id))?.status).toBe('unverified');
      // Only META is in the review queue; aggregates carry no gsi1 keys.
      expect((await reviewQueue()).filter((id) => id === bean.bean_id)).toHaveLength(1);

      const ranking = rankingKey({ kind: 'method', value: 'v60' }, '2026-11-25');
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...ranking, top: [bean.bean_id] } }));
      expect((await raw(ranking))?.top).toEqual([bean.bean_id]);
    });
  });

  describe('cross-user isolation', () => {
    it('Bob cannot read, replace, delete or list any of Alice’s items', async () => {
      const shelf = await repo.createShelfEntry(ALICE, shelfInput());
      const brew = await repo.createBrew(ALICE, brewInput(shelf.shelf_entry_id, '2026-11-25T07:00:00Z'));
      const recipe = await repo.createRecipe(ALICE, recipeInput());
      await repo.putProfile(ALICE, { locale: 'de', consent: { contribute_to_aggregates: true } });
      const before = await partition(userPk(ALICE));

      expect(await repo.getShelfEntry(BOB, shelf.shelf_entry_id)).toBeUndefined();
      expect(await repo.getBrew(BOB, brew.brew_id)).toBeUndefined();
      expect(await repo.getRecipe(BOB, recipe.recipe_id)).toBeUndefined();
      expect(await repo.getProfile(BOB)).toBeUndefined();

      await expect(repo.replaceShelfEntry(BOB, shelf.shelf_entry_id, shelfInput({ price_band: 'from_80' }))).rejects.toThrow(
        ItemNotFoundError,
      );
      await expect(repo.replaceBrew(BOB, brew.brew_id, brewInput(shelf.shelf_entry_id, '2026-11-26T07:00:00Z'))).rejects.toThrow(
        ItemNotFoundError,
      );
      await expect(repo.replaceRecipe(BOB, recipe.recipe_id, recipeInput(999))).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteShelfEntry(BOB, shelf.shelf_entry_id)).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteBrew(BOB, brew.brew_id)).rejects.toThrow(ItemNotFoundError);
      await expect(repo.deleteRecipe(BOB, recipe.recipe_id)).rejects.toThrow(ItemNotFoundError);

      expect((await repo.listShelfEntries(BOB)).items).toEqual([]);
      expect((await repo.listBrews(BOB)).items).toEqual([]);
      expect((await repo.listRecipes(BOB)).items).toEqual([]);

      // Bob's failed writes left nothing in his partition and changed nothing in Alice's.
      expect(await partition(userPk(BOB))).toEqual([]);
      expect(await partition(userPk(ALICE))).toEqual(before);
    });

    it('a cursor from Alice’s list only ever pages through Bob’s own partition', async () => {
      for (let i = 0; i < 3; i += 1) await repo.createShelfEntry(ALICE, shelfInput());
      const own = await repo.createShelfEntry(BOB, shelfInput({ purchase_date: '2026-01-01' }));
      const alicePage = await repo.listShelfEntries(ALICE, { limit: 1 });
      expect(alicePage.nextCursor).toBeDefined();
      const bobPage = await repo.listShelfEntries(BOB, alicePage.nextCursor ? { cursor: alicePage.nextCursor } : {});
      for (const item of bobPage.items) expect(item.shelf_entry_id).toBe(own.shelf_entry_id);
      // A cursor that names Alice's partition is refused outright.
      await expect(
        repo.listShelfEntries(BOB, { cursor: Buffer.from(userPk(ALICE)).toString('base64url') }),
      ).rejects.toThrow(InvalidCursorError);
    });

    it('no method accepts a raw string as the user, at the type level or at run time', async () => {
      const raw = ALICE.value;
      // @ts-expect-error a raw string is not a UserId
      await expect(repo.getProfile(raw)).rejects.toThrow(InvalidKeyError);
      // @ts-expect-error a partition key string is not a UserId either
      await expect(repo.listShelfEntries(`USER#${raw}`)).rejects.toThrow(InvalidKeyError);
      // @ts-expect-error a look-alike object is not a UserId
      await expect(repo.getBrew({ value: raw }, newUlid())).rejects.toThrow(InvalidKeyError); // eslint-disable-line @typescript-eslint/no-unsafe-class-instance-assignment -- deliberate forgery attempt
      const forged = raw as unknown as UserId;
      await expect(repo.createShelfEntry(forged, shelfInput())).rejects.toThrow(InvalidKeyError);
      await expect(repo.deleteRecipe(forged, newUlid())).rejects.toThrow(InvalidKeyError);
    });

    it('an injected item id cannot reach another partition', async () => {
      const shelf = await repo.createShelfEntry(ALICE, shelfInput());
      for (const bad of [`${shelf.shelf_entry_id}#`, userPk(ALICE), '', '#', `../${shelf.shelf_entry_id}`]) {
        await expect(repo.getShelfEntry(BOB, bad)).rejects.toThrow(InvalidKeyError);
        await expect(repo.deleteShelfEntry(BOB, bad)).rejects.toThrow(InvalidKeyError);
      }
    });
  });

  describe('stored items are checked on read', () => {
    it('an item that does not match its schema is refused', async () => {
      const user = verifiedUserId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      const id = newUlid();
      await documentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...shelfEntryKey(user, id), shelfEntryId: id, values: { vocabulary_version: 1, bean_id: BEAN_ID, purchase_date: 'x' } },
        }),
      );
      await expect(repo.getShelfEntry(user, id)).rejects.toThrow(CorruptItemError);
    });
  });
});
