// Builders for rebuild tests: decoded items as the repository will hand them over.
import type { Bean, BrewParameters, Method, PriceBand, Rating, Scores } from '../../src/generated/contract.ts';
import type { RebuildBrew, RebuildInput, RebuildShelfEntry } from '../../src/aggregation/rebuild/types.ts';

export const RUN = Date.UTC(2026, 10, 27, 12, 0, 0);
export const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
export const MIN = 60_000;
export const DAY = 86_400_000;

/** Eight scores in points, in criterion order: aroma, flavour, aftertaste, acidity, body, sweetness, balance, overall. */
export function scores(...v: number[]): Scores {
  const [aroma = 7, flavour = 7, aftertaste = 7, acidity = 7, body = 7, sweetness = 7, balance = 7, overall = 7] = v;
  return { aroma, flavour, aftertaste, acidity, body, sweetness, balance, overall };
}

/** A scored brew pattern that is not straight-lining: the overall score is the argument, the others differ from it. */
export const rated = (overall: number): Rating => ({ scores: scores(overall - 1, overall, overall, overall - 0.5, overall, overall, overall, overall) });

export interface BrewOptions {
  readonly user?: string;
  readonly id: string;
  readonly entry?: string;
  readonly at: number;
  readonly method?: Method;
  readonly parameters?: Partial<BrewParameters> | undefined;
  readonly rating?: Rating | null;
}

export function brew(o: BrewOptions): RebuildBrew {
  const rating = o.rating === undefined ? rated(8) : (o.rating ?? undefined);
  return {
    userId: o.user ?? 'u1',
    brew: {
      brew_id: o.id,
      values: {
        vocabulary_version: 3,
        shelf_entry_id: o.entry ?? 'e1',
        brewed_at: new Date(o.at).toISOString(),
        parameters: { method: o.method ?? 'v60', ...o.parameters },
        ...(rating ? { rating } : {}),
      },
    },
  };
}

export interface EntryOptions {
  readonly user?: string;
  readonly id?: string;
  readonly bean?: string;
  readonly roastDate?: string;
  readonly bagSize?: 'g_250' | 'g_500' | 'g_1000';
  readonly priceBand?: PriceBand;
  readonly version?: 1 | 2 | 3;
}

export function entry(o: EntryOptions = {}): RebuildShelfEntry {
  return {
    userId: o.user ?? 'u1',
    entry: {
      shelf_entry_id: o.id ?? 'e1',
      values: {
        vocabulary_version: o.version ?? 3,
        bean_id: o.bean ?? 'bean1',
        purchase_date: '2026-11-01',
        ...(o.roastDate ? { roast_date: o.roastDate } : {}),
        ...(o.bagSize ? { bag_size: o.bagSize } : {}),
        ...(o.priceBand ? { price_band: o.priceBand } : {}),
      },
    },
  };
}

export function bean(id: string, over: Partial<Bean> = {}): Bean {
  return {
    bean_id: id,
    vocabulary_version: 3,
    verified: false,
    open_food_facts_match: false,
    picked_attributes: {},
    operator_attributes: {},
    ...over,
  };
}

export function input(parts: Partial<RebuildInput> & { consent?: readonly string[] }): RebuildInput {
  const users = new Set([...(parts.brews ?? []).map((b) => b.userId), ...(parts.shelfEntries ?? []).map((e) => e.userId)]);
  return {
    brews: parts.brews ?? [],
    shelfEntries: parts.shelfEntries ?? [],
    beans: parts.beans ?? [],
    consentByUser: parts.consentByUser ?? new Map((parts.consent ?? [...users]).map((u) => [u, true])),
    runTimeMs: parts.runTimeMs ?? RUN,
  };
}

/** `n` users u1..un, each with one shelf entry on `bean` and `perUser` rated brews 10 minutes apart on day `dayOffset`. */
export function crowd(users: number, o: { bean?: string; perUser?: number; dayOffset?: number; overall?: (u: number, i: number) => number; method?: Method; extra?: (u: number, i: number) => Partial<BrewOptions> } = {}): { brews: RebuildBrew[]; shelfEntries: RebuildShelfEntry[] } {
  const brews: RebuildBrew[] = [];
  const shelfEntries: RebuildShelfEntry[] = [];
  for (let u = 1; u <= users; u += 1) {
    const user = `u${String(u)}`;
    shelfEntries.push(entry({ user, bean: o.bean ?? 'bean1' }));
    for (let i = 0; i < (o.perUser ?? 1); i += 1) {
      brews.push(brew({ user, id: `${user}b${String(i)}`, at: T0 + (o.dayOffset ?? 0) * DAY + i * 10 * MIN, method: o.method ?? 'v60', rating: rated(o.overall?.(u, i) ?? 8), ...o.extra?.(u, i) }));
    }
  }
  return { brews, shelfEntries };
}
