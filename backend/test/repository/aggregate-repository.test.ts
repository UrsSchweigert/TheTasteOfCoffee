// The aggregate repository on an in-memory table (DynamoDB Local runs the same
// scenarios in test/integration/aggregates.test.ts): the paged Scan, the write
// and `readAggregate` with the 5-rater threshold (ADR 0035, M3-T7).
import { describe, expect, it } from 'vitest';
import { MAX_AGE_DAYS, MIN_RATERS } from '../../src/aggregation/config.ts';
import { BUCKET_IDS } from '../../src/aggregation/rebuild/buckets.ts';
import type { AggregateItem } from '../../src/aggregation/rebuild/types.ts';
import {
  AggregateRepository,
  AggregateWriteIncompleteError,
  CorruptItemError,
  InvalidKeyError,
  InvalidValuesError,
  aggregateAllKey,
  aggregateMethodKey,
  rankingKey,
} from '../../src/repository/index.ts';
import type { AggregateRead } from '../../src/repository/index.ts';
import { FakeTable } from './fake-table.ts';
import { BEAN, BREWED_MS, DAY, OTHER_BEAN, RUN_DAY, RUN_MS, aggItem, beanItem, brewItem, profileItem, runNight, seedCrowd, shelfItem, storedAggregate, storedRanking, sub, ulid } from './aggregate-fixtures.ts';

function repoOf(table: FakeTable, options: { now?: () => Date; pageSize?: number } = {}): AggregateRepository {
  return new AggregateRepository({
    client: table.client,
    tableName: 'cupmark-test-main',
    sleep: () => Promise.resolve(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pageSize === undefined ? {} : { scanPageSize: options.pageSize }),
  });
}

function atDay(day: string, time = '12:00:00Z'): () => Date {
  return () => new Date(`${day}T${time}`);
}

const NOW = atDay(RUN_DAY);

// ---------------------------------------------------------------------------

describe('scanForRebuild', () => {
  function seeded(): FakeTable {
    const table = new FakeTable();
    seedCrowd(table, 6, { brewsEach: 2 });
    seedCrowd(table, 2, { beanId: OTHER_BEAN, first: 7 });
    // Items the rebuild never reads: skipped by prefix.
    const user = sub(1);
    table.put({ pk: `USER#${user}`, sk: `BREWID#${ulid(5)}`, type: 'BREW_REF', brewId: ulid(5), brewSk: 'x', createdAt: 'x' });
    table.put({ pk: `USER#${user}`, sk: `RECIPE#${ulid(6)}`, type: 'RECIPE', values: { anything: true } });
    table.put({ pk: `USER#${user}`, sk: 'LOOKUPS#2026-11-27', type: 'LOOKUPS', count: 3, expires_at: 1 });
    table.put({ pk: `USER#${user}`, sk: `PHOTO#${ulid(7)}`, type: 'LABEL_PHOTO' });
    table.put({ pk: `USER#${user}`, sk: `PHOTO_PENDING#${ulid(8)}`, type: 'PHOTO_PENDING' });
    table.put({ pk: `USER#${user}`, sk: `BEANPHOTOS#${BEAN}`, type: 'BEAN_PHOTOS', photos: 1 });
    table.put({ pk: `USER#${user}`, sk: 'PHOTO_UPLOADS#2026-11-27', type: 'PHOTO_UPLOADS' });
    table.put({ pk: `DELETED#${sub(9)}`, sk: 'META', type: 'ACCOUNT_TOMBSTONE', deletedAt: 'x', expires_at: 1 });
    table.put({ pk: 'BARCODE#4006381333931', sk: 'BEAN', type: 'BARCODE', beanId: BEAN });
    table.put({ pk: 'BARCODE#4006381333931', sk: 'OFF', type: 'OFF_CACHE', result: 'miss' });
    table.put({ pk: `BEAN#${BEAN}`, sk: `PHOTO#${ulid(7)}`, type: 'BEAN_LABEL_PHOTO' });
    return table;
  }

  it('pages through the table with a fixed page size and returns every relevant item once', async () => {
    const table = seeded();
    table.put(storedAggregate(aggItem()));
    table.put(storedRanking({ facet: { kind: 'all' }, run_day: '2026-11-26', bean_ids: [BEAN] }));
    const total = table.items.size;
    const scan = await repoOf(table, { pageSize: 7 }).scanForRebuild();
    expect(table.scanCalls).toBe(Math.ceil(total / 7));
    expect(table.scanCalls).toBeGreaterThan(2);
    expect(new Set(table.scanLimits)).toEqual(new Set([7]));
    expect(scan.itemsScanned).toBe(total);
    expect(scan.brews).toHaveLength(14);
    expect(new Set(scan.brews.map((b) => b.brew.brew_id)).size).toBe(14);
    expect(scan.shelfEntries).toHaveLength(8);
    expect(scan.beans.map((b) => b.bean_id).sort()).toEqual([BEAN, OTHER_BEAN].sort());
    expect(scan.consentByUser.size).toBe(8);
    expect([...scan.consentByUser.values()].every((v) => v)).toBe(true);
    expect(scan.existing.aggregateCount).toBe(1);
    expect(scan.existing.rankingCount).toBe(1);
  });

  it('uses the default page size and eventually consistent reads', async () => {
    const table = seeded();
    await repoOf(table).scanForRebuild();
    expect(table.scanLimits).toEqual([500]);
  });

  it('takes the user id from the partition key, never from the item body', async () => {
    const table = new FakeTable();
    seedCrowd(table, 1);
    const scan = await repoOf(table).scanForRebuild();
    expect(scan.brews[0]?.userId).toBe(sub(1));
    expect(scan.shelfEntries[0]?.userId).toBe(sub(1));
    expect(scan.consentByUser.get(sub(1))).toBe(true);
  });

  it('reads withdrawn consent as false and gives a user without a profile no entry', async () => {
    const table = new FakeTable();
    seedCrowd(table, 1, { consent: false });
    table.put(shelfItem(sub(5), ulid(50), BEAN));
    const scan = await repoOf(table).scanForRebuild();
    expect(scan.consentByUser.get(sub(1))).toBe(false);
    expect(scan.consentByUser.has(sub(5))).toBe(false);
  });

  it('returns nothing when a page fails: it throws, and no later page is asked for', async () => {
    const table = seeded();
    table.failScanOnCall = 2;
    await expect(repoOf(table, { pageSize: 7 }).scanForRebuild()).rejects.toThrow('injected scan failure');
    expect(table.scanCalls).toBe(2);
  });

  it('fails the run on a page error without writing anything (the caller never gets a partial list)', async () => {
    const table = seeded();
    table.failScanOnCall = 3;
    const before = table.keys();
    await expect(runNight(repoOf(table, { pageSize: 7 }))).rejects.toThrow();
    expect(table.writes).toEqual([]);
    expect(table.keys()).toEqual(before);
  });

  const good = (): FakeTable => {
    const table = new FakeTable();
    seedCrowd(table, 1);
    return table;
  };
  it.each<[string, (table: FakeTable) => void]>([
    ['a brew with an unknown attribute', (t) => t.put({ ...brewItem(sub(1), ulid(3000), ulid(1001), BEAN, BREWED_MS), values: { ...(brewItem(sub(1), ulid(3000), ulid(1001), BEAN, BREWED_MS).values as object), note: 'free text' } })],
    ['a brew whose id differs from its key', (t) => t.put({ ...brewItem(sub(1), ulid(3000), ulid(1001), BEAN, BREWED_MS), brewId: ulid(3001) })],
    ['a brew that names another shelf entry than its values', (t) => t.put({ ...brewItem(sub(1), ulid(3000), ulid(1001), BEAN, BREWED_MS), shelfEntryId: ulid(3002) })],
    ['a brew whose score is off the grid', (t) => {
      const item = brewItem(sub(1), ulid(3000), ulid(1001), BEAN, BREWED_MS, 8.25);
      t.put(item);
    }],
    ['a shelf entry whose id differs from its key', (t) => t.put({ ...shelfItem(sub(1), ulid(3000), BEAN), shelfEntryId: ulid(3001) })],
    ['a shelf entry whose bean differs from its values', (t) => t.put({ ...shelfItem(sub(1), ulid(3000), BEAN), beanId: OTHER_BEAN })],
    ['a profile with an unknown locale', (t) => t.put({ ...profileItem(sub(2), true), values: { locale: 'fr', consent: { contribute_to_aggregates: true } } })],
    ['a profile with a consent that is not a boolean', (t) => t.put({ ...profileItem(sub(2), true), values: { locale: 'en', consent: { contribute_to_aggregates: 'yes' } } })],
    ['a bean whose id differs from its key', (t) => t.put({ ...beanItem(OTHER_BEAN), beanId: BEAN })],
    ['a bean with an unknown status', (t) => t.put({ ...beanItem(OTHER_BEAN), status: 'maybe' })],
    ['a user partition without a user id', (t) => t.put({ pk: 'USER#not-a-sub', sk: 'PROFILE', type: 'PROFILE', values: { locale: 'en', consent: { contribute_to_aggregates: true } } })],
    ['an item without a sort key', (t) => t.items.set('x\u0000y', { pk: 'USER#x' })],
  ])('throws on %s, and returns nothing', async (_name, corrupt) => {
    const table = good();
    corrupt(table);
    await expect(repoOf(table).scanForRebuild()).rejects.toThrow(CorruptItemError);
  });

  it('tolerates an old aggregate or ranking item that does not decode, so the run that repairs it can run', async () => {
    const table = good();
    table.put({ ...aggregateAllKey(BEAN), type: 'AGGREGATE', raters: 'many' });
    table.put({ ...aggregateMethodKey(BEAN, 'v60'), type: 'SOMETHING' });
    table.put({ pk: `BEAN#${BEAN}`, sk: 'AGG#UNKNOWN', junk: true });
    table.put({ pk: 'RANK#ALL', sk: '2026-11-20', bean_ids: 'x' });
    table.put({ pk: 'RANK#NOT_A_FACET#x', sk: '2026-11-20' });
    const scan = await repoOf(table).scanForRebuild();
    expect(scan.existing.aggregateCount).toBe(3);
    expect(scan.existing.rankingCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('replaceAggregates', () => {
  const fiveRaters = (): FakeTable => {
    const table = new FakeTable();
    seedCrowd(table, 5, { brewsEach: 2 });
    return table;
  };

  it('writes the rebuilt aggregates and rankings, and a reader gets them through readAggregate', async () => {
    const table = fiveRaters();
    const repo = repoOf(table, { now: NOW });
    const { result, written } = await runNight(repo);
    expect(result.aggregates.length).toBeGreaterThan(0);
    expect(written).toBe(result.aggregates.length + result.rankings.length);
    expect(table.keys('RANK#')).toEqual(['RANK#ALL | 2026-11-27', 'RANK#METHOD#v60 | 2026-11-27']);
    const read = await repo.readAggregate(BEAN);
    expect(read.kind).toBe('served');
    if (read.kind === 'served') expect(read.aggregate.raters).toBe(5);
    expect((await repo.readAggregate(BEAN, 'v60')).kind).toBe('served');
    expect(await repo.readAggregate(BEAN, 'espresso')).toEqual({ kind: 'not_enough_raters' });
  });

  it('is idempotent: a second run on the same day with the same input writes nothing', async () => {
    const table = fiveRaters();
    const repo = repoOf(table);
    await runNight(repo);
    const snapshot = JSON.stringify([...table.items.entries()].sort());
    const writesBefore = table.writes.length;
    const batchesBefore = table.batchCalls;
    const second = await runNight(repo, RUN_MS + 3_600_000);
    expect(second.written).toBe(0);
    expect(second.deleted).toBe(0);
    expect(table.writes.length).toBe(writesBefore);
    expect(table.batchCalls).toBe(batchesBefore);
    expect(JSON.stringify([...table.items.entries()].sort())).toBe(snapshot);
  });

  it('next day: unchanged AGG items are not rewritten, the rankings are replaced by the new day and yesterday is deleted', async () => {
    const table = fiveRaters();
    const repo = repoOf(table);
    await runNight(repo);
    const aggregates = table.keys('BEAN#').filter((k) => k.includes('AGG#'));
    expect(aggregates.length).toBe(2);
    table.writes.length = 0;
    const next = await runNight(repo, RUN_MS + DAY);
    const aggWrites = table.writes.filter((w) => w.sk.startsWith('AGG#'));
    expect(aggWrites).toEqual([]);
    // Two ranking items (all, v60): two puts for 2026-11-28 and two deletes for 2026-11-27.
    expect(table.writes.filter((w) => w.op === 'put').map((w) => `${w.pk} | ${w.sk}`).sort()).toEqual(['RANK#ALL | 2026-11-28', 'RANK#METHOD#v60 | 2026-11-28']);
    expect(table.writes.filter((w) => w.op === 'delete').map((w) => `${w.pk} | ${w.sk}`).sort()).toEqual(['RANK#ALL | 2026-11-27', 'RANK#METHOD#v60 | 2026-11-27']);
    expect(table.keys('RANK#')).toEqual(['RANK#ALL | 2026-11-28', 'RANK#METHOD#v60 | 2026-11-28']);
    expect(next.written).toBe(2);
    expect(table.get(aggregateAllKey(BEAN).pk, 'AGG#ALL')?.run_day).toBe(RUN_DAY);
  });

  it('refreshes the stamp of an unchanged AGG item once it is 2 days behind, so it never reaches the age limit', async () => {
    const table = fiveRaters();
    const repo = repoOf(table);
    await runNight(repo);
    const stamp = (): unknown => table.get(aggregateAllKey(BEAN).pk, 'AGG#ALL')?.run_day;
    await runNight(repo, RUN_MS + DAY);
    expect(stamp()).toBe('2026-11-27');
    const second = await runNight(repo, RUN_MS + 2 * DAY);
    expect(stamp()).toBe('2026-11-29');
    // The two AGG items plus the rankings.
    expect(second.written).toBe(4);
    // Ten successful nights: a reader at the end of every night day serves the bean.
    for (let night = 3; night <= 12; night += 1) {
      await runNight(repo, RUN_MS + night * DAY);
      const read = await repoOf(table, { now: () => new Date(RUN_MS + night * DAY + 3_600_000) }).readAggregate(BEAN);
      expect(read.kind).toBe('served');
    }
  });

  it('rewrites an AGG item whose numbers changed, and only that one', async () => {
    const table = fiveRaters();
    const repo = repoOf(table);
    await runNight(repo);
    // A sixth rater of the bean, in method v60: both AGG items change.
    seedCrowd(table, 1, { first: 6 });
    table.writes.length = 0;
    await runNight(repo, RUN_MS + 3_600_000);
    expect(table.writes.filter((w) => w.sk.startsWith('AGG#')).map((w) => w.sk).sort()).toEqual(['AGG#ALL', 'AGG#METHOD#v60']);
    expect(table.get(aggregateAllKey(BEAN).pk, 'AGG#ALL')?.raters).toBe(6);
  });

  it('deletes the aggregates and rankings of a bean that lost its raters', async () => {
    const table = fiveRaters();
    seedCrowd(table, 5, { beanId: OTHER_BEAN, first: 20 });
    const repo = repoOf(table);
    await runNight(repo);
    expect(table.keys('BEAN#').filter((k) => k.includes('AGG#'))).toHaveLength(4);
    // The five raters of OTHER_BEAN withdraw consent.
    for (let n = 20; n < 25; n += 1) table.put(profileItem(sub(n), false));
    table.writes.length = 0;
    await runNight(repo, RUN_MS + 3_600_000);
    expect(table.keys('BEAN#').filter((k) => k.includes('AGG#'))).toEqual([`BEAN#${BEAN} | AGG#ALL`, `BEAN#${BEAN} | AGG#METHOD#v60`]);
    expect(table.writes.filter((w) => w.op === 'delete').map((w) => `${w.pk} | ${w.sk}`).sort()).toEqual([`BEAN#${OTHER_BEAN} | AGG#ALL`, `BEAN#${OTHER_BEAN} | AGG#METHOD#v60`]);
    expect(await repoOf(table, { now: NOW }).readAggregate(OTHER_BEAN)).toEqual({ kind: 'not_enough_raters' });
  });

  it('deletes stray aggregate and ranking items the new set does not contain, and rewrites one that does not decode', async () => {
    const table = fiveRaters();
    table.put({ pk: `BEAN#${BEAN}`, sk: 'AGG#UNKNOWN', junk: true });
    table.put({ pk: 'RANK#ALL', sk: '2026-11-01', bean_ids: 'x' });
    table.put({ ...aggregateAllKey(BEAN), type: 'AGGREGATE', raters: 'many' });
    const repo = repoOf(table, { now: NOW });
    await runNight(repo);
    expect(table.get(`BEAN#${BEAN}`, 'AGG#UNKNOWN')).toBeUndefined();
    expect(table.get('RANK#ALL', '2026-11-01')).toBeUndefined();
    expect((await repo.readAggregate(BEAN)).kind).toBe('served');
  });

  it('never touches an item that is not an aggregate or a ranking', async () => {
    const table = fiveRaters();
    table.put({ pk: `BEAN#${BEAN}`, sk: `PHOTO#${ulid(7)}`, type: 'BEAN_LABEL_PHOTO' });
    table.put({ pk: `DELETED#${sub(9)}`, sk: 'META', type: 'ACCOUNT_TOMBSTONE', deletedAt: 'x', expires_at: 1 });
    await runNight(repoOf(table));
    expect(table.writes.filter((w) => w.op === 'delete')).toEqual([]);
    expect(table.get(`BEAN#${BEAN}`, 'META')).toBeDefined();
    expect(table.get(`BEAN#${BEAN}`, `PHOTO#${ulid(7)}`)).toBeDefined();
  });

  it('retries unprocessed requests', async () => {
    const table = fiveRaters();
    table.leaveUnprocessedCalls = 3;
    const { result } = await runNight(repoOf(table));
    expect(table.batchCalls).toBeGreaterThan(1);
    expect(table.keys('RANK#')).toHaveLength(result.rankings.length);
    expect(table.keys('BEAN#').filter((k) => k.includes('AGG#'))).toHaveLength(result.aggregates.length);
  });

  it('throws when requests stay unprocessed after the retries', async () => {
    const table = fiveRaters();
    table.neverProcess = true;
    await expect(runNight(repoOf(table))).rejects.toThrow(AggregateWriteIncompleteError);
  });

  it('refuses an item with another run day, a repeated item or an item off the schema before any write', async () => {
    const table = new FakeTable();
    const repo = repoOf(table);
    const empty = (await repo.scanForRebuild()).existing;
    const ok = aggItem();
    await expect(repo.replaceAggregates({ aggregates: [aggItem({ runDay: '2026-11-26' })], rankings: [] }, empty, RUN_DAY)).rejects.toThrow(InvalidValuesError);
    await expect(repo.replaceAggregates({ aggregates: [ok, ok], rankings: [] }, empty, RUN_DAY)).rejects.toThrow(InvalidValuesError);
    await expect(repo.replaceAggregates({ aggregates: [aggItem({ over: { notes: { not_a_note: 1 } as never } })], rankings: [] }, empty, RUN_DAY)).rejects.toThrow(InvalidValuesError);
    await expect(repo.replaceAggregates({ aggregates: [], rankings: [{ facet: { kind: 'all' }, run_day: '2026-11-26', bean_ids: [BEAN] }] }, empty, RUN_DAY)).rejects.toThrow(InvalidValuesError);
    await expect(repo.replaceAggregates({ aggregates: [], rankings: [{ facet: { kind: 'all' }, run_day: RUN_DAY, bean_ids: ['not an id'] }] }, empty, RUN_DAY)).rejects.toThrow(InvalidValuesError);
    expect(table.batchCalls).toBe(0);
  });

  describe('a failure part way', () => {
    // Thirty beans: 30 puts and, with the old set, 30 deletes in more than one batch.
    const beans = Array.from({ length: 30 }, (_, i) => ulid(100 + i));

    it('throws, leaves a mix of whole old and whole new items, and the read applies the threshold to each one', async () => {
      const table = new FakeTable();
      // The old night: every bean had 6 raters (served), method items too.
      for (const bean of beans) table.put(storedAggregate(aggItem({ bean, raters: 6, runDay: '2026-11-26' })));
      const repo = repoOf(table, { now: NOW });
      const empty = (await repo.scanForRebuild()).existing;
      expect(empty.aggregateCount).toBe(30);
      // The new night: every bean fell to 4 raters (must not be served), written in two batches; the second fails.
      table.failBatchOnCall = 2;
      const next = beans.map((bean) => aggItem({ bean, raters: 4 }));
      await expect(repo.replaceAggregates({ aggregates: next, rankings: [] }, empty, RUN_DAY)).rejects.toThrow('injected batch failure');
      const reads: AggregateRead['kind'][] = [];
      for (const bean of beans) reads.push((await repo.readAggregate(bean)).kind);
      // First batch (25 items) is new: not enough raters. The rest are still the old items: served.
      expect(reads.filter((r) => r === 'not_enough_raters')).toHaveLength(25);
      expect(reads.filter((r) => r === 'served')).toHaveLength(5);
      for (const bean of beans) {
        const stored = table.get(`BEAN#${bean}`, 'AGG#ALL');
        expect([4, 6]).toContain(stored?.raters);
        expect(stored?.run_day).toBe(stored?.raters === 4 ? RUN_DAY : '2026-11-26');
      }
      // The next night repairs it.
      table.failBatchOnCall = undefined;
      await repo.replaceAggregates({ aggregates: next, rankings: [] }, (await repo.scanForRebuild()).existing, RUN_DAY);
      for (const bean of beans) expect((await repo.readAggregate(bean)).kind).toBe('not_enough_raters');
    });
  });
});

// ---------------------------------------------------------------------------

describe('readAggregate', () => {
  const parts = (): Partial<AggregateItem> => ({
    intensities: { acidity: { low: 2520, medium: 5040, high: 5040 }, body: { medium: 12600 } },
    notes: { berry: 7560, honey: 2520 },
    buy_again: { yes: 10080, no: 2520 },
    histograms: { ratio: { [BUCKET_IDS.ratio[0] ?? '']: 5040, [BUCKET_IDS.ratio[1] ?? '']: 7560 } },
    raters_by_part: { buy_again: 5, notes: 5, intensities: { acidity: 5, body: 5 }, histograms: { ratio: 5 } },
  });

  function withItem(item: AggregateItem, now: () => Date = NOW): { repo: AggregateRepository; table: FakeTable } {
    const table = new FakeTable();
    table.put(storedAggregate(item));
    return { repo: repoOf(table, { now }), table };
  }

  it('gives "not enough raters" at 4 raters, with nothing else, even though the item holds sums', async () => {
    const { repo } = withItem(aggItem({ raters: 4, over: parts() }));
    const read = await repo.readAggregate(BEAN);
    expect(read).toEqual({ kind: 'not_enough_raters' });
    expect(JSON.stringify(read)).toBe('{"kind":"not_enough_raters"}');
  });

  it('serves the data at exactly 5 raters', async () => {
    const { repo } = withItem(aggItem({ raters: 5 }));
    const read = await repo.readAggregate(BEAN);
    expect(read.kind).toBe('served');
    if (read.kind !== 'served') return;
    expect(read.aggregate.raters).toBe(5);
    expect(read.aggregate.run_day).toBe(RUN_DAY);
    expect(read.aggregate.criteria.overall).toEqual({ mean_tenths: 80, spread_tenths: 0 });
  });

  it('gives "not enough raters" for a bean with no item, the same as for one below the threshold', async () => {
    const { repo } = withItem(aggItem({ raters: 5 }));
    expect(await repo.readAggregate(OTHER_BEAN)).toEqual({ kind: 'not_enough_raters' });
    expect(await repo.readAggregate(BEAN, 'espresso')).toEqual({ kind: 'not_enough_raters' });
  });

  it('computes mean and spread exactly from the integers: four cups of 8.0 and one of 10.0', async () => {
    // Half-points 16, 16, 16, 16, 20, one vote each (2520): W = 12600, S = 211680, SS = 3588480.
    const W = 2520 * 5;
    const totals = { weighted_count: W, sum: 2520 * 84, sum_of_squares: 2520 * (4 * 256 + 400) };
    const criteria = Object.fromEntries(['aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall'].map((c) => [c, totals])) as unknown as AggregateItem['criteria'];
    const { repo } = withItem(aggItem({ over: { criteria } }));
    const read = await repo.readAggregate(BEAN);
    if (read.kind !== 'served') throw new Error('expected served');
    // Mean 8.4 points; variance 2.56 half-points squared, so 1.6 half-points = 0.8 points.
    expect(read.aggregate.criteria.aroma).toEqual({ mean_tenths: 84, spread_tenths: 8 });
  });

  it('never returns a raw sum, a sum of squares or a weighted count', async () => {
    const { repo } = withItem(aggItem({ raters: 5, over: parts() }));
    const read = await repo.readAggregate(BEAN);
    if (read.kind !== 'served') throw new Error('expected served');
    const text = JSON.stringify(read);
    expect(text).not.toMatch(/weighted|sum|"yes"|"no"|2520|denominator/);
    expect(text).not.toContain(String(2520 * 5 * 16));
    // Shares and figures only.
    expect(read.aggregate.buy_again_yes_percent).toBe(80);
    expect(read.aggregate.intensities).toEqual({ acidity: { low: 20, medium: 40, high: 40 }, body: { medium: 100 } });
    expect(read.aggregate.notes).toEqual({ berry: 60, honey: 20 });
    expect(read.aggregate.histograms).toEqual({ ratio: { [BUCKET_IDS.ratio[0] ?? '']: 40, [BUCKET_IDS.ratio[1] ?? '']: 60 } });
  });

  describe('withholds each optional part below 5 raters of its own, and returns the rest', () => {
    const only = (part: 'buy_again' | 'notes' | 'acidity' | 'body' | 'ratio', count: number): AggregateItem => {
      const base = parts();
      const by = base.raters_by_part;
      if (by === undefined) throw new Error('fixture');
      const raters_by_part = {
        buy_again: part === 'buy_again' ? count : 5,
        notes: part === 'notes' ? count : 5,
        intensities: { acidity: part === 'acidity' ? count : 5, body: part === 'body' ? count : 5 },
        histograms: { ratio: part === 'ratio' ? count : 5 },
      };
      return aggItem({ raters: 5, over: { ...base, raters_by_part } });
    };
    const present = {
      buy_again: (a: Extract<AggregateRead, { kind: 'served' }>['aggregate']) => a.buy_again_yes_percent !== undefined,
      notes: (a: Extract<AggregateRead, { kind: 'served' }>['aggregate']) => a.notes !== undefined,
      acidity: (a: Extract<AggregateRead, { kind: 'served' }>['aggregate']) => a.intensities?.acidity !== undefined,
      body: (a: Extract<AggregateRead, { kind: 'served' }>['aggregate']) => a.intensities?.body !== undefined,
      ratio: (a: Extract<AggregateRead, { kind: 'served' }>['aggregate']) => a.histograms?.ratio !== undefined,
    } as const;

    for (const part of ['buy_again', 'notes', 'acidity', 'body', 'ratio'] as const) {
      it(`${part}: withheld at 1 and at 4 raters, served at 5; the other parts stay`, async () => {
        for (const count of [1, 4]) {
          const read = await withItem(only(part, count)).repo.readAggregate(BEAN);
          if (read.kind !== 'served') throw new Error('expected served');
          expect(present[part](read.aggregate)).toBe(false);
          for (const other of Object.keys(present) as (keyof typeof present)[]) {
            if (other !== part) expect(present[other](read.aggregate)).toBe(true);
          }
          expect(read.aggregate.raters).toBe(5);
          expect(Object.keys(read.aggregate.criteria)).toHaveLength(8);
        }
        const read = await withItem(only(part, MIN_RATERS)).repo.readAggregate(BEAN);
        if (read.kind !== 'served') throw new Error('expected served');
        expect(present[part](read.aggregate)).toBe(true);
      });
    }

    it('withholds a whole parent part (no notes, no histograms) when none has enough raters', async () => {
      const item = aggItem({ raters: 5, over: { ...parts(), raters_by_part: { buy_again: 1, notes: 1, intensities: { acidity: 1 }, histograms: { ratio: 1 } } } });
      const read = await withItem(item).repo.readAggregate(BEAN);
      if (read.kind !== 'served') throw new Error('expected served');
      expect(Object.keys(read.aggregate).sort()).toEqual(['criteria', 'raters', 'run_day']);
    });

    it('a part with enough raters but nothing counted is left out, not an error', async () => {
      const item = aggItem({ raters: 5, over: { buy_again: { yes: 0, no: 0 }, raters_by_part: { buy_again: 5, notes: 5, intensities: {}, histograms: {} } } });
      const read = await withItem(item).repo.readAggregate(BEAN);
      if (read.kind !== 'served') throw new Error('expected served');
      expect(read.aggregate.buy_again_yes_percent).toBeUndefined();
      expect(read.aggregate.notes).toBeUndefined();
    });
  });

  describe('age (ADR 0035 point 7a)', () => {
    const item = aggItem({ runDay: '2026-11-24' });
    it('serves on stamp day D, D+1, D+2 and D+3, and gives "not available" from D+4', async () => {
      expect(MAX_AGE_DAYS).toBe(3);
      const kinds: Record<string, string> = {};
      for (const day of ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-12-05']) {
        kinds[day] = (await withItem(item, atDay(day)).repo.readAggregate(BEAN)).kind;
      }
      expect(kinds).toEqual({
        '2026-11-24': 'served',
        '2026-11-25': 'served',
        '2026-11-26': 'served',
        '2026-11-27': 'served',
        '2026-11-28': 'not_available',
        '2026-12-05': 'not_available',
      });
    });

    it('counts UTC days: 23:59:59.999 on D+3 is served, 00:00:00 on D+4 is not, whatever the local time', async () => {
      expect((await withItem(item, atDay('2026-11-27', '23:59:59.999Z')).repo.readAggregate(BEAN)).kind).toBe('served');
      expect((await withItem(item, atDay('2026-11-28', '00:00:00.000Z')).repo.readAggregate(BEAN)).kind).toBe('not_available');
      expect((await withItem(item, atDay('2026-11-27', '23:59:59.999-05:00')).repo.readAggregate(BEAN)).kind).toBe('not_available');
    });

    it('does not serve a stamp from the future', async () => {
      expect((await withItem(aggItem({ runDay: '2026-11-28' })).repo.readAggregate(BEAN)).kind).toBe('not_available');
    });

    it('answers the threshold before the age: a stale item below 5 raters is "not enough raters"', async () => {
      expect(await withItem(aggItem({ raters: 4, runDay: '2026-11-01' })).repo.readAggregate(BEAN)).toEqual({ kind: 'not_enough_raters' });
    });

    it('the last success on day D, the scan failing on the nights between: D+3 served, D+4 gone', async () => {
      const table = new FakeTable();
      seedCrowd(table, 5);
      await runNight(repoOf(table), Date.UTC(2026, 10, 24, 2, 0, 0));
      table.failScanOnCall = table.scanCalls + 1;
      await expect(runNight(repoOf(table), Date.UTC(2026, 10, 25, 2, 0, 0))).rejects.toThrow();
      const at = (day: string): AggregateRepository => repoOf(table, { now: atDay(day) });
      expect((await at('2026-11-27').readAggregate(BEAN)).kind).toBe('served');
      expect((await at('2026-11-28').readAggregate(BEAN)).kind).toBe('not_available');
    });
  });

  describe('items that are not what the rebuild writes', () => {
    it.each<[string, (item: AggregateItem) => Record<string, unknown>]>([
      ['another weight denominator', (i) => ({ ...storedAggregate(i), weight_denominator: 3000 })],
      ['a criterion without weight', (i) => ({ ...storedAggregate(i), criteria: { ...i.criteria, overall: { weighted_count: 0, sum: 0, sum_of_squares: 0 } } })],
      ['a sum of squares below the square of the sum', (i) => ({ ...storedAggregate(i), criteria: { ...i.criteria, overall: { weighted_count: 12600, sum: 12600 * 16, sum_of_squares: 1 } } })],
      ['an unknown attribute', (i) => ({ ...storedAggregate(i), user_id: sub(1) })],
      ['a negative count', (i) => ({ ...storedAggregate(i), raters: -5 })],
      ['a fractional count', (i) => ({ ...storedAggregate(i), raters: 5.5 })],
      ['another bean id than its key', (i) => ({ ...storedAggregate(i), bean_id: OTHER_BEAN })],
      ['a method on an all item', (i) => ({ ...storedAggregate(i), method: 'v60' })],
      ['a bucket id of another parameter', (i) => ({ ...storedAggregate(i), histograms: { ratio: { [BUCKET_IDS.brew_time_s[0] ?? '']: 1 } } })],
      ['a wrong type', (i) => ({ ...storedAggregate(i), type: 'RANKING' })],
    ])('throws CorruptItemError for %s, never serving it', async (_name, make) => {
      const table = new FakeTable();
      table.put(make(aggItem()));
      await expect(repoOf(table, { now: NOW }).readAggregate(BEAN)).rejects.toThrow(CorruptItemError);
    });
  });

  it('reads the method item for a method and the all item without one', async () => {
    const table = new FakeTable();
    table.put(storedAggregate(aggItem({ raters: 9 })));
    table.put(storedAggregate(aggItem({ method: 'espresso', raters: 6 })));
    const repo = repoOf(table, { now: NOW });
    const all = await repo.readAggregate(BEAN);
    const espresso = await repo.readAggregate(BEAN, 'espresso');
    expect(all.kind === 'served' && all.aggregate.raters).toBe(9);
    expect(espresso.kind === 'served' && espresso.aggregate.raters).toBe(6);
  });

  it('refuses a bad bean id or method before any request is sent', async () => {
    const table = new FakeTable();
    const repo = repoOf(table, { now: NOW });
    for (const bad of ['', 'bean1', `${BEAN}#x`, `USER#${sub(1)}`, 'AGG#ALL']) {
      await expect(repo.readAggregate(bad)).rejects.toThrow(InvalidKeyError);
    }
    await expect(repo.readAggregate(BEAN, 'ALL' as never)).rejects.toThrow(InvalidKeyError);
    await expect(repo.readAggregate(BEAN, 'v60#x' as never)).rejects.toThrow(InvalidKeyError);
    expect(table.getCalls).toBe(0);
  });

  it('end to end: a bean with 4 raters gives nothing, with 5 gives data, whatever the number of cups', async () => {
    const table = new FakeTable();
    seedCrowd(table, 4, { brewsEach: 10 });
    const repo = repoOf(table, { now: NOW });
    await runNight(repo);
    // The item exists (stored, not served) and holds the sums.
    expect(table.get(`BEAN#${BEAN}`, 'AGG#ALL')?.raters).toBe(4);
    expect(await repo.readAggregate(BEAN)).toEqual({ kind: 'not_enough_raters' });
    seedCrowd(table, 1, { first: 5 });
    await runNight(repo, RUN_MS + 3_600_000);
    const read = await repo.readAggregate(BEAN);
    expect(read.kind).toBe('served');
  });

  it('end to end: a withdrawn rater takes the bean back below the threshold at the next run', async () => {
    const table = new FakeTable();
    seedCrowd(table, 5);
    const repo = repoOf(table, { now: NOW });
    await runNight(repo);
    expect((await repo.readAggregate(BEAN)).kind).toBe('served');
    table.put(profileItem(sub(3), false));
    await runNight(repo, RUN_MS + 3_600_000);
    expect(await repo.readAggregate(BEAN)).toEqual({ kind: 'not_enough_raters' });
  });

  it('ranking keys used by the writer are the key builder ones', async () => {
    const table = new FakeTable();
    seedCrowd(table, 5);
    await runNight(repoOf(table));
    const key = rankingKey({ kind: 'all' }, RUN_DAY);
    expect(table.get(key.pk, key.sk)).toEqual({ ...key, type: 'RANKING', bean_ids: [BEAN], run_day: RUN_DAY });
  });
});
