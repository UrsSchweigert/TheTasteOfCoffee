// The replay and load test of the nightly rebuild (M3-T10) against DynamoDB
// Local: the same history, loaded in a shuffled order, the same assertions as
// replay.test.ts. Run with `npm run test:replay`. Skipped with a message when
// DynamoDB Local is not reachable, unless REQUIRE_DYNAMODB_LOCAL=1 (see
// test/integration/dynamodb-local.ts). Never talks to AWS.
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { visitNumbers } from '../aggregation/support/campaign.ts';
import { Rng } from '../aggregation/support/rng.ts';
import { connectDynamoDbLocal, createTestTable, deleteTestTable } from '../integration/dynamodb-local.ts';
import type { Item } from '../repository/fake-table.ts';
import { buildFixture, itemsOf } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import { FAILING_PAGE, FULL_RUN_BUDGET_MS, HEAP_SHARE_TRIGGER, LAMBDA_MEMORY_MB, LAMBDA_TIMEOUT_MS, TIMEOUT_SHARE_TRIGGER, dump, isAggregateKey, printMeasurement, runHandler } from './harness.ts';

const local = await connectDynamoDbLocal();
const MB = 1024 * 1024;

describe.skipIf(!local.reachable)('the replay and load test on DynamoDB Local', () => {
  const { client, documentClient } = local;
  let tableName = '';
  let fixture: Fixture;
  let personal: Item[] = [];

  beforeAll(async () => {
    fixture = buildFixture();
    tableName = await createTestTable(client);
    // The final state of the stream, loaded in a shuffled order (25 requests per batch, the DynamoDB limit).
    personal = new Rng(99).shuffle(itemsOf(fixture.table()));
    for (let i = 0; i < personal.length; i += 25) {
      let requests = personal.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; requests.length > 0; attempt += 1) {
        if (attempt > 20) throw new Error('DynamoDB Local left unprocessed items');
        const result = await documentClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: requests } }));
        requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
      }
    }
  }, 180_000);

  afterAll(async () => {
    if (tableName !== '') await deleteTestTable(client, tableName);
  });

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

  it('fails closed first: a scan error at page 40 leaves the table byte-identical', async () => {
    const before = dump(await everything());
    const failed = await runHandler(documentClient, tableName, { failOnScanPage: FAILING_PAGE });
    expect(failed.failed).toBe(true);
    expect(failed.log).toMatchObject({ status: 'FAILED', stage: 'scan' });
    expect(failed.stats.scanPages).toBe(FAILING_PAGE);
    expect(failed.stats.writeRequests).toBe(0);
    expect(dump(await everything())).toBe(before);
  });

  it('finishes in budget, inside the heap bound, equals the oracle, writes nothing the second time', async () => {
    const first = await runHandler(documentClient, tableName);
    printMeasurement('dynamodb-local', 'first', first);
    expect(first.failed).toBe(false);
    expect(first.log.status).toBe('OK');
    expect(first.durationMs).toBeLessThan(FULL_RUN_BUDGET_MS);
    expect(first.durationMs / LAMBDA_TIMEOUT_MS).toBeLessThan(TIMEOUT_SHARE_TRIGGER);
    expect(first.stats.peakHeapBytes / MB).toBeLessThan(LAMBDA_MEMORY_MB * HEAP_SHARE_TRIGGER);
    expect(first.stats.scanPages).toBeGreaterThan(FAILING_PAGE);

    const written = await everything();
    expect(dump(written, isAggregateKey)).toBe(fixture.expected.text);
    visitNumbers(written.filter(isAggregateKey), (n) => {
      if (!Number.isSafeInteger(n)) throw new Error('a number in an aggregate item is not a safe integer');
    });
    expect(dump(written, (i) => !isAggregateKey(i))).toBe(dump(personal));

    const afterFirst = dump(written);
    const second = await runHandler(documentClient, tableName, { scanPageSize: 137, shuffleSeed: 11 });
    printMeasurement('dynamodb-local', 'second-unchanged', second);
    expect(second.failed).toBe(false);
    expect(second.stats.writeRequests).toBe(0);
    expect(second.log.items_written).toBe(0);
    expect(second.log.items_deleted).toBe(0);
    expect(dump(await everything())).toBe(afterFirst);
  });
});
