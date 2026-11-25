// The API Lambda's routes end to end against DynamoDB Local (M1-T5): the
// router, validation, signed cursors and the real repository on a fresh table.
// The cursor key is generated here; nothing calls AWS.
// Run with `npm run test:integration`; see test/integration/dynamodb-local.ts.
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/router.ts';
import type { LogEntry } from '../../src/api/router.ts';
import { BrewPageSchema, BrewSchema, RecipeSchema, ShelfEntryPageSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { Repository, userPk } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent, brewBody, recipeBody, shelfBody, testSigner } from '../api/helpers.ts';
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
});
