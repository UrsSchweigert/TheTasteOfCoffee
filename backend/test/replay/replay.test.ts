// Replay and load test of the nightly rebuild (ADR 0035 scale trigger, M3-T10)
// on the in-memory table. Not part of `npm test`: run it with `npm run test:replay`
// (vitest.replay.config.ts), which sets the V8 heap limit to the Lambda memory.
// The same scenarios run on DynamoDB Local in replay-dynamodb-local.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { REASON_IDS } from '../../src/generated/aggregation.ts';
import { MethodSchema } from '../../src/generated/contract.ts';
import { SCAN_PAGE_SIZE } from '../../src/repository/scan.ts';
import { visitNumbers } from '../aggregation/support/campaign.ts';
import { buildFixture, itemsOf } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import {
  FAILING_PAGE,
  FULL_RUN_BUDGET_MS,
  HEAP_SHARE_TRIGGER,
  LAMBDA_MEMORY_MB,
  LAMBDA_TIMEOUT_MS,
  TIMEOUT_SHARE_TRIGGER,
  dump,
  isAggregateKey,
  printMeasurement,
  runHandler,
} from './harness.ts';
import { BEANS, BREWS_CREATED, USERS } from './history.ts';

const TABLE = 'cupmark-test-replay';
const MB = 1024 * 1024;

let fixture: Fixture;
beforeAll(() => {
  fixture = buildFixture();
});

describe('the generated history', () => {
  it('has the size of M3-T10 and every kind of change', () => {
    const { counts } = fixture.history;
    expect(counts.creates).toBe(BREWS_CREATED);
    expect(counts.edits).toBeGreaterThan(500);
    expect(counts.moves).toBeGreaterThan(50);
    expect(counts.deletes).toBeGreaterThan(200);
    expect(counts.flippedUsers).toBeGreaterThan(10);
    expect(new Set(fixture.history.events.flatMap((e) => (e.kind === 'create' ? [e.user] : []))).size).toBe(USERS);
    expect(fixture.history.beans.length).toBeGreaterThan(BEANS * 0.7);
    const methods = new Set(fixture.input.brews.map((b) => b.brew.values.parameters.method));
    expect([...methods].sort()).toEqual([...MethodSchema.options].sort());
  });

  it('triggers every plausibility rule, and some beans have 5 raters and some do not', () => {
    const { counts } = fixture.expected.result;
    for (const id of REASON_IDS) expect(counts.reasons[id], id).toBeGreaterThan(0);
    expect(counts.brews_counted).toBeGreaterThan(5_000);
    expect(counts.beans_ranked).toBeGreaterThan(5);
    expect(counts.beans_with_aggregates).toBeGreaterThan(counts.beans_ranked);
  });
});

describe('the full job on the in-memory table', () => {
  it('finishes in budget, inside the heap bound, equals the oracle, writes nothing the second time', async () => {
    const table = fixture.table();
    const before = dump(itemsOf(table));
    const first = await runHandler(table.client, TABLE);
    printMeasurement('memory', 'first', first);

    expect(first.failed).toBe(false);
    expect(first.log.status).toBe('OK');
    // Time: the stated budget, and the scale trigger of the ADR.
    expect(first.durationMs).toBeLessThan(FULL_RUN_BUDGET_MS);
    expect(first.durationMs / LAMBDA_TIMEOUT_MS).toBeLessThan(TIMEOUT_SHARE_TRIGGER);
    // Memory: the bound of the ADR's scale trigger, on the whole process heap (the in-memory table included).
    expect(first.stats.peakHeapBytes / MB).toBeLessThan(LAMBDA_MEMORY_MB * HEAP_SHARE_TRIGGER);
    // The scan took more than 40 pages (the failure test needs page 40 to exist).
    expect(first.stats.scanPages).toBeGreaterThan(FAILING_PAGE);
    expect(first.stats.scanPages).toBe(Math.ceil(Number(first.log.items_scanned) / SCAN_PAGE_SIZE));
    // The handler's own per-reason counts are the oracle's.
    expect(first.log.reasons).toEqual(fixture.expected.result.counts.reasons);
    // Exact: the table holds what the oracle says, and every number is a safe integer (the run's own assertion never tripped).
    const written = itemsOf(table);
    expect(dump(written, isAggregateKey)).toBe(fixture.expected.text);
    visitNumbers(written.filter(isAggregateKey), (n) => {
      if (!Number.isSafeInteger(n)) throw new Error('a number in an aggregate item is not a safe integer');
    });
    // The personal items are untouched.
    expect(dump(written, (i) => !isAggregateKey(i))).toBe(before);

    // A second run on the same day with the same input writes nothing.
    const afterFirst = dump(written);
    const second = await runHandler(table.client, TABLE);
    printMeasurement('memory', 'second-unchanged', second);
    expect(second.failed).toBe(false);
    expect(second.stats.writeRequests).toBe(0);
    expect(second.log.items_written).toBe(0);
    expect(second.log.items_deleted).toBe(0);
    expect(dump(itemsOf(table))).toBe(afterFirst);
  });

  it('is deterministic: a second table, loaded and scanned in other orders, gives byte-identical items', async () => {
    const one = fixture.table();
    // The same stream, replayed with its lanes interleaved another way: the same table.
    const other = fixture.table(7);
    expect(dump(itemsOf(other))).toBe(dump(itemsOf(one)));
    const other2 = fixture.table(8);
    expect(dump(itemsOf(other2))).toBe(dump(itemsOf(one)));

    const a = await runHandler(one.client, TABLE);
    // Another page size and every page shuffled: the rebuild sees the items in another order.
    const b = await runHandler(other.client, TABLE, { scanPageSize: 137, shuffleSeed: 11 });
    printMeasurement('memory', 'shuffled-scan', b);
    expect(a.failed).toBe(false);
    expect(b.failed).toBe(false);
    expect(b.stats.scanPages).toBeGreaterThan(a.stats.scanPages);
    const text = dump(itemsOf(one), isAggregateKey);
    expect(text).not.toBe('');
    expect(dump(itemsOf(other), isAggregateKey)).toBe(text);
    expect(text).toBe(fixture.expected.text);
    // The counts of the two runs agree as well.
    for (const key of ['items_scanned', 'brews_seen', 'brews_counted', 'brews_orphaned', 'users_seen', 'reasons', 'beans_with_aggregates', 'beans_ranked', 'items_written']) {
      expect(b.log[key], key).toEqual(a.log[key]);
    }
  });

  it('fails closed: a scan error at page 40 leaves the table byte-identical', async () => {
    const table = fixture.table();
    const before = dump(itemsOf(table));
    const failed = await runHandler(table.client, TABLE, { failOnScanPage: FAILING_PAGE });
    expect(failed.failed).toBe(true);
    expect(failed.log).toMatchObject({ status: 'FAILED', stage: 'scan' });
    expect(failed.stats.scanPages).toBe(FAILING_PAGE);
    expect(failed.stats.writeRequests).toBe(0);
    expect(table.writes).toHaveLength(0);
    expect(dump(itemsOf(table))).toBe(before);

    // The same failure after a good run: yesterday's items stay as they were.
    await runHandler(table.client, TABLE);
    const good = dump(itemsOf(table));
    const again = await runHandler(table.client, TABLE, { failOnScanPage: FAILING_PAGE });
    expect(again.failed).toBe(true);
    expect(dump(itemsOf(table))).toBe(good);
  });
});
