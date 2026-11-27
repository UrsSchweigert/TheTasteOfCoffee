// The nightly job handler (ADR 0035, M3-T8) on the in-memory table of the
// repository tests, with the real AggregateRepository and rebuild core, and
// injected failures.
import { describe, expect, it } from 'vitest';
import { REASON_IDS } from '../../src/generated/aggregation.ts';
import type { RebuildResult } from '../../src/aggregation/rebuild/types.ts';
import { SDK_MAX_ATTEMPTS, createNightlyHandler, newDynamoClient, handler as entryPoint } from '../../src/handlers/nightly-aggregates.ts';
import type { NightlyStore } from '../../src/handlers/nightly-aggregates.ts';
import { AggregateRepository } from '../../src/repository/index.ts';
import { BEAN, BREWED_MS, OTHER_BEAN, RUN_MS, brewItem, profileItem, seedCrowd, shelfItem, sub, ulid } from '../repository/aggregate-fixtures.ts';
import { FakeTable } from '../repository/fake-table.ts';

const TIMEOUT_MS = 300_000;

interface Harness {
  readonly run: (event?: unknown) => Promise<void>;
  readonly lines: string[];
  readonly clockReads: () => number;
  readonly repo: (now?: () => Date) => AggregateRepository;
}

/** `usedMs` of the 300 s timeout pass between the start and the end of one run. */
function harness(table: FakeTable, o: { runMs?: number; usedMs?: number; store?: (real: AggregateRepository) => NightlyStore; rebuild?: () => RebuildResult } = {}): Harness {
  const repo = (now?: () => Date): AggregateRepository =>
    new AggregateRepository({ client: table.client, tableName: 'cupmark-test-main', sleep: () => Promise.resolve(), ...(now === undefined ? {} : { now }) });
  const real = repo();
  const lines: string[] = [];
  let reads = 0;
  const handle = createNightlyHandler({
    store: o.store?.(real) ?? real,
    now: () => {
      reads += 1;
      return o.runMs ?? RUN_MS;
    },
    log: (line) => lines.push(line),
    ...(o.rebuild === undefined ? {} : { rebuild: o.rebuild }),
  });
  return {
    run: (...args: [event?: unknown]) => {
      const event: unknown = args.length === 0 ? {} : args[0];
      let calls = 0;
      return handle(event, { getRemainingTimeInMillis: () => (calls++ === 0 ? TIMEOUT_MS : TIMEOUT_MS - (o.usedMs ?? 0)) });
    },
    lines,
    clockReads: () => reads,
    repo,
  };
}

function logged(h: Harness): Record<string, unknown> {
  expect(h.lines).toHaveLength(1);
  return JSON.parse(h.lines[0] ?? '') as Record<string, unknown>;
}

const FIXED_KEYS = [
  'beans_ranked',
  'beans_with_aggregates',
  'brews_counted',
  'brews_orphaned',
  'brews_seen',
  'dry_run',
  'duration_ms',
  'items_deleted',
  'items_scanned',
  'items_written',
  'operation',
  'reasons',
  'share_of_timeout',
  'status',
  'users_seen',
];

function crowdTable(): FakeTable {
  const table = new FakeTable();
  seedCrowd(table, 6, { brewsEach: 2 });
  return table;
}

describe('success', () => {
  it('scans, rebuilds and writes: a bean with 6 raters is readable afterwards', async () => {
    const table = crowdTable();
    const h = harness(table);
    await h.run();
    const read = await h.repo(() => new Date(RUN_MS)).readAggregate(BEAN);
    expect(read.kind).toBe('served');
    expect(table.writes.some((w) => w.pk === `BEAN#${BEAN}`)).toBe(true);
  });

  it('reads the wall clock once', async () => {
    const h = harness(crowdTable());
    await h.run();
    expect(h.clockReads()).toBe(1);
  });

  it('logs one line with the fixed keys and the run numbers', async () => {
    const table = crowdTable();
    const h = harness(table, { usedMs: 30_000 });
    const itemsBefore = table.items.size;
    await h.run();
    const line = logged(h);
    expect(Object.keys(line).sort()).toEqual(FIXED_KEYS);
    expect(line).toMatchObject({
      operation: 'nightly-aggregates',
      status: 'OK',
      dry_run: false,
      duration_ms: 30_000,
      share_of_timeout: 0.1,
      users_seen: 6,
      brews_seen: 12,
      brews_counted: 12,
      brews_orphaned: 0,
      beans_with_aggregates: 1,
      beans_ranked: 1,
    });
    expect(line.items_scanned).toBe(itemsBefore);
    expect(line.items_written).toBeGreaterThan(0);
    expect(line.items_deleted).toBe(0);
  });

  it('has a count for every contract reason id, zeros included, and nothing else', async () => {
    const h = harness(crowdTable());
    await h.run();
    const reasons = logged(h).reasons as Record<string, number>;
    expect(Object.keys(reasons).sort()).toEqual([...REASON_IDS].sort());
    expect(Object.values(reasons).every((n) => n === 0)).toBe(true);
  });

  it('counts the reasons: a user without consent adds no_consent', async () => {
    const table = crowdTable();
    seedCrowd(table, 1, { first: 20, consent: false, brewsEach: 3 });
    const h = harness(table);
    await h.run();
    const line = logged(h);
    expect((line.reasons as Record<string, number>).no_consent).toBe(3);
    expect(line.brews_counted).toBe(12);
    expect(line.brews_seen).toBe(15);
  });

  it('counts users_seen over every user with a brew, rejected users included', async () => {
    const table = crowdTable();
    seedCrowd(table, 2, { first: 20, consent: false }); // all brews rejected
    const h = harness(table);
    await h.run();
    expect(logged(h).users_seen).toBe(8);
  });

  it('counts an orphan brew (shelf entry missing) and does not fail the run', async () => {
    const table = crowdTable();
    table.put(profileItem(sub(40), true));
    table.put(brewItem(sub(40), ulid(900), ulid(901), BEAN, BREWED_MS));
    const h = harness(table);
    await h.run();
    expect(logged(h)).toMatchObject({ status: 'OK', brews_orphaned: 1, users_seen: 7 });
  });

  it('reports a share of the timeout from the remaining time', async () => {
    const h = harness(crowdTable(), { usedMs: 150_000 });
    await h.run();
    expect(logged(h)).toMatchObject({ duration_ms: 150_000, share_of_timeout: 0.5 });
  });

  it('a second run on the same day with the same input writes nothing', async () => {
    const table = crowdTable();
    await harness(table).run();
    const h = harness(table);
    const before = table.writes.length;
    await h.run();
    expect(table.writes).toHaveLength(before);
    expect(logged(h)).toMatchObject({ items_written: 0, items_deleted: 0 });
  });
});

describe('an empty table', () => {
  it('succeeds with every number zero', async () => {
    const table = new FakeTable();
    const h = harness(table);
    await h.run();
    const line = logged(h);
    expect(line).toMatchObject({
      status: 'OK',
      items_scanned: 0,
      users_seen: 0,
      brews_seen: 0,
      brews_counted: 0,
      brews_orphaned: 0,
      beans_with_aggregates: 0,
      beans_ranked: 0,
      items_written: 0,
      items_deleted: 0,
    });
    expect(Object.values(line.reasons as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(table.writes).toHaveLength(0);
  });
});

describe('fail closed', () => {
  it('a scan failure throws and writes nothing, on the first page and on a later one', async () => {
    for (const call of [1, 2]) {
      const table = crowdTable();
      const h = new AggregateRepository({ client: table.client, tableName: 'cupmark-test-main', sleep: () => Promise.resolve(), scanPageSize: 7 });
      const lines: string[] = [];
      const handle = createNightlyHandler({ store: h, now: () => RUN_MS, log: (l) => lines.push(l) });
      table.failScanOnCall = call;
      await expect(handle({}, { getRemainingTimeInMillis: () => TIMEOUT_MS })).rejects.toThrow('injected scan failure');
      expect(table.writes).toHaveLength(0);
      expect(table.batchCalls).toBe(0);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ status: 'FAILED', stage: 'scan' });
    }
  });

  it('a rebuild failure throws before any write', async () => {
    const table = crowdTable();
    const h = harness(table, {
      rebuild: () => {
        throw new RangeError('boom');
      },
    });
    await expect(h.run()).rejects.toThrow('boom');
    expect(table.writes).toHaveLength(0);
    expect(table.batchCalls).toBe(0);
    expect(logged(h)).toMatchObject({ status: 'FAILED', stage: 'rebuild', error: 'RangeError' });
  });

  it('a write failure throws and the run is logged as failed at the write', async () => {
    const table = crowdTable();
    table.failBatchOnCall = 1;
    const h = harness(table);
    await expect(h.run()).rejects.toThrow('injected batch failure');
    expect(logged(h)).toMatchObject({ status: 'FAILED', stage: 'write' });
  });

  it('a scan failure never calls the writer', async () => {
    let writes = 0;
    const h = harness(crowdTable(), {
      store: () => ({
        scanForRebuild: () => Promise.reject(new Error('scan down')),
        replaceAggregates: () => {
          writes += 1;
          return Promise.reject(new Error('must not be called'));
        },
      }),
    });
    await expect(h.run()).rejects.toThrow('scan down');
    expect(writes).toBe(0);
  });

  it('the failure line holds no message text', async () => {
    const h = harness(crowdTable(), {
      rebuild: () => {
        throw new Error(`secret ${sub(1)} ${BEAN}`);
      },
    });
    await expect(h.run()).rejects.toThrow();
    expect(h.lines[0]).not.toContain(sub(1));
    expect(h.lines[0]).not.toContain(BEAN);
    expect(Object.keys(logged(h)).sort()).toEqual(['dry_run', 'duration_ms', 'error', 'operation', 'share_of_timeout', 'stage', 'status']);
  });
});

describe('dry run', () => {
  it('scans and rebuilds, logs the same line shape with the same numbers and writes nothing', async () => {
    const real = harness(crowdTable());
    await real.run();
    const table = crowdTable();
    const h = harness(table);
    await h.run({ dry_run: true });
    expect(table.writes).toHaveLength(0);
    expect(table.batchCalls).toBe(0);
    expect(table.scanCalls).toBeGreaterThan(0);
    const dry = logged(h);
    const wet = logged(real);
    expect(Object.keys(dry).sort()).toEqual(FIXED_KEYS);
    expect(dry).toMatchObject({ dry_run: true, items_written: 0, items_deleted: 0 });
    for (const key of ['items_scanned', 'users_seen', 'brews_seen', 'brews_counted', 'brews_orphaned', 'reasons', 'beans_with_aggregates', 'beans_ranked']) {
      expect(dry[key]).toEqual(wet[key]);
    }
  });

  it('only the literal true selects a dry run', async () => {
    for (const event of [{ dry_run: 'true' }, { dry_run: 1 }, { dry_run: false }, null, 'dry_run', [], undefined]) {
      const table = crowdTable();
      const h = harness(table);
      await h.run(event);
      expect(table.writes.length).toBeGreaterThan(0);
    }
  });
});

describe('the event selects nothing', () => {
  it('ignores a user id, a bean id and other fields', async () => {
    const plain = crowdTable();
    await harness(plain).run();
    const table = crowdTable();
    const h = harness(table);
    await h.run({ user_id: sub(1), userId: sub(1), sub: sub(1), bean_id: BEAN, requestContext: { authorizer: { jwt: { claims: { sub: sub(2) } } } } });
    expect(table.keys()).toEqual(plain.keys());
    expect(logged(h)).toMatchObject({ users_seen: 6, brews_seen: 12 });
  });
});

describe('the log line holds no ids', () => {
  it('has no user id, bean id, shelf entry id or brew id, on a table with several of each', async () => {
    const table = crowdTable();
    seedCrowd(table, 5, { beanId: OTHER_BEAN, first: 30 });
    table.put(shelfItem(sub(1), ulid(777), BEAN));
    const h = harness(table);
    await h.run();
    const text = h.lines.join('\n');
    const ids = [...table.items.values()].flatMap((item) => [String(item.pk), String(item.sk)]).flatMap((part) => part.split(/[#|]/));
    for (const id of ids) {
      if (id.length >= 20) expect(text).not.toContain(id);
    }
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
  });
});

describe('staleness when the nights fail (ADR 0035 point 7a)', () => {
  it('last success on day D: a read on D+3 is served, on D+4 it is not available', async () => {
    const table = crowdTable();
    const day = (d: number): number => Date.UTC(2026, 10, d, 2, 0, 0);
    await harness(table, { runMs: day(24) }).run();
    for (const night of [25, 26, 27]) {
      table.failScanOnCall = table.scanCalls + 1;
      await expect(harness(table, { runMs: day(night) }).run()).rejects.toThrow('injected scan failure');
    }
    const at = (date: string): AggregateRepository => harness(table).repo(() => new Date(`${date}T12:00:00Z`));
    expect((await at('2026-11-24').readAggregate(BEAN)).kind).toBe('served');
    expect((await at('2026-11-27').readAggregate(BEAN)).kind).toBe('served');
    expect((await at('2026-11-28').readAggregate(BEAN)).kind).toBe('not_available');
  });
});

describe('the entry point', () => {
  it('fails without TABLE_NAME, logging a fixed word only', async () => {
    const saved = process.env.TABLE_NAME;
    delete process.env.TABLE_NAME;
    const logs: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(...args);
    };
    try {
      await expect(entryPoint({}, { getRemainingTimeInMillis: () => TIMEOUT_MS })).rejects.toThrow('TABLE_NAME');
    } finally {
      console.log = original;
      if (saved !== undefined) process.env.TABLE_NAME = saved;
    }
    expect(JSON.parse(String(logs[0]))).toEqual({ operation: 'nightly-aggregates', status: 'FAILED', stage: 'configuration', error: 'TableNameMissing' });
  });

  it('builds the SDK client with SDK_MAX_ATTEMPTS, above the default of 3', async () => {
    expect(SDK_MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(await newDynamoClient().config.maxAttempts()).toBe(SDK_MAX_ATTEMPTS);
  });
});
