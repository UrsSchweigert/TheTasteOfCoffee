// Builders for the aggregate repository tests: stored items in the shapes the
// repository writes (src/repository/repository.ts) and synthetic aggregate items.
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import type { AggregateItem, RankingItem, RebuildResult } from '../../src/aggregation/rebuild/types.ts';
import { aggregateAllKey, aggregateMethodKey, brewKey, rankingKey, shelfEntryKey } from '../../src/repository/index.ts';
import type { AggregateRepository } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { validBrewInput } from '../fixtures.ts';
import type { FakeTable } from './fake-table.ts';
import type { Item } from './fake-table.ts';

export const RUN_MS = Date.UTC(2026, 10, 27, 12, 0, 0);
export const RUN_DAY = '2026-11-27';
export const DAY = 86_400_000;
export const BREWED_MS = Date.UTC(2026, 10, 20, 9, 0, 0);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A valid ULID that differs per `n` (0 to 32767). */
export function ulid(n: number): string {
  const digits = [Math.floor(n / 1024) % 32, Math.floor(n / 32) % 32, n % 32].map((d) => CROCKFORD.charAt(d)).join('');
  return `01JDQ8Z6V3W4X5Y6Z7A8B9C${digits}`;
}

/** A Cognito-shaped user id that differs per `n`. */
export function sub(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const BEAN = ulid(1);
export const OTHER_BEAN = ulid(2);

export function profileItem(user: string, consent: boolean): Item {
  return { pk: `USER#${user}`, sk: 'PROFILE', type: 'PROFILE', values: { locale: 'en', consent: { contribute_to_aggregates: consent } } };
}

export function shelfItem(user: string, entryId: string, beanId: string): Item {
  const key = shelfEntryKey(verifiedUserId(user), entryId);
  return { ...key, type: 'SHELF', shelfEntryId: entryId, beanId, values: { vocabulary_version: 1, bean_id: beanId, purchase_date: '2026-11-01' } };
}

export function brewItem(user: string, brewId: string, entryId: string, beanId: string, atMs: number, overall = 8): Item {
  const values = validBrewInput();
  const rating = values.rating as { scores: Record<string, number> };
  const brewedAt = new Date(atMs).toISOString();
  const key = brewKey(verifiedUserId(user), brewedAt, brewId);
  return {
    ...key,
    type: 'BREW',
    brewId,
    shelfEntryId: entryId,
    beanId,
    values: { ...values, shelf_entry_id: entryId, brewed_at: brewedAt, rating: { ...rating, scores: { ...rating.scores, overall } } },
  };
}

export function beanItem(beanId: string): Item {
  return {
    pk: `BEAN#${beanId}`,
    sk: 'META',
    type: 'BEAN',
    beanId,
    status: 'unverified',
    createdAt: '2026-11-01T10:00:00.000Z',
    vocabularyVersion: 1,
    openFoodFactsMatch: false,
    pickedAttributes: {},
    operatorAttributes: {},
  };
}

/** `users` users with a profile, a shelf entry and `brewsEach` rated brews of `beanId`, on day BREWED_MS plus `dayOffset`. */
export function seedCrowd(table: FakeTable, users: number, o: { beanId?: string; brewsEach?: number; first?: number; consent?: boolean; overall?: (user: number) => number } = {}): void {
  const beanId = o.beanId ?? BEAN;
  const first = o.first ?? 1;
  for (let n = first; n < first + users; n += 1) {
    const user = sub(n);
    const entryId = ulid(1000 + n);
    table.put(profileItem(user, o.consent ?? true));
    table.put(shelfItem(user, entryId, beanId));
    for (let i = 0; i < (o.brewsEach ?? 1); i += 1) {
      table.put(brewItem(user, ulid(2000 + n * 20 + i), entryId, beanId, BREWED_MS + i * 10 * 60_000, o.overall?.(n) ?? 8));
    }
  }
  table.put(beanItem(beanId));
}

/** One night: scan, rebuild with the run time, replace. Returns what the rebuild produced and what the write did. */
export async function runNight(repo: AggregateRepository, runMs: number = RUN_MS): Promise<{ result: RebuildResult; written: number; deleted: number }> {
  const scan = await repo.scanForRebuild();
  const result = rebuild({ brews: scan.brews, shelfEntries: scan.shelfEntries, beans: scan.beans, consentByUser: scan.consentByUser, runTimeMs: runMs });
  const report = await repo.replaceAggregates(result, scan.existing, new Date(runMs).toISOString().slice(0, 10));
  return { result, written: report.written, deleted: report.deleted };
}

const CRITERIA = ['aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall'] as const;

/** A consistent synthetic item: every score 8.0 points (16 half-points), no spread, one vote of 2520 per rater. */
export function aggItem(o: { bean?: string; method?: AggregateItem['method']; raters?: number; runDay?: string; over?: Partial<AggregateItem> } = {}): AggregateItem {
  const raters = o.raters ?? 5;
  const w = 2520 * raters;
  const criteria = Object.fromEntries(CRITERIA.map((c) => [c, { weighted_count: w, sum: w * 16, sum_of_squares: w * 256 }])) as unknown as AggregateItem['criteria'];
  return {
    kind: o.method === undefined ? 'all' : 'method',
    bean_id: o.bean ?? BEAN,
    ...(o.method === undefined ? {} : { method: o.method }),
    run_day: o.runDay ?? RUN_DAY,
    weight_denominator: 2520,
    raters,
    criteria,
    intensities: {},
    notes: {},
    buy_again: { yes: 0, no: 0 },
    histograms: {},
    raters_by_part: { buy_again: 0, notes: 0, intensities: {}, histograms: {} },
    ...o.over,
  };
}

export function storedAggregate(item: AggregateItem): Item {
  const key = item.kind === 'all' ? aggregateAllKey(item.bean_id) : aggregateMethodKey(item.bean_id, item.method ?? 'v60');
  return { ...key, type: 'AGGREGATE', ...item };
}

export function storedRanking(item: RankingItem): Item {
  const key = rankingKey(item.facet, item.run_day);
  return { ...key, type: 'RANKING', bean_ids: [...item.bean_ids], run_day: item.run_day };
}
