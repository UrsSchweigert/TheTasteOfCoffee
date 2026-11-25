// The bean catalogue routes (M1-T4a): GET /barcodes/{barcode}, POST /beans,
// GET /beans/{bean_id}, against the in-memory store. Barcodes known, unknown,
// malformed and with a bad check digit; UPC-A and EAN-13 of one product;
// body validation against the vocabulary version sent; the 409s; rejected
// beans are 404 and free their barcode; the catalogue is shared, and no
// response carries a user id.
import { describe, expect, it } from 'vitest';
import { BeanSchema } from '../../src/generated/contract.ts';
import type { Bean } from '../../src/generated/contract.ts';
import { CorruptItemError, WriteConflictError } from '../../src/repository/index.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BOB_SUB, beanBody, harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

/** Valid check digits. */
const EAN13 = '4006381333931';
const UPC_A = '036000291452';
const UPC_A_AS_EAN13 = '0036000291452';
const UNKNOWN = '0012345678905';
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

async function created(h: Harness, body: Record<string, unknown> = beanBody(), sub = ALICE_SUB): Promise<Bean> {
  const response = await h.call('POST', '/beans', { sub, json: body });
  expect(response.status).toBe(201);
  return BeanSchema.parse(response.body);
}

function expectNoBody(response: { result: { body?: string | undefined } }): void {
  expect(response.result.body).toBeUndefined();
}

describe('GET /barcodes/{barcode}', () => {
  it('a known barcode returns its bean, exactly the contract Bean', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: EAN13 }));
    const response = await h.call('GET', `/barcodes/${EAN13}`, { sub: BOB_SUB });
    expect(response.status).toBe(200);
    expect(BeanSchema.parse(response.body)).toEqual(bean);
    expect(response.result.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  });

  it('an unknown barcode is 404 with no body', async () => {
    const h = harness();
    const response = await h.call('GET', `/barcodes/${UNKNOWN}`);
    expect(response.status).toBe(404);
    expectNoBody(response);
    expect(h.store.calls).toEqual(['getBeanByBarcode']);
  });

  it('the UPC-A and the EAN-13 form of one product give the same bean, stored as EAN-13', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: UPC_A }));
    expect(bean.barcode).toBe(UPC_A_AS_EAN13);
    const byUpc = await h.call('GET', `/barcodes/${UPC_A}`);
    const byEan = await h.call('GET', `/barcodes/${UPC_A_AS_EAN13}`);
    expect(byUpc.status).toBe(200);
    expect(byUpc.body).toEqual(bean);
    expect(byEan.body).toEqual(bean);
  });

  it.each([
    ['letters', '40063813339A1'],
    ['11 digits', '40063813339'],
    ['14 digits', '40063813339310'],
    ['8 digits (EAN-8 is not in the contract)', '96385074'],
    ['a sign', '+006381333931'],
    ['an encoded space', '4006381333931%20'],
    ['an encoded hash', '400638133393%23'],
    ['an injected key', 'BEAN%23x'],
    ['Arabic-Indic digits', '٤٠٠٦٣٨١٣٣٣٩٣١'],
  ])('a malformed barcode (%s) is 400 and never reaches the store', async (_name, bad) => {
    const h = harness();
    const response = await h.call('GET', `/barcodes/${bad}`);
    expect(response.status).toBe(400);
    expectNoBody(response);
    expect(h.store.calls).toEqual([]);
  });

  it.each([['EAN-13', '4006381333932'], ['UPC-A', '036000291453'], ['all zeros but the check digit', '0000000000001']])(
    'a bad check digit (%s) is 400 and never reaches the store',
    async (_name, bad) => {
      const h = harness();
      expect((await h.call('GET', `/barcodes/${bad}`)).status).toBe(400);
      expect(h.store.calls).toEqual([]);
    },
  );

  it('takes no query and no body', async () => {
    const h = harness();
    await created(h, beanBody({ barcode: EAN13 }));
    expect((await h.call('GET', `/barcodes/${EAN13}`, { query: 'x=1' })).status).toBe(400);
    expect((await h.call('GET', `/barcodes/${EAN13}`, { json: {} })).status).toBe(400);
  });

  it('a pointer to a missing bean is 500, never another answer', async () => {
    const store = new FakeStore();
    store.getBeanByBarcode = () => Promise.reject(new CorruptItemError('dangling'));
    const h = harness({ store });
    const response = await h.call('GET', `/barcodes/${EAN13}`);
    expect(response.status).toBe(500);
    expectNoBody(response);
    expect(h.logs.at(-1)).toEqual({ operation: 'lookupBarcode', status: 500, request_id: 'request-1', error: 'CorruptItemError' });
  });
});

describe('POST /beans', () => {
  it('creates an unverified bean; every picked value is in picked_attributes, the operator group is empty', async () => {
    const h = harness();
    const response = await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13 }) });
    expect(response.status).toBe(201);
    const bean = BeanSchema.parse(response.body);
    expect(bean).toEqual({
      bean_id: bean.bean_id,
      vocabulary_version: 1,
      verified: false,
      barcode: EAN13,
      open_food_facts_match: false,
      picked_attributes: { process: 'washed', roast_level: 'light' },
      operator_attributes: {},
    });
    expect(bean).not.toHaveProperty('open_food_facts');
    expect(h.store.catalogue.get(bean.bean_id)?.status).toBe('unverified');
  });

  it('a barcode is optional', async () => {
    const h = harness();
    const bean = await created(h, beanBody({}, {}));
    expect(bean).not.toHaveProperty('barcode');
    expect(bean.picked_attributes).toEqual({});
  });

  it('origin, species and variety need vocabulary version 2', async () => {
    const h = harness();
    for (const attributes of [{ origin: 'ethiopia' }, { species: 'arabica' }, { variety: 'geisha' }]) {
      const v1 = await h.call('POST', '/beans', { json: beanBody({ vocabulary_version: 1 }, attributes) });
      expect(v1.status, JSON.stringify(attributes)).toBe(400);
      expectNoBody(v1);
    }
    expect(h.store.calls).toEqual([]);
    const all = { process: 'natural', roast_level: 'medium', origin: 'sumatra', species: 'arabica', variety: 'heirloom' };
    const bean = await created(h, beanBody({ vocabulary_version: 2 }, all));
    expect(bean.vocabulary_version).toBe(2);
    expect(bean.picked_attributes).toEqual(all);
  });

  it.each([
    ['an unknown top-level property', { ...beanBody(), name: 'My coffee' }],
    ['an unknown attribute', beanBody({}, { roaster: 'acme' })],
    ['a user id in the body', { ...beanBody(), sub: BOB_SUB }],
    ['Open Food Facts text from the client', { ...beanBody({ barcode: EAN13 }), open_food_facts: { name: 'x' } }],
    ['picked_attributes instead of attributes', { vocabulary_version: 1, picked_attributes: {} }],
    ['operator attributes', { ...beanBody(), operator_attributes: { process: 'washed' } }],
    ['verified', { ...beanBody(), verified: true }],
    ['a bean id', { ...beanBody(), bean_id: ID }],
    ['an off-vocabulary process', beanBody({}, { process: 'sun_dried' })],
    ['an off-vocabulary origin', beanBody({ vocabulary_version: 2 }, { origin: 'atlantis' })],
    ['an off-vocabulary variety', beanBody({ vocabulary_version: 2 }, { variety: 'robusta' })],
    ['a label instead of an id', beanBody({}, { process: 'Washed' })],
    ['an unpublished vocabulary version', beanBody({ vocabulary_version: 3 })],
    ['no vocabulary version', { attributes: {} }],
    ['no attributes', { vocabulary_version: 1 }],
    ['a numeric barcode', beanBody({ barcode: 4006381333931 })],
    ['a malformed barcode', beanBody({ barcode: '4006-381333931' })],
    ['a barcode with a bad check digit', beanBody({ barcode: '4006381333932' })],
    ['open_food_facts_confirmed without a barcode', beanBody({ open_food_facts_confirmed: true })],
    ['open_food_facts_confirmed as a string', beanBody({ barcode: EAN13, open_food_facts_confirmed: 'true' })],
    ['an array', [beanBody()]],
  ])('%s is 400 with no body and never reaches the store', async (_name, body) => {
    const h = harness();
    const response = await h.call('POST', '/beans', { json: body });
    expect(response.status).toBe(400);
    expectNoBody(response);
    expect(h.store.calls).toEqual([]);
  });

  it('takes no query', async () => {
    const h = harness();
    expect((await h.call('POST', '/beans', { query: 'barcode=4006381333931', json: beanBody() })).status).toBe(400);
    expect(h.store.calls).toEqual([]);
  });

  it('open_food_facts_confirmed: true without a cached entry is 409, and writes nothing', async () => {
    const h = harness();
    const response = await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13, open_food_facts_confirmed: true }) });
    expect(response.status).toBe(409);
    expectNoBody(response);
    expect(h.store.calls).toEqual(['getOpenFoodFactsCache']);
    expect(h.logs.at(-1)).toEqual({ operation: 'createBean', status: 409, request_id: 'request-1', error: 'OpenFoodFactsHitMissingError' });
    expect((await h.call('GET', `/barcodes/${EAN13}`)).status).toBe(404);
  });

  it('open_food_facts_confirmed: false is a plain pick-list bean', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: EAN13, open_food_facts_confirmed: false }));
    expect(bean.open_food_facts_match).toBe(false);
  });

  it('a barcode that already points to a bean is 409 with no body, in either form, and is not retried', async () => {
    const h = harness();
    const first = await created(h, beanBody({ barcode: UPC_A }));
    for (const barcode of [UPC_A, UPC_A_AS_EAN13]) {
      const before = h.store.calls.length;
      const response = await h.call('POST', '/beans', { sub: BOB_SUB, json: beanBody({ barcode }) });
      expect(response.status).toBe(409);
      expectNoBody(response);
      expect(h.store.calls.slice(before)).toEqual(['createBean']);
      expect(h.logs.at(-1)?.error).toBe('BarcodeTakenError');
    }
    expect(h.store.catalogue.size).toBe(1);
    expect((await h.call('GET', `/barcodes/${UPC_A}`)).body).toEqual(first);
  });

  it('a write that raced is retried, up to three tries in all', async () => {
    const store = new FakeStore();
    let failures = 2;
    const original = store.createBean.bind(store);
    store.createBean = (input) => (failures-- > 0 ? Promise.reject(new WriteConflictError('raced')) : original(input));
    const delays: number[] = [];
    const h = harness({ store, retryDelayMs: (retry) => (delays.push(retry), 0) });
    expect((await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13 }) })).status).toBe(201);
    expect(delays).toEqual([1, 2]);
    failures = 3;
    expect((await h.call('POST', '/beans', { json: beanBody() })).status).toBe(500);
  });
});

describe('GET /beans/{bean_id}', () => {
  it('returns an unverified bean to any signed-in user: the catalogue is shared', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: EAN13 }));
    for (const sub of [ALICE_SUB, BOB_SUB]) {
      const response = await h.call('GET', `/beans/${bean.bean_id}`, { sub });
      expect(response.status).toBe(200);
      expect(BeanSchema.parse(response.body)).toEqual(bean);
    }
  });

  it('an unknown bean is 404 with no body', async () => {
    const h = harness();
    const response = await h.call('GET', `/beans/${ID}`);
    expect(response.status).toBe(404);
    expectNoBody(response);
  });

  it('takes no query and no body', async () => {
    const h = harness();
    const bean = await created(h);
    expect((await h.call('GET', `/beans/${bean.bean_id}`, { query: 'verified=true' })).status).toBe(400);
    expect((await h.call('GET', `/beans/${bean.bean_id}`, { json: {} })).status).toBe(400);
  });
});

describe('a rejected bean', () => {
  it('is 404 by id and by barcode, and its barcode is free for a new entry', async () => {
    const h = harness();
    const rejected = await created(h, beanBody({ barcode: EAN13 }));
    h.store.rejectBean(rejected.bean_id);
    expect(h.store.catalogue.get(rejected.bean_id)?.status).toBe('rejected');

    const byId = await h.call('GET', `/beans/${rejected.bean_id}`);
    expect(byId.status).toBe(404);
    expectNoBody(byId);
    expect((await h.call('GET', `/barcodes/${EAN13}`)).status).toBe(404);

    const fresh = await created(h, beanBody({ barcode: EAN13 }, { process: 'natural' }), BOB_SUB);
    expect(fresh.bean_id).not.toBe(rejected.bean_id);
    expect((await h.call('GET', `/barcodes/${EAN13}`)).body).toEqual(fresh);
    expect((await h.call('GET', `/beans/${rejected.bean_id}`)).status).toBe(404);
  });

  it('is 404 even if a barcode still pointed to it (a read racing the reject)', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: EAN13 }));
    h.store.rejectBean(bean.bean_id);
    h.store.barcodes.set(EAN13, bean.bean_id);
    expect((await h.call('GET', `/barcodes/${EAN13}`)).status).toBe(404);
  });
});

describe('privacy', () => {
  it('no response and no log line carries a user id, a barcode or a picked value', async () => {
    const h = harness();
    const bean = await created(h, beanBody({ barcode: EAN13, vocabulary_version: 2 }, { origin: 'kenya' }));
    const responses = [
      await h.call('GET', `/beans/${bean.bean_id}`, { sub: BOB_SUB }),
      await h.call('GET', `/barcodes/${EAN13}`, { sub: BOB_SUB }),
      await h.call('POST', '/beans', { sub: BOB_SUB, json: beanBody({ barcode: EAN13 }) }),
      await h.call('POST', '/beans', { json: { ...beanBody(), note: 'secret' } }),
    ];
    const bodies = JSON.stringify(responses.map((r) => r.result.body ?? null));
    expect(bodies).not.toContain(ALICE_SUB);
    expect(bodies).not.toContain(BOB_SUB);
    expect(bodies).not.toContain('secret');
    const logs = JSON.stringify(h.logs);
    for (const leaked of [ALICE_SUB, BOB_SUB, EAN13, bean.bean_id, 'kenya', 'secret']) expect(logs).not.toContain(leaked);
    for (const entry of h.logs) expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['operation', 'request_id', 'status']));
  });
});
