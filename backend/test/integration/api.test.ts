// The API Lambda's routes end to end against DynamoDB Local (M1-T5): the
// router, validation, signed cursors and the real repository on a fresh table.
// The cursor key is generated here; nothing calls AWS.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/router.ts';
import type { LogEntry } from '../../src/api/router.ts';
import { BeanSchema, BrewPageSchema, BrewSchema, RecipeSchema, ShelfEntryPageSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { Repository, barcodeKey, beanMetaKey, userPk } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent, beanBody, brewBody, recipeBody, shelfBody, testSigner } from '../api/helpers.ts';
import type { RequestOptions } from '../api/helpers.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();

describe.skipIf(!local.reachable)('API routes on DynamoDB Local', () => {
  let tableName = '';
  let beanId = '';
  let api: ReturnType<typeof createApi>;
  const logs: LogEntry[] = [];
  const { client, documentClient } = local;

  async function call(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: unknown }> {
    const result = await api(apiEvent(method, path, options));
    return { status: result.statusCode ?? 0, body: result.body === undefined ? undefined : (JSON.parse(result.body) as unknown) };
  }

  async function partition(sub: string): Promise<Record<string, unknown>[]> {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': userPk(verifiedUserId(sub)) },
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  beforeAll(async () => {
    tableName = await createTestTable(client);
    const repository = new Repository({ client: documentClient, tableName });
    // The bean route lands in another task; the catalogue entry is made directly.
    beanId = (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    const signer = testSigner();
    api = createApi({ store: repository, cursorSigner: () => Promise.resolve(signer), log: (entry) => logs.push(entry) });
  });

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  it('shelf, brews with ratings and recipes: the full flow', async () => {
    // Shelf entry for a bean that is not in the catalogue: 404.
    expect((await call('POST', '/shelf', { json: shelfBody({ bean_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }) })).status).toBe(404);

    const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { json: shelfBody({ bean_id: beanId }) })).body);
    expect((await call('GET', `/shelf/${shelf.shelf_entry_id}`)).body).toEqual(shelf);
    const replacedShelf = await call('PUT', `/shelf/${shelf.shelf_entry_id}`, { json: shelfBody({ bean_id: beanId, bag_size: 'g_1000' }) });
    expect(ShelfEntrySchema.parse(replacedShelf.body).values.bag_size).toBe('g_1000');

    // Three brews, logged out of order; listed newest brewed_at first, paged with signed cursors.
    const times = ['2026-11-20T07:00:00Z', '2026-11-25T07:00:00+01:00', '2026-11-22T07:00:00Z'];
    const brews: string[] = [];
    for (const brewedAt of times) {
      const created = await call('POST', '/brews', { json: { ...brewBody(shelf.shelf_entry_id), brewed_at: brewedAt } });
      expect(created.status).toBe(201);
      brews.push(BrewSchema.parse(created.body).brew_id);
    }
    const page1 = BrewPageSchema.parse((await call('GET', '/brews', { query: 'limit=2' })).body);
    expect(page1.items.map((b) => b.values.brewed_at)).toEqual(['2026-11-25T07:00:00+01:00', '2026-11-22T07:00:00Z']);
    const page2 = BrewPageSchema.parse((await call('GET', '/brews', { query: `limit=2&cursor=${page1.next_cursor ?? ''}` })).body);
    expect(page2.items.map((b) => b.values.brewed_at)).toEqual(['2026-11-20T07:00:00Z']);
    expect(page2.next_cursor).toBeUndefined();
    // The cursor is Alice's and the brew list's.
    expect((await call('GET', '/brews', { sub: BOB_SUB, query: `cursor=${page1.next_cursor ?? ''}` })).status).toBe(400);
    expect((await call('GET', '/shelf', { query: `cursor=${page1.next_cursor ?? ''}` })).status).toBe(400);

    // Replace a brew with a new time and a 7.25 score: refused; with 7.5: moved.
    const first = brews[0] ?? '';
    const moved: Record<string, unknown> = { ...brewBody(shelf.shelf_entry_id), brewed_at: '2026-11-26T07:00:00Z' };
    const bad = structuredClone(moved);
    (bad.rating as { scores: Record<string, number> }).scores.overall = 7.25;
    expect((await call('PUT', `/brews/${first}`, { json: bad })).status).toBe(400);
    (moved.rating as { scores: Record<string, number> }).scores.overall = 7.5;
    expect((await call('PUT', `/brews/${first}`, { json: moved })).status).toBe(200);
    expect(BrewSchema.parse((await call('GET', `/brews/${first}`)).body).values).toEqual(moved);
    expect(BrewPageSchema.parse((await call('GET', '/brews', { query: 'limit=1' })).body).items[0]?.brew_id).toBe(first);

    // The shelf entry cannot go while brews reference it.
    expect((await call('DELETE', `/shelf/${shelf.shelf_entry_id}`)).status).toBe(409);
    for (const id of brews) expect((await call('DELETE', `/brews/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/shelf/${shelf.shelf_entry_id}`)).status).toBe(204);
    expect(ShelfEntryPageSchema.parse((await call('GET', '/shelf')).body).items).toEqual([]);

    // Recipes.
    const recipe = RecipeSchema.parse((await call('POST', '/recipes', { json: recipeBody() })).body);
    expect((await call('PUT', `/recipes/${recipe.recipe_id}`, { json: recipeBody({ method: 'cold_brew' }) })).status).toBe(200);
    expect(RecipeSchema.parse((await call('GET', `/recipes/${recipe.recipe_id}`)).body).values.parameters.method).toBe('cold_brew');
    expect((await call('DELETE', `/recipes/${recipe.recipe_id}`)).status).toBe(204);

    // Nothing of Alice remains, and the log holds no ids of hers.
    expect(await partition(ALICE_SUB)).toEqual([]);
    const text = JSON.stringify(logs);
    for (const leaked of [ALICE_SUB, shelf.shelf_entry_id, beanId]) expect(text).not.toContain(leaked);
  });

  it('Bob cannot reach Alice’s items, and his failed requests write nothing', async () => {
    const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { json: shelfBody({ bean_id: beanId }) })).body);
    const brew = BrewSchema.parse((await call('POST', '/brews', { json: brewBody(shelf.shelf_entry_id) })).body);
    const recipe = RecipeSchema.parse((await call('POST', '/recipes', { json: recipeBody() })).body);
    const before = await partition(ALICE_SUB);
    const bob = { sub: BOB_SUB };

    for (const [path, json] of [
      [`/shelf/${shelf.shelf_entry_id}`, shelfBody({ bean_id: beanId })],
      [`/brews/${brew.brew_id}`, brewBody(shelf.shelf_entry_id)],
      [`/recipes/${recipe.recipe_id}`, recipeBody()],
    ] as const) {
      expect((await call('GET', path, bob)).status).toBe(404);
      expect((await call('PUT', path, { ...bob, json })).status).toBe(404);
      expect((await call('DELETE', path, bob)).status).toBe(404);
    }
    expect((await call('POST', '/brews', { ...bob, json: brewBody(shelf.shelf_entry_id) })).status).toBe(404);
    for (const path of ['/shelf', '/brews', '/recipes']) expect((await call('GET', path, bob)).body).toEqual({ items: [] });
    expect((await call('GET', '/shelf', { sub: null })).status).toBe(401);

    expect(await partition(BOB_SUB)).toEqual([]);
    expect(await partition(ALICE_SUB)).toEqual(before);
  });

  it('PUT /shelf/{id} answers 409 with no body when the bean would change while brews reference the entry (D14)', async () => {
    const repository = new Repository({ client: documentClient, tableName });
    const other = (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    const sub = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
    const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: beanId }) })).body);
    const path = `/shelf/${shelf.shelf_entry_id}`;
    const brew = BrewSchema.parse((await call('POST', '/brews', { sub, json: brewBody(shelf.shelf_entry_id) })).body);
    const before = await partition(sub);

    const result = await api(apiEvent('PUT', path, { sub, json: shelfBody({ bean_id: other }) }));
    expect(result.statusCode).toBe(409);
    expect(result.body).toBeUndefined();
    expect(logs.at(-1)).toMatchObject({ operation: 'replaceShelfEntry', status: 409, error: 'ShelfEntryBeanLockedError' });
    expect(await partition(sub)).toEqual(before);
    expect((await call('PUT', path, { sub, json: shelfBody({ bean_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }) })).status).toBe(404);
    expect((await call('PUT', path, { sub, json: shelfBody({ bean_id: beanId, bag_size: 'g_1000' }) })).status).toBe(200);

    expect((await call('DELETE', `/brews/${brew.brew_id}`, { sub })).status).toBe(204);
    const moved = await call('PUT', path, { sub, json: shelfBody({ bean_id: other }) });
    expect(moved.status).toBe(200);
    expect(ShelfEntrySchema.parse(moved.body).values.bean_id).toBe(other);
  });

  it('a rejected bean: 404 on a new shelf entry or a switch to it; an entry already on it keeps working (M1-T11)', async () => {
    const repository = new Repository({ client: documentClient, tableName });
    const newBean = async (): Promise<string> =>
      (await repository.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} })).bean.bean_id;
    const sub = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
    const shelved = await newBean();
    const other = await newBean();
    const shelf = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: shelved }) })).body);
    const onOther = ShelfEntrySchema.parse((await call('POST', '/shelf', { sub, json: shelfBody({ bean_id: other }) })).body);
    const path = `/shelf/${shelf.shelf_entry_id}`;
    await repository.rejectBean(shelved);

    const before = await partition(sub);
    const created = await api(apiEvent('POST', '/shelf', { sub, json: shelfBody({ bean_id: shelved }) }));
    expect(created.statusCode).toBe(404);
    expect(created.body).toBeUndefined();
    expect(logs.at(-1)).toMatchObject({ operation: 'createShelfEntry', status: 404, error: 'BeanNotFoundError' });
    expect((await call('PUT', `/shelf/${onOther.shelf_entry_id}`, { sub, json: shelfBody({ bean_id: shelved }) })).status).toBe(404);
    expect(await partition(sub)).toEqual(before);

    expect(ShelfEntryPageSchema.parse((await call('GET', '/shelf', { sub })).body).items).toContainEqual(shelf);
    expect((await call('GET', path, { sub })).body).toEqual(shelf);
    expect((await call('POST', '/brews', { sub, json: brewBody(shelf.shelf_entry_id) })).status).toBe(201);
    const replaced = await call('PUT', path, { sub, json: shelfBody({ bean_id: shelved, bag_size: 'g_1000' }) });
    expect(replaced.status).toBe(200);
    expect(ShelfEntrySchema.parse(replaced.body).values).toMatchObject({ bean_id: shelved, bag_size: 'g_1000' });
    expect((await call('GET', path, { sub })).body).toEqual(replaced.body);
  });

  it('bean catalogue: create, look up by barcode, reject, then the barcode is free for a new entry', async () => {
    const repository = new Repository({ client: documentClient, tableName });
    const raw = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
      (await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item as
        | Record<string, unknown>
        | undefined;
    const upcA = '012345678905';
    const ean13 = '0012345678905';
    expect((await call('GET', `/barcodes/${upcA}`)).status).toBe(404);
    expect((await call('GET', '/barcodes/0012345678901')).status).toBe(400);

    // Origin needs vocabulary v2.
    const v1 = await call('POST', '/beans', { json: beanBody({ barcode: upcA }, { origin: 'colombia' }) });
    expect(v1.status).toBe(400);
    expect((await call('POST', '/beans', { json: beanBody({ barcode: upcA, open_food_facts_confirmed: true }) })).status).toBe(409);
    expect(await raw(barcodeKey(ean13))).toBeUndefined();

    const attributes = { origin: 'colombia', species: 'arabica', variety: 'castillo', process: 'washed' };
    const created = await call('POST', '/beans', { json: beanBody({ vocabulary_version: 2, barcode: upcA }, attributes) });
    expect(created.status).toBe(201);
    const bean = BeanSchema.parse(created.body);
    expect(bean).toMatchObject({ verified: false, barcode: ean13, picked_attributes: attributes, operator_attributes: {} });

    // Shared: Bob finds Alice's unverified bean by either barcode form and by id; nothing names Alice.
    for (const barcode of [upcA, ean13]) expect((await call('GET', `/barcodes/${barcode}`, { sub: BOB_SUB })).body).toEqual(bean);
    expect((await call('GET', `/beans/${bean.bean_id}`, { sub: BOB_SUB })).body).toEqual(bean);
    expect(JSON.stringify(await raw(beanMetaKey(bean.bean_id)))).not.toContain(ALICE_SUB);
    expect(await partition(BOB_SUB)).toEqual([]);

    // Taken: 409, nothing written.
    expect((await call('POST', '/beans', { sub: BOB_SUB, json: beanBody({ barcode: ean13 }) })).status).toBe(409);

    // The operator rejects it: 404 by id and by barcode, the META item stays, the pointer is gone.
    await repository.rejectBean(bean.bean_id);
    expect((await call('GET', `/beans/${bean.bean_id}`)).status).toBe(404);
    expect((await call('GET', `/barcodes/${upcA}`)).status).toBe(404);
    expect(await raw(beanMetaKey(bean.bean_id))).toMatchObject({ status: 'rejected', barcode: ean13 });
    expect(await raw(barcodeKey(ean13))).toBeUndefined();

    // The next scan submits a fresh entry.
    const fresh = await call('POST', '/beans', { sub: BOB_SUB, json: beanBody({ barcode: ean13 }) });
    expect(fresh.status).toBe(201);
    const freshBean = BeanSchema.parse(fresh.body);
    expect(freshBean.bean_id).not.toBe(bean.bean_id);
    expect((await call('GET', `/barcodes/${upcA}`)).body).toEqual(freshBean);
    expect((await call('GET', `/beans/${freshBean.bean_id}`)).body).toEqual(freshBean);

    const text = JSON.stringify(logs);
    for (const leaked of [ALICE_SUB, BOB_SUB, ean13, upcA, bean.bean_id, 'colombia']) expect(text).not.toContain(leaked);
  });
});
