// What the Scan found of the aggregate and ranking items already in the table,
// kept so the writer can compare (ADR 0035 point 8). The class is opaque on
// purpose: its items are never handed back to a caller. The only things it
// answers are counts and a write plan (which items to put, which keys to
// delete). The one function that returns aggregate data is `readAggregate`.
import { ageInDays, needsStampRefresh } from '../aggregation/age.ts';
import type { AggregateItem, RankingItem } from '../aggregation/rebuild/types.ts';
import { AGGREGATE_ITEM_TYPE, RANKING_ITEM_TYPE, RankingBody, canonical, parseAggregateBody } from './aggregate-schemas.ts';
import type { RankingBodyValue } from './aggregate-schemas.ts';
import { InvalidValuesError } from './errors.ts';
import { aggregateAllKey, aggregateMethodKey, rankingKey } from './keys.ts';
import type { Key } from './keys.ts';

/** One item to put: its key attributes, `type` and the contract attributes. */
export type PutItem = Readonly<Record<string, unknown>> & Key;

export interface WritePlan {
  readonly puts: readonly PutItem[];
  readonly deletes: readonly Key[];
  /** Counts for the run's log line: what the plan skipped because nothing changed. */
  readonly unchangedAggregates: number;
  readonly unchangedRankings: number;
}

interface Found<T> {
  readonly key: Key;
  /** Undefined when the stored item does not decode: it is then always rewritten, or deleted. */
  readonly body: T | undefined;
}

export const keyText = (key: Key): string => `${key.pk}\u0000${key.sk}`;

/** The aggregate item without the stamp: what "changed" compares. */
function withoutStamp(item: AggregateItem | RankingBodyValue): string {
  return canonical({ ...item, run_day: undefined });
}

export class ExistingAggregates {
  readonly #aggregates: ReadonlyMap<string, Found<AggregateItem>>;
  readonly #rankings: ReadonlyMap<string, Found<RankingBodyValue>>;

  /** Built by `scanForRebuild` only. */
  public constructor(aggregates: ReadonlyMap<string, Found<AggregateItem>>, rankings: ReadonlyMap<string, Found<RankingBodyValue>>) {
    this.#aggregates = aggregates;
    this.#rankings = rankings;
  }

  public static empty(): ExistingAggregates {
    return new ExistingAggregates(new Map(), new Map());
  }

  /** How many aggregate items the Scan found (a number for the log, nothing else). */
  public get aggregateCount(): number {
    return this.#aggregates.size;
  }

  public get rankingCount(): number {
    return this.#rankings.size;
  }

  /**
   * What to write so the table holds exactly `next`, stamped `runDay`:
   * - an aggregate that is new, differs in any number, or whose stored item does not
   *   decode is put; an unchanged one is put only to refresh a stamp that is 2 or more
   *   days behind (or ahead of) the run day; otherwise nothing is written;
   * - a ranking item (keyed by the run day) is put when its key is new or its list
   *   differs, so a second run on the same day with the same input writes nothing;
   * - every stored aggregate or ranking key that `next` no longer contains is deleted
   *   (yesterday's rankings, a bean that lost its raters).
   */
  public plan(next: { readonly aggregates: readonly AggregateItem[]; readonly rankings: readonly RankingItem[] }, runDay: string): WritePlan {
    const puts: PutItem[] = [];
    const wanted = new Set<string>();
    let unchangedAggregates = 0;
    let unchangedRankings = 0;

    for (const item of next.aggregates) {
      if (item.run_day !== runDay) throw new InvalidValuesError('an aggregate item is not stamped with the run day');
      const body = parseAggregateBody(item);
      if (body === undefined) throw new InvalidValuesError('an aggregate item does not match its schema');
      const key = item.kind === 'all' ? aggregateAllKey(item.bean_id) : aggregateMethodKey(item.bean_id, requireMethod(item));
      const text = keyText(key);
      if (wanted.has(text)) throw new InvalidValuesError('the same aggregate item twice');
      wanted.add(text);
      const old = this.#aggregates.get(text)?.body;
      const unchanged = old !== undefined && withoutStamp(old) === withoutStamp(body);
      // A stamp ahead of the run day (clock skew around midnight) is rewritten too: a reader refuses it.
      const stale = old !== undefined && (needsStampRefresh(old.run_day, runDay) || ageInDays(old.run_day, runDay) < 0);
      if (unchanged && !stale) {
        unchangedAggregates += 1;
        continue;
      }
      puts.push({ ...key, type: AGGREGATE_ITEM_TYPE, ...body });
    }

    for (const item of next.rankings) {
      if (item.run_day !== runDay) throw new InvalidValuesError('a ranking item is not stamped with the run day');
      const body = RankingBody.safeParse({ bean_ids: item.bean_ids, run_day: item.run_day });
      if (!body.success) throw new InvalidValuesError('a ranking item does not match its schema');
      const key = rankingKey(item.facet, runDay);
      const text = keyText(key);
      if (wanted.has(text)) throw new InvalidValuesError('the same ranking item twice');
      wanted.add(text);
      const old = this.#rankings.get(text)?.body;
      if (old !== undefined && canonical(old) === canonical(body.data)) {
        unchangedRankings += 1;
        continue;
      }
      puts.push({ ...key, type: RANKING_ITEM_TYPE, ...body.data });
    }

    const deletes: Key[] = [];
    for (const [text, found] of [...this.#aggregates, ...this.#rankings]) {
      if (!wanted.has(text)) deletes.push(found.key);
    }
    return { puts, deletes, unchangedAggregates, unchangedRankings };
  }
}

function requireMethod(item: AggregateItem): NonNullable<AggregateItem['method']> {
  if (item.method === undefined) throw new InvalidValuesError('a method aggregate has no method');
  return item.method;
}

