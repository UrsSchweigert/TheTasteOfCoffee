// The Open Food Facts cache and the daily lookup cap against DynamoDB Local
// (M1-T4b): the stored items (a hit, a miss with its `expires_at`), an expired
// miss read as absent, a hit never overwritten, the counter's atomic cap under
// parallel calls, and the route end to end with a stubbed fetch. Nothing
// calls Open Food Facts or AWS.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/router.ts';
import type { LogEntry } from '../../src/api/router.ts';
import { BeanSchema } from '../../src/generated/contract.ts';
import { createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import type { Fetch } from '../../src/openfoodfacts/client.ts';
import {
  CorruptItemError,
  InvalidValuesError,
  LOOKUP_COUNTER_TTL_SECONDS,
  OPEN_FOOD_FACTS_MISS_TTL_SECONDS,
  Repository,
  beanMetaKey,
  lookupCounterKey,
  openFoodFactsCacheKey,
} from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent, beanBody, testSigner } from '../api/helpers.ts';
import type { RequestOptions } from '../api/helpers.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();

const ALICE = verifiedUserId(ALICE_SUB);
const BOB = verifiedUserId(BOB_SUB);
const NOW = new Date('2026-11-25T18:30:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const DAY_START_SECONDS = Math.floor(Date.parse('2026-11-25T00:00:00.000Z') / 1000);

/** Valid EAN-13s: 12 digits plus the GS1 check digit; `base` keeps the tests apart. */
function ean(base: number, n: number): string {
  const body = String(base * 1_000_000 + n).padStart(12, '0');
  const sum = Array.from(body, Number).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${String((10 - (sum % 10)) % 10)}`;
}

describe.skipIf(!local.reachable)('Open Food Facts cache and lookup cap on DynamoDB Local', () => {
  let tableName = '';
  const { client, documentClient } = local;

  const repoAt = (now: Date): Repository => new Repository({ client: documentClient, tableName, now: () => now });
  const raw = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    (await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;

  beforeAll(async () => {
    tableName = await createTestTable(client);
  });

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  describe('the cache item BARCODE#<ean> / OFF', () => {
    it('a hit is stored with its text and no expires_at, and read back by either barcode form', async () => {
      const repo = repoAt(NOW);
      const upcA = '036000291452';
      const stored = await repo.cacheOpenFoodFactsResult(upcA, { kind: 'hit', product: { name: 'Guji', brand: 'Acme' } });
      expect(stored).toEqual({ kind: 'hit', product: { name: 'Guji', brand: 'Acme' } });
      expect(await raw(openFoodFactsCacheKey(upcA))).toEqual({
        pk: 'BARCODE#0036000291452',
        sk: 'OFF',
        type: 'OFF_CACHE',
        result: 'hit',
        product: { name: 'Guji', brand: 'Acme' },
        fetchedAt: NOW.toISOString(),
      });
      expect(await repo.getOpenFoodFactsCache('0036000291452')).toEqual(stored);
      // A hit does not expire: years later it is still there.
      expect(await repoAt(new Date('2036-01-01T00:00:00Z')).getOpenFoodFactsCache(upcA)).toEqual(stored);
    });

    it('a miss is stored with expires_at = now + 30 days (epoch seconds), and expires on read at that second', async () => {
      const barcode = ean(1, 1);
      await repoAt(NOW).cacheOpenFoodFactsResult(barcode, { kind: 'miss' });
      const item = await raw(openFoodFactsCacheKey(barcode));
      expect(item).toEqual({
        pk: `BARCODE#${barcode}`,
        sk: 'OFF',
        type: 'OFF_CACHE',
        result: 'miss',
        fetchedAt: NOW.toISOString(),
        expires_at: NOW_SECONDS + OPEN_FOOD_FACTS_MISS_TTL_SECONDS,
      });
      expect(OPEN_FOOD_FACTS_MISS_TTL_SECONDS).toBe(2_592_000);
      const justBefore = new Date((NOW_SECONDS + OPEN_FOOD_FACTS_MISS_TTL_SECONDS - 1) * 1000);
      const atExpiry = new Date((NOW_SECONDS + OPEN_FOOD_FACTS_MISS_TTL_SECONDS) * 1000);
      expect(await repoAt(justBefore).getOpenFoodFactsCache(barcode)).toEqual({ kind: 'miss' });
      // TTL has not deleted it yet (DynamoDB does that later), but the read treats it as absent.
      expect(await repoAt(atExpiry).getOpenFoodFactsCache(barcode)).toBeUndefined();
      expect(await raw(openFoodFactsCacheKey(barcode))).toBeDefined();
    });

    it('an unknown barcode has no entry', async () => {
      expect(await repoAt(NOW).getOpenFoodFactsCache(ean(1, 2))).toBeUndefined();
    });

    it('a hit replaces a miss; a miss or a second hit never replaces a hit (the first hit is returned)', async () => {
      const barcode = ean(1, 3);
      const repo = repoAt(NOW);
      expect(await repo.cacheOpenFoodFactsResult(barcode, { kind: 'miss' })).toEqual({ kind: 'miss' });
      expect(await repo.cacheOpenFoodFactsResult(barcode, { kind: 'miss' })).toEqual({ kind: 'miss' });
      const first = { kind: 'hit', product: { name: 'First' } } as const;
      expect(await repo.cacheOpenFoodFactsResult(barcode, first)).toEqual(first);
      expect(await raw(openFoodFactsCacheKey(barcode))).not.toHaveProperty('expires_at');
      expect(await repo.cacheOpenFoodFactsResult(barcode, { kind: 'miss' })).toEqual(first);
      expect(await repo.cacheOpenFoodFactsResult(barcode, { kind: 'hit', product: { name: 'Second' } })).toEqual(first);
      expect(await repo.getOpenFoodFactsCache(barcode)).toEqual(first);
    });

    it('an expired miss is replaced by a fresh one with a new expires_at', async () => {
      const barcode = ean(1, 4);
      await repoAt(NOW).cacheOpenFoodFactsResult(barcode, { kind: 'miss' });
      const later = new Date((NOW_SECONDS + OPEN_FOOD_FACTS_MISS_TTL_SECONDS + 10) * 1000);
      await repoAt(later).cacheOpenFoodFactsResult(barcode, { kind: 'miss' });
      expect((await raw(openFoodFactsCacheKey(barcode)))?.expires_at).toBe(NOW_SECONDS + 2 * OPEN_FOOD_FACTS_MISS_TTL_SECONDS + 10);
    });

    it('refuses a hit without text, text over the limits, an image id (M1-T4c) and a bad barcode', async () => {
      const repo = repoAt(NOW);
      const barcode = ean(1, 5);
      for (const product of [{}, { name: '' }, { name: 'x'.repeat(151) }, { brand: 'x'.repeat(101) }, { name: 'x', image_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }]) {
        await expect(repo.cacheOpenFoodFactsResult(barcode, { kind: 'hit', product })).rejects.toBeInstanceOf(InvalidValuesError);
      }
      await expect(repo.cacheOpenFoodFactsResult('4006381333932', { kind: 'miss' })).rejects.toThrow();
      expect(await raw(openFoodFactsCacheKey(barcode))).toBeUndefined();
    });

    it('a stored item of the wrong shape is CorruptItemError', async () => {
      const barcode = ean(1, 6);
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...openFoodFactsCacheKey(barcode), result: 'hit', product: { name: 'x'.repeat(151) }, fetchedAt: 'x' } }));
      await expect(repoAt(NOW).getOpenFoodFactsCache(barcode)).rejects.toBeInstanceOf(CorruptItemError);
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...openFoodFactsCacheKey(barcode), result: 'miss', fetchedAt: 'x' } }));
      await expect(repoAt(NOW).getOpenFoodFactsCache(barcode)).rejects.toBeInstanceOf(CorruptItemError);
    });
  });

  describe('the counter USER#<sub> / LOOKUPS#<day>', () => {
    it('counts up to the cap and no further; the item carries expires_at = start of the day + 2 days', async () => {
      const repo = repoAt(NOW);
      const user = verifiedUserId('11111111-2222-4333-8444-555555555555');
      for (let n = 0; n < 3; n += 1) expect(await repo.countLookup(user, 3)).toBe(true);
      expect(await repo.countLookup(user, 3)).toBe(false);
      expect(await repo.countLookup(user, 3)).toBe(false);
      expect(await raw(lookupCounterKey(user, '2026-11-25'))).toEqual({
        pk: 'USER#11111111-2222-4333-8444-555555555555',
        sk: 'LOOKUPS#2026-11-25',
        type: 'LOOKUPS',
        lookups: 3,
        expires_at: DAY_START_SECONDS + LOOKUP_COUNTER_TTL_SECONDS,
      });
      // A higher cap (a configuration change) lets the same day go on.
      expect(await repo.countLookup(user, 4)).toBe(true);
      expect((await raw(lookupCounterKey(user, '2026-11-25')))?.lookups).toBe(4);
    });

    it('the next UTC day has its own counter; users have their own counters', async () => {
      const user = verifiedUserId('21111111-2222-4333-8444-555555555555');
      const other = verifiedUserId('31111111-2222-4333-8444-555555555555');
      expect(await repoAt(new Date('2026-11-25T23:59:59.999Z')).countLookup(user, 1)).toBe(true);
      expect(await repoAt(new Date('2026-11-25T23:59:59.999Z')).countLookup(user, 1)).toBe(false);
      expect(await repoAt(new Date('2026-11-25T23:59:59.999Z')).countLookup(other, 1)).toBe(true);
      expect(await repoAt(new Date('2026-11-26T00:00:00.000Z')).countLookup(user, 1)).toBe(true);
      expect((await raw(lookupCounterKey(user, '2026-11-26')))?.expires_at).toBe(DAY_START_SECONDS + 86_400 + LOOKUP_COUNTER_TTL_SECONDS);
    });

    it('cap 0 writes nothing and counts nothing; a bad cap is refused', async () => {
      const user = verifiedUserId('41111111-2222-4333-8444-555555555555');
      expect(await repoAt(NOW).countLookup(user, 0)).toBe(false);
      expect(await raw(lookupCounterKey(user, '2026-11-25'))).toBeUndefined();
      for (const cap of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(repoAt(NOW).countLookup(user, cap)).rejects.toBeInstanceOf(InvalidValuesError);
      }
    });

    it('is atomic under parallel calls: 40 at once with cap 7 count exactly 7', async () => {
      const user = verifiedUserId('51111111-2222-4333-8444-555555555555');
      const repo = repoAt(NOW);
      const results = await Promise.all(Array.from({ length: 40 }, () => repo.countLookup(user, 7)));
      expect(results.filter(Boolean)).toHaveLength(7);
      expect((await raw(lookupCounterKey(user, '2026-11-25')))?.lookups).toBe(7);
    });

    it('is not listed with the user\'s shelf, brews or recipes', async () => {
      const user = verifiedUserId('61111111-2222-4333-8444-555555555555');
      const repo = repoAt(NOW);
      expect(await repo.countLookup(user, 5)).toBe(true);
      expect((await repo.listShelfEntries(user)).items).toEqual([]);
      expect((await repo.listBrews(user)).items).toEqual([]);
      expect((await repo.listRecipes(user)).items).toEqual([]);
    });
  });

  describe('a bean from a confirmed hit', () => {
    it('stores the open_food_facts group on the bean and returns it', async () => {
      const repo = repoAt(NOW);
      const barcode = ean(2, 1);
      const record = await repo.createBean({ vocabularyVersion: 1, barcode, openFoodFactsMatch: true, openFoodFacts: { name: 'Guji', brand: 'Acme' }, pickedAttributes: { process: 'natural' } });
      expect(record.bean).toMatchObject({ open_food_facts_match: true, open_food_facts: { name: 'Guji', brand: 'Acme' }, picked_attributes: { process: 'natural' } });
      expect((await raw(beanMetaKey(record.bean.bean_id)))?.openFoodFacts).toEqual({ name: 'Guji', brand: 'Acme' });
      expect((await repo.getBean(record.bean.bean_id))?.bean).toEqual(record.bean);
    });

    it('refuses Open Food Facts data without a confirmed match or without a barcode, or over the limits', async () => {
      const repo = repoAt(NOW);
      await expect(repo.createBean({ vocabularyVersion: 1, barcode: ean(2, 2), openFoodFactsMatch: false, openFoodFacts: { name: 'x' }, pickedAttributes: {} })).rejects.toBeInstanceOf(InvalidValuesError);
      await expect(repo.createBean({ vocabularyVersion: 1, openFoodFactsMatch: true, openFoodFacts: { name: 'x' }, pickedAttributes: {} })).rejects.toBeInstanceOf(InvalidValuesError);
      await expect(repo.createBean({ vocabularyVersion: 1, barcode: ean(2, 3), openFoodFactsMatch: true, openFoodFacts: { name: 'x'.repeat(151) }, pickedAttributes: {} })).rejects.toBeInstanceOf(InvalidValuesError);
    });
  });

  describe('the route, end to end with a stubbed fetch', () => {
    const logs: LogEntry[] = [];
    const fetched: string[] = [];
    let api: ReturnType<typeof createApi>;

    beforeAll(() => {
      const fetch: Fetch = (url) => {
        fetched.push(url);
        const found = url.includes(`/${ean(3, 1)}.json`);
        return Promise.resolve(
          new Response(JSON.stringify(found ? { status: 1, product: { product_name: ' Ethiopia Guji ', brands: 'Rösterei Beispiel,X' } } : { status: 0 }), {
            status: found ? 200 : 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };
      const signer = testSigner();
      api = createApi({
        store: new Repository({ client: documentClient, tableName }),
        cursorSigner: () => Promise.resolve(signer),
        openFoodFacts: { client: createOpenFoodFactsClient({ contact: 'operator@example.org', fetch }), dailyCap: 5 },
        log: (entry) => logs.push(entry),
      });
    });

    async function call(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: unknown }> {
      const result = await api(apiEvent(method, path, options));
      return { status: result.statusCode ?? 0, body: result.body === undefined ? undefined : (JSON.parse(result.body) as unknown) };
    }

    it('hit, cache, confirm, then 409; a miss is 404; the cap holds under parallel calls', async () => {
      const hit = ean(3, 1);
      const first = await call('GET', `/barcodes/${hit}/open_food_facts`);
      expect(first).toEqual({ status: 200, body: { name: 'Ethiopia Guji', brand: 'Rösterei Beispiel' } });
      expect(await call('GET', `/barcodes/${hit}/open_food_facts`, { sub: BOB_SUB })).toEqual(first);
      expect(fetched).toHaveLength(1);

      expect((await call('POST', '/beans', { json: beanBody({ barcode: ean(3, 2), open_food_facts_confirmed: true }) })).status).toBe(409);
      const created = await call('POST', '/beans', { sub: BOB_SUB, json: beanBody({ barcode: hit, open_food_facts_confirmed: true }) });
      expect(created.status).toBe(201);
      const bean = BeanSchema.parse(created.body);
      expect(bean).toMatchObject({ open_food_facts_match: true, open_food_facts: { name: 'Ethiopia Guji', brand: 'Rösterei Beispiel' }, verified: false });
      expect((await call('GET', `/beans/${bean.bean_id}`)).body).toEqual(bean);
      expect((await call('GET', `/barcodes/${hit}/open_food_facts`)).status).toBe(409);

      const miss = ean(3, 2);
      expect((await call('GET', `/barcodes/${miss}/open_food_facts`)).status).toBe(404);
      expect((await raw(openFoodFactsCacheKey(miss)))?.result).toBe('miss');
      expect((await call('POST', '/beans', { json: beanBody({ barcode: miss, open_food_facts_confirmed: true }) })).status).toBe(409);

      // Alice has used 2 of 5 (the hit and the miss); 10 parallel lookups of new barcodes: exactly 3 fetch.
      const before = fetched.length;
      const statuses = await Promise.all(Array.from({ length: 10 }, (_, n) => call('GET', `/barcodes/${ean(3, 10 + n)}/open_food_facts`).then((r) => r.status)));
      expect(statuses.filter((s) => s === 404)).toHaveLength(3);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
      expect(fetched.length - before).toBe(3);
      // Bob used 0 fetches (his lookup was a cache hit).
      expect(await raw(lookupCounterKey(BOB, new Date().toISOString().slice(0, 10)))).toBeUndefined();
      expect((await raw(lookupCounterKey(ALICE, new Date().toISOString().slice(0, 10))))?.lookups).toBe(5);

      const text = JSON.stringify(logs);
      for (const leaked of [hit, miss, 'Ethiopia', 'Beispiel', ALICE_SUB, BOB_SUB, 'operator@example.org']) expect(text).not.toContain(leaked);
    });
  });
});
