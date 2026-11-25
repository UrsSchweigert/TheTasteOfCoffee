// The API router (M1-T5): which routes exist, the 401 without a token, the
// full create-read-update-delete flow per resource, cross-user isolation,
// references (404 and 409), signed cursors, limits, error mapping and logs.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIMIT_QUERY } from '../../src/api/http.ts';
import { ROUTES } from '../../src/api/router.ts';
import { BeanSchema, BrewPageSchema, BrewSchema, RecipePageSchema, RecipeSchema, ShelfEntryPageSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { WriteConflictError, encodeCursor } from '../../src/repository/index.ts';
import { OPENAPI_FILE, parseOpenApi } from '../../scripts/codegen/paths.ts';
import { verifiedUserId } from '../events.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BEAN, BOB_SUB, beanBody, brewBody, harness, recipeBody, shelfBody, testSigner } from './helpers.ts';
import type { Harness } from './helpers.ts';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

interface OpenApi {
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { parameters: Record<string, { schema: Record<string, unknown> }> };
}
const contract = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')) as OpenApi;

async function newShelf(h: Harness, sub = ALICE_SUB): Promise<string> {
  const response = await h.call('POST', '/shelf', { sub, json: shelfBody() });
  expect(response.status).toBe(201);
  return ShelfEntrySchema.parse(response.body).shelf_entry_id;
}

describe('routes', () => {
  it('serves exactly the shelf, brew, recipe and bean catalogue operations of the contract', () => {
    const served = ROUTES.map((route) => `${route.method} ${route.segments.join('/')} ${route.operation}`).sort();
    const expected: string[] = [];
    for (const path of [
      '/shelf',
      '/shelf/{shelf_entry_id}',
      '/brews',
      '/brews/{brew_id}',
      '/recipes',
      '/recipes/{recipe_id}',
      '/barcodes/{barcode}',
      '/beans',
      '/beans/{bean_id}',
    ]) {
      for (const [method, operation] of Object.entries(contract.paths[path] ?? {})) {
        expected.push(`${method.toUpperCase()} ${path} ${operation.operationId}`);
      }
    }
    expect(served).toEqual(expected.sort());
    expect(served).toHaveLength(18);
  });

  it.each([
    ['GET', '/profile'],
    ['PUT', '/profile'],
    ['GET', '/beans'],
    ['PUT', `/beans/${ID}`],
    ['DELETE', `/beans/${ID}`],
    ['POST', '/barcodes/4006381333931'],
    ['GET', '/barcodes'],
    ['GET', '/barcodes/4006381333931/'],
    ['GET', '/barcodes/4006381333931/open_food_facts'],
    ['GET', `/catalogue_images/${ID}`],
    ['GET', '/export'],
    ['DELETE', '/account'],
    ['GET', '/health'],
    ['GET', '/'],
    ['GET', '/nothing'],
    ['PATCH', '/shelf'],
    ['DELETE', '/shelf'],
    ['PUT', '/brews'],
    ['POST', `/recipes/${ID}`],
    ['OPTIONS', '/shelf'],
    ['HEAD', '/shelf'],
    ['GET', '/shelf/'],
    ['GET', `/shelf/${ID}/`],
    ['GET', `/shelf/${ID}/brews`],
    ['GET', '//shelf'],
    ['GET', '/Shelf'],
    ['GET', '/v1/shelf'],
  ])('%s %s is 404 with no body, token or not', async (method, path) => {
    const h = harness();
    for (const sub of [ALICE_SUB, null]) {
      const response = await h.call(method, path, { sub });
      expect(response.status).toBe(404);
      expect(response.result.body).toBeUndefined();
    }
    expect(h.store.calls).toEqual([]);
  });

  it.each(ROUTES.map((route) => [route.method, route.segments.join('/').replace('{barcode}', '4006381333931').replace(/\{[a-z_]+\}/, ID)]))(
    '%s %s without a valid token is 401 with no body',
    async (method, path) => {
      const h = harness();
      const json = path.startsWith('/brews')
        ? brewBody(ID)
        : path.startsWith('/shelf')
          ? shelfBody()
          : path.startsWith('/beans')
            ? beanBody()
            : recipeBody();
      const body = method === 'POST' || method === 'PUT' ? { json } : {};
      for (const sub of [null, '', 'not-a-uuid', ALICE_SUB.toUpperCase()]) {
        const response = await h.call(method, path, { sub, ...body });
        expect(response.status).toBe(401);
        expect(response.result.body).toBeUndefined();
      }
      expect(h.store.calls).toEqual([]);
    },
  );

  it.each(['abc', ID.toLowerCase(), `${ID}X`, ID.slice(1), `${ID.slice(0, 25)}I`, '%2E%2E', `${ID}%23`])(
    'a path id %s that is not a ULID is 400',
    async (bad) => {
      const h = harness();
      for (const collection of ['shelf', 'brews', 'recipes']) {
        expect((await h.call('GET', `/${collection}/${bad}`)).status).toBe(400);
        expect((await h.call('DELETE', `/${collection}/${bad}`)).status).toBe(400);
      }
      expect((await h.call('GET', `/beans/${bad}`)).status).toBe(400);
      expect(h.store.calls).toEqual([]);
    },
  );
});

describe('create, read, update, delete', () => {
  it('shelf', async () => {
    const h = harness();
    const id = await newShelf(h);
    const got = await h.call('GET', `/shelf/${id}`);
    expect(got.status).toBe(200);
    expect(ShelfEntrySchema.parse(got.body)).toEqual({ shelf_entry_id: id, values: shelfBody() });
    expect(got.result.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });

    const put = await h.call('PUT', `/shelf/${id}`, { json: shelfBody({ price_band: 'from_80' }) });
    expect(put.status).toBe(200);
    expect(ShelfEntrySchema.parse(put.body).values.price_band).toBe('from_80');

    const list = await h.call('GET', '/shelf');
    expect(ShelfEntryPageSchema.parse(list.body)).toEqual({ items: [put.body] });

    const deleted = await h.call('DELETE', `/shelf/${id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.result.body).toBeUndefined();
    expect((await h.call('GET', `/shelf/${id}`)).status).toBe(404);
    expect((await h.call('DELETE', `/shelf/${id}`)).status).toBe(404);
    expect((await h.call('PUT', `/shelf/${id}`, { json: shelfBody() })).status).toBe(404);
  });

  it('brews', async () => {
    const h = harness();
    const shelf = await newShelf(h);
    const created = await h.call('POST', '/brews', { json: brewBody(shelf) });
    const brew = BrewSchema.parse(created.body);
    expect((await h.call('GET', `/brews/${brew.brew_id}`)).body).toEqual(brew);
    const changed = { ...brewBody(shelf), brewed_at: '2026-11-26T08:00:00Z' };
    expect((await h.call('PUT', `/brews/${brew.brew_id}`, { json: changed })).body).toEqual({ brew_id: brew.brew_id, values: changed });
    expect(BrewPageSchema.parse((await h.call('GET', '/brews')).body).items).toHaveLength(1);
    expect((await h.call('DELETE', `/brews/${brew.brew_id}`)).status).toBe(204);
    expect((await h.call('GET', `/brews/${brew.brew_id}`)).status).toBe(404);
  });

  it('recipes', async () => {
    const h = harness();
    const recipe = RecipeSchema.parse((await h.call('POST', '/recipes', { json: recipeBody() })).body);
    expect((await h.call('GET', `/recipes/${recipe.recipe_id}`)).body).toEqual(recipe);
    expect((await h.call('PUT', `/recipes/${recipe.recipe_id}`, { json: recipeBody({ dose_dg: 180 }) })).status).toBe(200);
    expect(RecipePageSchema.parse((await h.call('GET', '/recipes')).body).items[0]?.values.parameters.dose_dg).toBe(180);
    expect((await h.call('DELETE', `/recipes/${recipe.recipe_id}`)).status).toBe(204);
    expect((await h.call('GET', `/recipes/${recipe.recipe_id}`)).status).toBe(404);
  });
});

describe('references', () => {
  it('a shelf entry for a bean not in the catalogue is 404, on create and on replace', async () => {
    const h = harness();
    expect((await h.call('POST', '/shelf', { json: shelfBody({ bean_id: ID }) })).status).toBe(404);
    const id = await newShelf(h);
    expect((await h.call('PUT', `/shelf/${id}`, { json: shelfBody({ bean_id: ID }) })).status).toBe(404);
    expect(ShelfEntrySchema.parse((await h.call('GET', `/shelf/${id}`)).body).values.bean_id).toBe(BEAN);
  });

  it('a brew on a shelf entry that does not exist is 404', async () => {
    const h = harness();
    expect((await h.call('POST', '/brews', { json: brewBody(ID) })).status).toBe(404);
  });

  it('deleting a shelf entry that brews reference is 409; after the brews are gone it is 204', async () => {
    const h = harness();
    const shelf = await newShelf(h);
    const brew = BrewSchema.parse((await h.call('POST', '/brews', { json: brewBody(shelf) })).body);
    const conflict = await h.call('DELETE', `/shelf/${shelf}`);
    expect(conflict.status).toBe(409);
    expect(conflict.result.body).toBeUndefined();
    await h.call('DELETE', `/brews/${brew.brew_id}`);
    expect((await h.call('DELETE', `/shelf/${shelf}`)).status).toBe(204);
  });
});

describe('changing the bean of a shelf entry (D14)', () => {
  const OTHER_BEAN = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DG';

  it('is 200 while no brew references the entry', async () => {
    const h = harness();
    h.store.beans.add(OTHER_BEAN);
    const shelf = await newShelf(h);
    const response = await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: OTHER_BEAN }) });
    expect(response.status).toBe(200);
    expect(ShelfEntrySchema.parse(response.body).values.bean_id).toBe(OTHER_BEAN);
  });

  it('is 409 with no body while brews reference the entry, and changes nothing', async () => {
    const h = harness();
    h.store.beans.add(OTHER_BEAN);
    const shelf = await newShelf(h);
    const brew = BrewSchema.parse((await h.call('POST', '/brews', { json: brewBody(shelf) })).body);
    const before = h.store.snapshot(verifiedUserId(ALICE_SUB));
    const conflict = await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: OTHER_BEAN }) });
    expect(conflict.status).toBe(409);
    expect(conflict.result.body).toBeUndefined();
    expect(h.store.snapshot(verifiedUserId(ALICE_SUB))).toEqual(before);
    expect(h.logs.at(-1)).toMatchObject({ operation: 'replaceShelfEntry', status: 409, error: 'ShelfEntryBeanLockedError' });

    // Any other change still succeeds; after the brews are gone the bean may change.
    expect((await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ price_band: 'from_80' }) })).status).toBe(200);
    await h.call('DELETE', `/brews/${brew.brew_id}`);
    expect((await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: OTHER_BEAN }) })).status).toBe(200);
  });

  it('a missing entry and an unknown bean stay 404', async () => {
    const h = harness();
    expect((await h.call('PUT', `/shelf/${ID}`, { json: shelfBody() })).status).toBe(404);
    const shelf = await newShelf(h);
    await h.call('POST', '/brews', { json: brewBody(shelf) });
    expect((await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: ID }) })).status).toBe(404);
  });

  it('is not retried', async () => {
    const h = harness();
    h.store.beans.add(OTHER_BEAN);
    const shelf = await newShelf(h);
    await h.call('POST', '/brews', { json: brewBody(shelf) });
    const calls = h.store.calls.length;
    expect((await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: OTHER_BEAN }) })).status).toBe(409);
    expect(h.store.calls.slice(calls)).toEqual(['replaceShelfEntry']);
  });
});

describe('rejected beans on shelves (M1-T11)', () => {
  async function newBean(h: Harness): Promise<string> {
    const response = await h.call('POST', '/beans', { json: beanBody() });
    expect(response.status).toBe(201);
    return BeanSchema.parse(response.body).bean_id;
  }

  it('a rejected bean is 404 for a new shelf entry, with no body and nothing stored', async () => {
    const h = harness();
    const bean = await newBean(h);
    h.store.rejectBean(bean);
    const before = h.store.snapshot(verifiedUserId(ALICE_SUB));
    const response = await h.call('POST', '/shelf', { json: shelfBody({ bean_id: bean }) });
    expect(response.status).toBe(404);
    expect(response.result.body).toBeUndefined();
    expect(h.store.snapshot(verifiedUserId(ALICE_SUB))).toEqual(before);
    expect(h.logs.at(-1)).toMatchObject({ operation: 'createShelfEntry', status: 404, error: 'BeanNotFoundError' });
  });

  it('an entry whose bean was rejected later can still be listed, read, brewed on and replaced with the same bean', async () => {
    const h = harness();
    const bean = await newBean(h);
    const created = await h.call('POST', '/shelf', { json: shelfBody({ bean_id: bean }) });
    expect(created.status).toBe(201);
    const shelf = ShelfEntrySchema.parse(created.body).shelf_entry_id;
    h.store.rejectBean(bean);

    const list = ShelfEntryPageSchema.parse((await h.call('GET', '/shelf')).body);
    expect(list.items.map((entry) => entry.shelf_entry_id)).toEqual([shelf]);
    const read = await h.call('GET', `/shelf/${shelf}`);
    expect(read.status).toBe(200);
    expect(ShelfEntrySchema.parse(read.body).values.bean_id).toBe(bean);
    expect((await h.call('POST', '/brews', { json: brewBody(shelf) })).status).toBe(201);
    const replaced = await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: bean, price_band: 'from_80' }) });
    expect(replaced.status).toBe(200);
    expect(ShelfEntrySchema.parse(replaced.body).values).toMatchObject({ bean_id: bean, price_band: 'from_80' });
  });

  it('a replace that switches to a rejected bean is 404 and changes nothing', async () => {
    const h = harness();
    const rejected = await newBean(h);
    h.store.rejectBean(rejected);
    const shelf = await newShelf(h);
    const before = h.store.snapshot(verifiedUserId(ALICE_SUB));
    const response = await h.call('PUT', `/shelf/${shelf}`, { json: shelfBody({ bean_id: rejected }) });
    expect(response.status).toBe(404);
    expect(response.result.body).toBeUndefined();
    expect(h.store.snapshot(verifiedUserId(ALICE_SUB))).toEqual(before);
  });
});

describe('another user’s data is unreachable', () => {
  it('Bob can neither read, replace, delete, list nor reference Alice’s items', async () => {
    const h = harness();
    const shelf = await newShelf(h);
    const brew = BrewSchema.parse((await h.call('POST', '/brews', { json: brewBody(shelf) })).body);
    const recipe = RecipeSchema.parse((await h.call('POST', '/recipes', { json: recipeBody() })).body);
    const alice = h.store.snapshot(verifiedUserId(ALICE_SUB));
    const bob = { sub: BOB_SUB };

    for (const [path, json] of [
      [`/shelf/${shelf}`, shelfBody()],
      [`/brews/${brew.brew_id}`, brewBody(shelf)],
      [`/recipes/${recipe.recipe_id}`, recipeBody()],
    ] as const) {
      expect((await h.call('GET', path, bob)).status).toBe(404);
      expect((await h.call('PUT', path, { ...bob, json })).status).toBe(404);
      expect((await h.call('DELETE', path, bob)).status).toBe(404);
    }
    for (const path of ['/shelf', '/brews', '/recipes']) {
      expect((await h.call('GET', path, bob)).body).toEqual({ items: [] });
    }
    // Bob cannot log a brew on Alice's shelf entry.
    expect((await h.call('POST', '/brews', { ...bob, json: brewBody(shelf) })).status).toBe(404);
    expect(h.store.snapshot(verifiedUserId(ALICE_SUB))).toEqual(alice);
  });

  it('a user id planted in the query, headers or body changes nothing', async () => {
    const h = harness();
    const shelf = await newShelf(h);
    const planted = { headers: { 'x-user-id': BOB_SUB, 'x-amzn-oidc-identity': BOB_SUB } };
    expect((await h.call('GET', `/shelf/${shelf}`, planted)).status).toBe(200);
    expect((await h.call('GET', `/shelf/${shelf}`, { sub: BOB_SUB, ...planted, headers: { 'x-user-id': ALICE_SUB } })).status).toBe(404);
    expect((await h.call('GET', '/shelf', { query: `sub=${ALICE_SUB}`, sub: BOB_SUB })).status).toBe(400);
    expect((await h.call('POST', '/shelf', { sub: BOB_SUB, json: { ...shelfBody(), sub: ALICE_SUB } })).status).toBe(400);
  });
});

describe('lists and signed cursors', () => {
  async function filled(count: number): Promise<{ h: Harness; ids: string[] }> {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(RecipeSchema.parse((await h.call('POST', '/recipes', { json: recipeBody() })).body).recipe_id);
    return { h, ids: ids.reverse() };
  }

  async function pageOf(h: Harness, query: string, sub = ALICE_SUB): Promise<{ status: number; ids: string[]; next?: string }> {
    const response = await h.call('GET', '/recipes', { query, sub });
    if (response.status !== 200) return { status: response.status, ids: [] };
    const page = RecipePageSchema.parse(response.body);
    return { status: 200, ids: page.items.map((r) => r.recipe_id), ...(page.next_cursor === undefined ? {} : { next: page.next_cursor }) };
  }

  it('pages newest first with the cursor the server issued', async () => {
    const { h, ids } = await filled(5);
    const first = await pageOf(h, 'limit=2');
    expect(first.ids).toEqual(ids.slice(0, 2));
    const second = await pageOf(h, `limit=2&cursor=${first.next ?? ''}`);
    expect(second.ids).toEqual(ids.slice(2, 4));
    const third = await pageOf(h, `cursor=${second.next ?? ''}&limit=2`);
    expect(third).toEqual({ status: 200, ids: ids.slice(4) });
  });

  it('a cursor is signed and wraps the repository cursor', async () => {
    const { h } = await filled(3);
    const first = await pageOf(h, 'limit=1');
    const next = first.next ?? '';
    expect(next).toMatch(/^[A-Za-z0-9_-]{44,512}$/);
    // The repository's own (unsigned) cursor is refused.
    const inner = next.slice(43);
    expect((await pageOf(h, `cursor=${inner}`)).status).toBe(400);
    expect((await pageOf(h, `cursor=${encodeCursor(`RECIPE#${ID}`)}`)).status).toBe(400);
  });

  it('a tampered cursor is 400', async () => {
    const { h } = await filled(3);
    const next = (await pageOf(h, 'limit=1')).next ?? '';
    const flip = (c: string): string => (c === 'A' ? 'B' : 'A');
    for (const index of [0, 10, 42, 43, 50, next.length - 1]) {
      const tampered = `${next.slice(0, index)}${flip(next.charAt(index))}${next.slice(index + 1)}`;
      expect((await pageOf(h, `cursor=${tampered}`)).status, `position ${String(index)}`).toBe(400);
    }
    for (const bad of [`${next}A`, next.slice(0, -1), next.slice(0, 43), 'A', `${next}!`, 'A'.repeat(513), `${next.slice(0, 43)}${encodeCursor('PROFILE')}`]) {
      expect((await pageOf(h, `cursor=${bad}`)).status).toBe(400);
    }
    expect(h.store.calls.filter((c) => c === 'listRecipes')).toHaveLength(1);
  });

  it('a cursor from another list is 400', async () => {
    const h = harness();
    for (let i = 0; i < 2; i += 1) await newShelf(h);
    const shelfCursor = ShelfEntryPageSchema.parse((await h.call('GET', '/shelf', { query: 'limit=1' })).body).next_cursor ?? '';
    expect(shelfCursor).not.toBe('');
    expect((await h.call('GET', '/shelf', { query: `cursor=${shelfCursor}` })).status).toBe(200);
    expect((await h.call('GET', '/brews', { query: `cursor=${shelfCursor}` })).status).toBe(400);
    expect((await h.call('GET', '/recipes', { query: `cursor=${shelfCursor}` })).status).toBe(400);
  });

  it('a cursor from another user is 400', async () => {
    const { h } = await filled(3);
    const next = (await pageOf(h, 'limit=1')).next ?? '';
    expect((await pageOf(h, `cursor=${next}`, BOB_SUB)).status).toBe(400);
  });

  it('a cursor signed with another key is 400', async () => {
    const { h } = await filled(3);
    const other = testSigner().sign('recipes', verifiedUserId(ALICE_SUB), encodeCursor(`RECIPE#${ID}`));
    expect((await pageOf(h, `cursor=${other}`)).status).toBe(400);
    const own = h.signer.sign('recipes', verifiedUserId(ALICE_SUB), encodeCursor(`RECIPE#${ID}`));
    expect((await pageOf(h, `cursor=${own}`)).status).toBe(200);
  });

  it('without the cursor key every list is 500 and nothing is read (fail closed)', async () => {
    const store = new FakeStore();
    const h = harness({ store, cursorSigner: () => Promise.resolve(undefined) });
    for (const path of ['/shelf', '/brews', '/recipes']) {
      const response = await h.call('GET', path);
      expect(response.status).toBe(500);
      expect(response.result.body).toBeUndefined();
    }
    expect(store.calls).toEqual([]);
    expect(h.logs.map((l) => l.error)).toEqual(['CursorKeyUnavailable', 'CursorKeyUnavailable', 'CursorKeyUnavailable']);
    // Other routes still work.
    expect((await h.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
  });

  it('limit is an integer from 1 to 100, default 50, exactly as the contract says', async () => {
    expect(contract.components.parameters.LimitQuery?.schema).toEqual({ type: 'integer', ...LIMIT_QUERY });
    const { h } = await filled(3);
    expect((await pageOf(h, 'limit=1')).ids).toHaveLength(1);
    expect((await pageOf(h, 'limit=100')).ids).toHaveLength(3);
    expect((await pageOf(h, '')).ids).toHaveLength(3);
    for (const bad of ['0', '101', '-1', '1.5', '01', 'abc', '1e1', '+5', ' 5', '5%20', '1000']) {
      expect((await pageOf(h, `limit=${bad}`)).status, bad).toBe(400);
    }
  });

  it('only cursor and limit, once each, and only on lists', async () => {
    const { h, ids } = await filled(1);
    for (const query of ['limit=1&limit=2', 'limit', 'limit=', 'page=2', 'cursor=', '&', 'limit=1&', 'Limit=1']) {
      expect((await pageOf(h, query)).status, query).toBe(400);
    }
    expect((await h.call('GET', `/recipes/${ids[0] ?? ''}`, { query: 'limit=1' })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { query: 'x=1', json: recipeBody() })).status).toBe(400);
    expect((await h.call('DELETE', `/recipes/${ids[0] ?? ''}`, { query: 'force=true' })).status).toBe(400);
  });
});

describe('errors and logs', () => {
  it('a write that raced is tried up to three times, with a wait before each retry; a third race is 500', async () => {
    const store = new FakeStore();
    let failures = 2;
    let tries = 0;
    const original = store.createRecipe.bind(store);
    store.createRecipe = (user, input) => {
      tries += 1;
      return failures-- > 0 ? Promise.reject(new WriteConflictError('raced')) : original(user, input);
    };
    const delays: number[] = [];
    const h = harness({ store, retryDelayMs: (retry) => (delays.push(retry), 0) });
    expect((await h.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
    expect(delays).toEqual([1, 2]);
    expect(tries).toBe(3);

    failures = 3;
    delays.length = 0;
    const response = await h.call('POST', '/recipes', { json: recipeBody() });
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(delays).toEqual([1, 2]);
    expect(tries).toBe(6);
    expect(h.logs.at(-1)).toEqual({ operation: 'createRecipe', status: 500, request_id: 'request-1', error: 'WriteConflictError' });
  });

  it('replace and delete are retried the same way; other errors are not retried', async () => {
    const store = new FakeStore();
    const h = harness({ store, retryDelayMs: () => 0 });
    const recipe = RecipeSchema.parse((await h.call('POST', '/recipes', { json: recipeBody() })).body);
    for (const method of ['replaceRecipe', 'deleteRecipe'] as const) {
      let failures = 1;
      const original: (...args: never[]) => Promise<unknown> = store[method].bind(store);
      store[method] = ((...args: never[]) =>
        failures-- > 0 ? Promise.reject(new WriteConflictError('raced')) : original(...args)) as never;
    }
    expect((await h.call('PUT', `/recipes/${recipe.recipe_id}`, { json: recipeBody({ dose_dg: 200 }) })).status).toBe(200);
    expect((await h.call('DELETE', `/recipes/${recipe.recipe_id}`)).status).toBe(204);
    // A not-found is final: one call, 404.
    const before = store.calls.length;
    expect((await h.call('DELETE', `/recipes/${recipe.recipe_id}`)).status).toBe(404);
    expect(store.calls.length - before).toBe(1);
  });

  it('the default wait before a retry is short and random', async () => {
    const store = new FakeStore();
    let failures = 2;
    const original = store.createRecipe.bind(store);
    store.createRecipe = (user, input) => (failures-- > 0 ? Promise.reject(new WriteConflictError('raced')) : original(user, input));
    const h = harness({ store });
    const started = Date.now();
    expect((await h.call('POST', '/recipes', { json: recipeBody() })).status).toBe(201);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1000);
  });

  it('an unexpected error is 500 with no body; the log names the class, never the message', async () => {
    const store = new FakeStore();
    store.getRecipe = () => Promise.reject(new TypeError(`secret ${ALICE_SUB}`));
    const h = harness({ store });
    const response = await h.call('GET', `/recipes/${ID}`);
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  it('logs one line per request with operation, status, request id and error class only', async () => {
    const h = harness();
    const shelf = await newShelf(h);
    await h.call('POST', '/brews', { json: brewBody(shelf) });
    await h.call('POST', '/brews', { json: { ...brewBody(shelf), note: 'my secret note' } });
    await h.call('GET', '/brews', { query: 'cursor=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    await h.call('GET', '/brews', { sub: null });
    await h.call('GET', '/nowhere');
    expect(h.logs).toEqual([
      { operation: 'createShelfEntry', status: 201, request_id: 'request-1' },
      { operation: 'createBrew', status: 201, request_id: 'request-1' },
      { operation: 'createBrew', status: 400, request_id: 'request-1' },
      { operation: 'listBrews', status: 400, request_id: 'request-1', error: 'InvalidCursorError' },
      { operation: 'listBrews', status: 401, request_id: 'request-1' },
      { operation: 'unknown', status: 404, request_id: 'request-1' },
    ]);
    const text = JSON.stringify(h.logs);
    for (const leaked of [ALICE_SUB, shelf, 'secret', 'v60', 'AAAAAAAA']) expect(text).not.toContain(leaked);
  });
});
