// The aggregate repository against DynamoDB Local (M3-T7): a Scan over more
// than one page, a failure on page 2, and the replace (stale items deleted,
// idempotent). Run with `npm run test:integration`; skipped with a message when
// DynamoDB Local is not reachable (see test/integration/dynamodb-local.ts).
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AggregateRepository } from '../../src/repository/index.ts';
import { BEAN, OTHER_BEAN, RUN_DAY, RUN_MS, DAY, profileItem, runNight, seedCrowd, sub } from '../repository/aggregate-fixtures.ts';
import { FakeTable } from '../repository/fake-table.ts';
import type { Item } from '../repository/fake-table.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from './dynamodb-local.ts';

const local = await connectDynamoDbLocal();

describe.skipIf(!local.reachable)('aggregates on DynamoDB Local', () => {
  let tableName = '';
  const { client, documentClient } = local;

  beforeAll(async () => {
    tableName = await createTestTable(client);
  });
  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

  /** Fills the table from the in-memory builders, so both suites seed the same items. */
  async function seed(fill: (table: FakeTable) => void): Promise<void> {
    const table = new FakeTable();
    fill(table);
    const items: Item[] = [...table.items.values()];
    for (let i = 0; i < items.length; i += 25) {
      await documentClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
    }
  }

  async function everything(): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await documentClient.send(new ScanCommand({ TableName: tableName, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  async function clear(): Promise<void> {
    const items = await everything();
    for (let i = 0; i < items.length; i += 25) {
      await documentClient.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: items.slice(i, i + 25).map((item) => ({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } })) } }),
      );
    }
  }

  const repo = (now: Date, client: DynamoDBDocumentClient = documentClient, scanPageSize = 7): AggregateRepository =>
    new AggregateRepository({ client, tableName, now: () => now, scanPageSize, sleep: () => Promise.resolve() });

  it('scans more than one page and returns every relevant item once', async () => {
    await clear();
    await seed((t) => {
      seedCrowd(t, 6, { brewsEach: 2 });
    });
    const scan = await repo(new Date(RUN_MS)).scanForRebuild();
    expect(scan.brews).toHaveLength(12);
    expect(new Set(scan.brews.map((b) => b.brew.brew_id)).size).toBe(12);
    expect(scan.shelfEntries).toHaveLength(6);
    expect(scan.itemsScanned).toBe(6 * 4 + 1);
  });

  it('returns nothing when page 2 fails', async () => {
    await clear();
    await seed((t) => {
      seedCrowd(t, 6, { brewsEach: 2 });
    });
    let calls = 0;
    const failing = {
      send: (command: unknown) => {
        if (command instanceof ScanCommand) {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('injected failure on page 2'));
        }
        return (documentClient as unknown as { send(c: unknown): Promise<unknown> }).send(command);
      },
    } as unknown as DynamoDBDocumentClient;
    await expect(repo(new Date(RUN_MS), failing).scanForRebuild()).rejects.toThrow('injected failure on page 2');
    expect(calls).toBe(2);
  });

  it('replaces: writes, serves, deletes what the new set lacks, and is idempotent', async () => {
    await clear();
    await seed((t) => {
      seedCrowd(t, 5);
      seedCrowd(t, 5, { beanId: OTHER_BEAN, first: 20 });
    });
    const r = repo(new Date(RUN_MS));
    await runNight(r);
    expect((await r.readAggregate(BEAN)).kind).toBe('served');
    expect((await r.readAggregate(OTHER_BEAN)).kind).toBe('served');
    const first = (await everything()).map((i) => JSON.stringify(i)).sort();

    const again = await runNight(r, RUN_MS + 60_000);
    expect(again.written).toBe(0);
    expect(again.deleted).toBe(0);
    expect((await everything()).map((i) => JSON.stringify(i)).sort()).toEqual(first);

    // Next day: rankings move to the new day, unchanged AGG items stay.
    const next = await runNight(r, RUN_MS + DAY);
    expect(next.written).toBe(next.result.rankings.length);
    expect(next.deleted).toBe(next.result.rankings.length);

    // The raters of OTHER_BEAN withdraw: its items and its ranking entry go.
    await seed((t) => {
      for (let n = 20; n < 25; n += 1) t.put(profileItem(sub(n), false));
    });
    await runNight(r, RUN_MS + DAY + 60_000);
    const keys = (await everything()).filter((i) => String(i.sk).startsWith('AGG#')).map((i) => String(i.pk));
    expect(new Set(keys)).toEqual(new Set([`BEAN#${BEAN}`]));
    expect(await r.readAggregate(OTHER_BEAN)).toEqual({ kind: 'not_enough_raters' });
    expect(RUN_DAY).toBe('2026-11-27');
  });
});
