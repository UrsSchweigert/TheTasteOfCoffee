// GET /barcodes/{barcode}/open_food_facts and POST /beans with
// open_food_facts_confirmed (M1-T4b), through the router with the in-memory
// store and a stubbed fetch: no test reaches Open Food Facts. Every response
// code, the order of the checks, what counts against the daily cap (only real
// fetches) and the cap at its boundary, the cache, the copy into a bean, and
// logs without a barcode, a name, a brand or a user id.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOKUP_CAP, MAX_LOOKUP_CAP, lookupCapFromEnv } from '../../src/api/config.ts';
import { BeanSchema, OpenFoodFactsProductSchema } from '../../src/generated/contract.ts';
import { createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import type { Fetch } from '../../src/openfoodfacts/client.ts';
import { OPEN_FOOD_FACTS_MISS_TTL_SECONDS } from '../../src/repository/index.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BOB_SUB, beanBody, harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

const CONTACT = 'operator@example.org';
const EAN13 = '4006381333931';
const UPC_A = '036000291452';
const UPC_A_AS_EAN13 = '0036000291452';
const OTHER = '0012345678905';
const NAME = 'Ethiopia Guji Natural';
const BRAND = 'Rösterei Beispiel';

/** Valid EAN-13s, for the cap tests: 12 digits plus the GS1 check digit. */
function ean(n: number): string {
  const body = String(400000000000 + n).padStart(12, '0');
  const sum = Array.from(body, Number).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${String((10 - (sum % 10)) % 10)}`;
}

type Responder = (url: string) => Response | Promise<Response>;

const hitResponse = (fields: Record<string, unknown> = { product_name: NAME, brands: `${BRAND}, Group` }): Response =>
  new Response(JSON.stringify({ status: 1, product: fields }), { status: 200, headers: { 'content-type': 'application/json' } });
const missResponse = (): Response =>
  new Response(JSON.stringify({ status: 0, status_verbose: 'product not found' }), { status: 404, headers: { 'content-type': 'application/json' } });

interface Setup extends Harness {
  readonly fetched: string[];
}

function setup(options: { respond?: Responder; contact?: string | undefined; cap?: number | undefined; store?: FakeStore; noConfig?: boolean } = {}): Setup {
  const fetched: string[] = [];
  const respond = options.respond ?? (() => hitResponse());
  const fetch: Fetch = async (url) => {
    fetched.push(url);
    return respond(url);
  };
  const contact = 'contact' in options ? options.contact : CONTACT;
  const cap = 'cap' in options ? options.cap : 50;
  const h = harness({
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.noConfig === true ? {} : { openFoodFacts: { client: createOpenFoodFactsClient({ contact, fetch, timeoutMs: 50 }), dailyCap: cap } }),
  });
  return Object.assign(h, { fetched });
}

const lookup = (h: Harness, barcode: string, sub = ALICE_SUB): ReturnType<Harness['call']> => h.call('GET', `/barcodes/${barcode}/open_food_facts`, { sub });

function counted(h: Harness): number {
  return [...h.store.lookupCounters.values()].reduce((a, b) => a + b, 0);
}

function expectNoBody(response: { result: { body?: string | undefined } }): void {
  expect(response.result.body).toBeUndefined();
}

describe('GET /barcodes/{barcode}/open_food_facts', () => {
  describe('400: before anything is read or counted', () => {
    it.each([
      ['letters', '40063813339A1'],
      ['11 digits', '40063813339'],
      ['an encoded hash', '400638133393%23'],
      ['a bad check digit', '4006381333932'],
      ['a bad UPC-A check digit', '036000291453'],
    ])('%s', async (_name, bad) => {
      const h = setup();
      const response = await lookup(h, bad);
      expect(response.status).toBe(400);
      expectNoBody(response);
      expect(h.store.calls).toEqual([]);
      expect(h.fetched).toEqual([]);
    });

    it('a query or a body', async () => {
      const h = setup();
      expect((await h.call('GET', `/barcodes/${EAN13}/open_food_facts`, { query: 'lang=de' })).status).toBe(400);
      expect((await h.call('GET', `/barcodes/${EAN13}/open_food_facts`, { json: {} })).status).toBe(400);
      expect(h.store.calls).toEqual([]);
      expect(h.fetched).toEqual([]);
    });
  });

  describe('409: the barcode is already in the catalogue', () => {
    it('in either form; no cache read, nothing counted, no fetch', async () => {
      const h = setup();
      expect((await h.call('POST', '/beans', { json: beanBody({ barcode: UPC_A }) })).status).toBe(201);
      for (const barcode of [UPC_A, UPC_A_AS_EAN13]) {
        const before = h.store.calls.length;
        const response = await lookup(h, barcode, BOB_SUB);
        expect(response.status).toBe(409);
        expectNoBody(response);
        expect(h.store.calls.slice(before)).toEqual(['getBeanByBarcode']);
        expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 409, request_id: 'request-1', error: 'BarcodeInCatalogue' });
      }
      expect(h.fetched).toEqual([]);
      expect(counted(h)).toBe(0);
    });

    it('a barcode whose bean was rejected is free again: the lookup goes on', async () => {
      const h = setup();
      const created = BeanSchema.parse((await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13 }) })).body);
      h.store.rejectBean(created.bean_id);
      expect((await lookup(h, EAN13)).status).toBe(200);
      // Even a pointer still naming the rejected bean (a read racing the reject) is not 409.
      h.store.barcodes.set(EAN13, created.bean_id);
      expect((await lookup(h, EAN13)).status).toBe(200);
    });
  });

  describe('from the cache', () => {
    it('a cached hit is 200 with exactly the OpenFoodFactsProduct; not counted, no fetch', async () => {
      const h = setup();
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'hit', product: { name: NAME, brand: BRAND } } });
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(200);
      expect(OpenFoodFactsProductSchema.parse(response.body)).toEqual({ name: NAME, brand: BRAND });
      expect(response.result.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      expect(h.fetched).toEqual([]);
      expect(h.store.calls).toEqual(['getBeanByBarcode', 'getOpenFoodFactsCache']);
      expect(counted(h)).toBe(0);
    });

    it('a cached hit is found by the UPC-A form too', async () => {
      const h = setup();
      h.store.openFoodFactsCache.set(UPC_A_AS_EAN13, { entry: { kind: 'hit', product: { brand: BRAND } } });
      expect((await lookup(h, UPC_A)).body).toEqual({ brand: BRAND });
    });

    it('an unexpired miss is 404 with no body; not counted, no fetch', async () => {
      const h = setup();
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'miss' }, expiresAt: Math.floor(h.store.now.getTime() / 1000) + 1 });
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(404);
      expectNoBody(response);
      expect(h.fetched).toEqual([]);
      expect(counted(h)).toBe(0);
    });

    it('an expired miss counts as absent: fetched again and counted', async () => {
      const h = setup();
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'miss' }, expiresAt: Math.floor(h.store.now.getTime() / 1000) });
      expect((await lookup(h, EAN13)).status).toBe(200);
      expect(h.fetched).toHaveLength(1);
      expect(counted(h)).toBe(1);
    });

    it('the cache answers even without Open Food Facts configuration and when the cap is used up', async () => {
      const h = setup({ contact: undefined, cap: 0 });
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'hit', product: { name: NAME } } });
      expect((await lookup(h, EAN13)).status).toBe(200);
    });
  });

  describe('fetching', () => {
    it('a hit is cached and 200; the next call, by anyone, comes from the cache', async () => {
      const h = setup();
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ name: NAME, brand: BRAND });
      expect(h.fetched).toHaveLength(1);
      expect(h.store.openFoodFactsCache.get(EAN13)).toEqual({ entry: { kind: 'hit', product: { name: NAME, brand: BRAND } } });
      expect(h.store.calls).toEqual(['getBeanByBarcode', 'getOpenFoodFactsCache', 'countLookup', 'cacheOpenFoodFactsResult']);
      expect((await lookup(h, EAN13, BOB_SUB)).body).toEqual({ name: NAME, brand: BRAND });
      expect(h.fetched).toHaveLength(1);
      expect(counted(h)).toBe(1);
    });

    it('the stored and returned text is cleaned and cut', async () => {
      const h = setup({ respond: () => hitResponse({ product_name: `  ${'\u{1F375}'.repeat(200)}\n`, brands: '‮Acme\u0000, B' }) });
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(200);
      const product = OpenFoodFactsProductSchema.parse(response.body);
      expect(Array.from(product.name ?? '')).toHaveLength(150);
      expect(product.brand).toBe('Acme');
    });

    it('no product is cached as a miss for 30 days and is 404', async () => {
      const h = setup({ respond: missResponse });
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(404);
      expectNoBody(response);
      const nowSeconds = Math.floor(h.store.now.getTime() / 1000);
      expect(h.store.openFoodFactsCache.get(EAN13)).toEqual({ entry: { kind: 'miss' }, expiresAt: nowSeconds + OPEN_FOOD_FACTS_MISS_TTL_SECONDS });
      expect(OPEN_FOOD_FACTS_MISS_TTL_SECONDS).toBe(30 * 24 * 3600);
      expect((await lookup(h, EAN13)).status).toBe(404);
      expect(h.fetched).toHaveLength(1);
      // 30 days later the miss has expired and the barcode is asked again.
      h.store.now = new Date(h.store.now.getTime() + OPEN_FOOD_FACTS_MISS_TTL_SECONDS * 1000);
      expect((await lookup(h, EAN13)).status).toBe(404);
      expect(h.fetched).toHaveLength(2);
    });

    it('a product without a name or brand is a miss (404)', async () => {
      const h = setup({ respond: () => hitResponse({ product_name: ' ', brands: '' }) });
      expect((await lookup(h, EAN13)).status).toBe(404);
      expect(h.store.openFoodFactsCache.get(EAN13)?.entry).toEqual({ kind: 'miss' });
    });

    it.each<[string, Responder]>([
      ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
      ['a timeout', () => new Promise<Response>(() => undefined)],
      ['HTTP 500', () => new Response('', { status: 500 })],
      ['HTTP 429 from Open Food Facts', () => new Response('', { status: 429 })],
      ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })],
      ['garbage', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ])('%s is 503 with no body; nothing is cached; the fetch stays counted', async (_name, respond) => {
      const h = setup({ respond });
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(503);
      expectNoBody(response);
      expect(h.store.openFoodFactsCache.size).toBe(0);
      expect(h.store.calls).not.toContain('cacheOpenFoodFactsResult');
      expect(counted(h)).toBe(1);
      expect(h.logs.at(-1)).toMatchObject({ operation: 'lookupOpenFoodFacts', status: 503, error: 'OpenFoodFactsUnavailable' });
    });

    it('two racing fetches of one barcode give the hit that was stored first', async () => {
      const h = setup({ respond: () => hitResponse({ product_name: 'Second' }) });
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'hit', product: { name: 'First' } } });
      // A lookup that read the cache before the first fetch stored its hit:
      h.store.getOpenFoodFactsCache = () => Promise.resolve(undefined);
      expect((await lookup(h, EAN13)).body).toEqual({ name: 'First' });
    });
  });

  describe('503: no outbound call without configuration', () => {
    it.each([
      ['no OFF_CONTACT', { contact: undefined }],
      ['an OFF_CONTACT that is not an address', { contact: 'not-an-address' }],
      ['an invalid OFF_LOOKUP_CAP', { cap: undefined }],
      ['no Open Food Facts dependencies at all', { noConfig: true }],
    ])('%s: 503, nothing counted, nothing fetched, nothing cached', async (_name, options) => {
      const h = setup(options);
      const response = await lookup(h, EAN13);
      expect(response.status).toBe(503);
      expectNoBody(response);
      expect(h.fetched).toEqual([]);
      expect(counted(h)).toBe(0);
      expect(h.store.calls).toEqual(['getBeanByBarcode', 'getOpenFoodFactsCache']);
    });
  });

  describe('the daily cap (429)', () => {
    it('allows exactly `cap` fetches a UTC day, then 429 with no fetch; the cache still answers', async () => {
      const cap = 3;
      const h = setup({ cap });
      for (let n = 0; n < cap; n += 1) expect((await lookup(h, ean(n))).status).toBe(200);
      expect(h.fetched).toHaveLength(cap);
      const over = await lookup(h, ean(cap));
      expect(over.status).toBe(429);
      expectNoBody(over);
      expect(h.fetched).toHaveLength(cap);
      expect(h.store.openFoodFactsCache.has(ean(cap))).toBe(false);
      expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 429, request_id: 'request-1', error: 'LookupCapReached' });
      // Cached barcodes are not counted, so they still answer.
      expect((await lookup(h, ean(0))).status).toBe(200);
      // 400 and 409 do not count either: they come before the counter.
      expect((await lookup(h, '4006381333932')).status).toBe(400);
      // Another user has their own cap.
      expect((await lookup(h, ean(cap), BOB_SUB)).status).toBe(200);
      // The next UTC day starts again.
      h.store.now = new Date('2026-11-26T00:00:00.000Z');
      expect((await lookup(h, ean(cap + 1))).status).toBe(200);
    });

    it('misses and failed fetches count too: each is a real call to Open Food Facts', async () => {
      let n = 0;
      const h = setup({ cap: 2, respond: () => (n++ === 0 ? missResponse() : new Response('', { status: 500 })) });
      expect((await lookup(h, ean(0))).status).toBe(404);
      expect((await lookup(h, ean(1))).status).toBe(503);
      expect((await lookup(h, ean(1))).status).toBe(429);
    });

    it('cap 0 allows no fetch at all', async () => {
      const h = setup({ cap: 0 });
      expect((await lookup(h, EAN13)).status).toBe(429);
      expect(h.fetched).toEqual([]);
    });

    it('the default cap is 50', async () => {
      expect(DEFAULT_LOOKUP_CAP).toBe(50);
      const h = setup({ cap: lookupCapFromEnv(undefined) });
      for (let n = 0; n < 50; n += 1) expect((await lookup(h, ean(n))).status).toBe(200);
      expect((await lookup(h, ean(50))).status).toBe(429);
    });
  });

  it('a store failure is 500 with no body', async () => {
    const store = new FakeStore();
    store.countLookup = () => Promise.reject(new Error('boom'));
    const h = setup({ store });
    expect((await lookup(h, EAN13)).status).toBe(500);
  });
});

describe('OFF_LOOKUP_CAP', () => {
  it.each<[string | undefined, number | undefined]>([
    [undefined, 50],
    ['', 50],
    ['  ', 50],
    ['0', 0],
    ['1', 1],
    ['50', 50],
    [' 20 ', 20],
    [String(MAX_LOOKUP_CAP), MAX_LOOKUP_CAP],
    [String(MAX_LOOKUP_CAP + 1), undefined],
    ['-1', undefined],
    ['1.5', undefined],
    ['1e3', undefined],
    ['050', undefined],
    ['0x10', undefined],
    ['fifty', undefined],
    ['99999999999', undefined],
  ])('%j is %j', (value, expected) => {
    expect(lookupCapFromEnv(value)).toBe(expected);
  });
});

describe('POST /beans with open_food_facts_confirmed', () => {
  const confirmed = (barcode = EAN13): Record<string, unknown> => beanBody({ barcode, open_food_facts_confirmed: true });

  it('copies name and brand from the cached hit into the open_food_facts group', async () => {
    const h = setup();
    expect((await lookup(h, UPC_A)).status).toBe(200);
    const response = await h.call('POST', '/beans', { json: confirmed(UPC_A) });
    expect(response.status).toBe(201);
    const bean = BeanSchema.parse(response.body);
    expect(bean).toEqual({
      bean_id: bean.bean_id,
      vocabulary_version: 1,
      verified: false,
      barcode: UPC_A_AS_EAN13,
      open_food_facts_match: true,
      open_food_facts: { name: NAME, brand: BRAND },
      picked_attributes: { process: 'washed', roast_level: 'light' },
      operator_attributes: {},
    });
    expect((await h.call('GET', `/barcodes/${UPC_A}`, { sub: BOB_SUB })).body).toEqual(bean);
    // Now catalogued: the lookup is 409.
    expect((await lookup(h, UPC_A_AS_EAN13)).status).toBe(409);
  });

  it('a hit with only a brand gives a group with only the brand', async () => {
    const h = setup();
    h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'hit', product: { brand: BRAND } } });
    const bean = BeanSchema.parse((await h.call('POST', '/beans', { json: confirmed() })).body);
    expect(bean.open_food_facts).toEqual({ brand: BRAND });
  });

  it.each([
    ['no cached entry', (_store: FakeStore) => undefined],
    ['a cached miss', (store: FakeStore) => store.openFoodFactsCache.set(EAN13, { entry: { kind: 'miss' }, expiresAt: Math.floor(store.now.getTime() / 1000) + 60 })],
    ['an expired miss', (store: FakeStore) => store.openFoodFactsCache.set(EAN13, { entry: { kind: 'miss' }, expiresAt: Math.floor(store.now.getTime() / 1000) })],
    ['a hit for another barcode', (store: FakeStore) => store.openFoodFactsCache.set(OTHER, { entry: { kind: 'hit', product: { name: NAME } } })],
  ])('%s is 409 with no body; nothing is written, nothing fetched', async (_name, arrange) => {
    const h = setup();
    arrange(h.store);
    const response = await h.call('POST', '/beans', { json: confirmed() });
    expect(response.status).toBe(409);
    expectNoBody(response);
    expect(h.store.calls).toEqual(['getOpenFoodFactsCache']);
    expect(h.store.catalogue.size).toBe(0);
    expect(h.fetched).toEqual([]);
    expect(h.logs.at(-1)).toEqual({ operation: 'createBean', status: 409, request_id: 'request-1', error: 'OpenFoodFactsHitMissingError' });
  });

  it('a confirmed hit for a barcode that is already taken is 409 (BarcodeTakenError)', async () => {
    const h = setup();
    expect((await lookup(h, EAN13)).status).toBe(200);
    expect((await h.call('POST', '/beans', { json: confirmed() })).status).toBe(201);
    expect((await h.call('POST', '/beans', { sub: BOB_SUB, json: confirmed() })).status).toBe(409);
    expect(h.logs.at(-1)?.error).toBe('BarcodeTakenError');
  });

  it('without the flag (or with false) no Open Food Facts data is copied, even with a cached hit', async () => {
    const h = setup();
    expect((await lookup(h, EAN13)).status).toBe(200);
    const bean = BeanSchema.parse((await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13, open_food_facts_confirmed: false }) })).body);
    expect(bean.open_food_facts_match).toBe(false);
    expect(bean).not.toHaveProperty('open_food_facts');
  });

  it('the client cannot send the text itself', async () => {
    const h = setup();
    const body = { ...confirmed(), open_food_facts: { name: 'Mine' } };
    expect((await h.call('POST', '/beans', { json: body })).status).toBe(400);
    expect(h.store.calls).toEqual([]);
  });
});

describe('privacy', () => {
  it('no log line carries a barcode, a name, a brand, the contact or a user id', async () => {
    let n = 0;
    const responders: Responder[] = [() => hitResponse(), missResponse, () => Promise.reject(new TypeError(`fetch failed for ${NAME}`))];
    const h = setup({ cap: 4, respond: (url) => (responders[n++] ?? (() => hitResponse()))(url) });
    await lookup(h, EAN13);
    await lookup(h, EAN13);
    await lookup(h, OTHER);
    await lookup(h, UPC_A);
    await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13, open_food_facts_confirmed: true }) });
    await lookup(h, EAN13);
    await lookup(h, ean(7));
    await lookup(h, ean(8));
    const statuses = h.logs.map((entry) => entry.status);
    expect(statuses).toEqual([200, 200, 404, 503, 201, 409, 200, 429]);
    expect(h.logs[3]).toEqual({ operation: 'lookupOpenFoodFacts', status: 503, request_id: 'request-1', error: 'OpenFoodFactsUnavailable', reason: 'network' });
    const text = JSON.stringify(h.logs);
    for (const leaked of [EAN13, OTHER, UPC_A, UPC_A_AS_EAN13, ean(7), ean(8), NAME, BRAND, 'Ethiopia', 'Beispiel', CONTACT, ALICE_SUB, BOB_SUB]) {
      expect(text).not.toContain(leaked);
    }
    for (const entry of h.logs) {
      for (const key of Object.keys(entry)) expect(['operation', 'status', 'request_id', 'error', 'reason', 'image']).toContain(key);
    }
  });
});
