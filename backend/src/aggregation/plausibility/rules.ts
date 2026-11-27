// The eight plausibility rules (ADR 0035 point 4), one object each. A rule
// receives the brews that passed every earlier rule (in canonical order:
// brewedAt, then brew id, then user id) and returns the ones it rejects. Every
// number comes from config.ts; no numeric literal other than 0 and 1 may appear
// here (a test enforces it).
import type { ReasonId } from '../../generated/aggregation.ts';
import {
  BAG_DOSE_MARGIN_PERCENT,
  BURST_COUNT,
  BURST_WINDOW_MS,
  DAILY_CAP,
  DECIGRAMS_PER_GRAM,
  FUTURE_SKEW_MS,
  PERCENT_DENOMINATOR,
  STRAIGHT_LINING_MIN_BREWS,
} from '../config.ts';
import type { PlausibilityBrew, PlausibilityShelfEntry } from './types.ts';

/** A brew with its shelf entry resolved and its UTC day computed once. */
export interface Judged {
  readonly brew: PlausibilityBrew;
  readonly entry: PlausibilityShelfEntry;
  readonly day: string;
}

export interface RuleContext {
  readonly consentByUser: ReadonlyMap<string, boolean>;
  readonly runTimeMs: number;
}

export interface Rule {
  readonly reason: ReasonId;
  /** The brews of `live` this rule rejects. `live` is in canonical order. */
  readonly rejects: (live: readonly Judged[], context: RuleContext) => ReadonlySet<Judged>;
}

function filterSet(live: readonly Judged[], reject: (item: Judged) => boolean): ReadonlySet<Judged> {
  return new Set(live.filter(reject));
}

function groupBy(live: readonly Judged[], key: (item: Judged) => string): Map<string, Judged[]> {
  const groups = new Map<string, Judged[]>();
  for (const item of live) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

const joinKey = (...parts: readonly string[]): string => parts.join('\u0000');

/** 1. No profile and `false` both mean no consent. */
const noConsent: Rule = {
  reason: 'no_consent',
  rejects: (live, { consentByUser }) => filterSet(live, ({ brew }) => consentByUser.get(brew.userId) !== true),
};

/** 2. A brew without a rating has nothing to count. */
const unrated: Rule = {
  reason: 'unrated',
  rejects: (live) => filterSet(live, ({ brew }) => brew.scores === undefined),
};

/** 3. More than the clock skew after the run time. Exactly at the skew still counts. */
const brewedInFuture: Rule = {
  reason: 'brewed_in_future',
  rejects: (live, { runTimeMs }) => filterSet(live, ({ brew }) => brew.brewedAtMs > runTimeMs + FUTURE_SKEW_MS),
};

/** 4. The brew's UTC day is earlier than the roast date (the same day counts). ISO dates compare as strings. */
const brewedBeforeRoast: Rule = {
  reason: 'brewed_before_roast',
  rejects: (live) => filterSet(live, ({ entry, day }) => entry.roastDate !== undefined && day < entry.roastDate),
};

/**
 * 5. At most BURST_COUNT brews of one user in any window of BURST_WINDOW_MS
 * (half open: a brew exactly one window after another is outside its window).
 * The earliest ones count; a rejected brew does not take a place in a window.
 */
const burst: Rule = {
  reason: 'burst',
  rejects: (live) => {
    const rejected = new Set<Judged>();
    for (const group of groupBy(live, ({ brew }) => brew.userId).values()) {
      const kept: number[] = [];
      let first = 0;
      for (const item of group) {
        const t = item.brew.brewedAtMs;
        while (first < kept.length && (kept[first] ?? t) <= t - BURST_WINDOW_MS) first += 1;
        if (kept.length - first >= BURST_COUNT) rejected.add(item);
        else kept.push(t);
      }
    }
    return rejected;
  },
};

/**
 * 6. The running dose of a shelf entry, oldest first, may not exceed bag size x
 * margin. A brew that would pass the limit is rejected and adds nothing, so the
 * accepted doses never exceed it. No bag size, or no dose on the brew: not judged.
 */
const bagDoseExceeded: Rule = {
  reason: 'bag_dose_exceeded',
  rejects: (live) => {
    const rejected = new Set<Judged>();
    for (const group of groupBy(live, ({ brew }) => joinKey(brew.userId, brew.shelfEntryId)).values()) {
      let running = 0;
      for (const item of group) {
        const { bagGrams } = item.entry;
        const { doseDg } = item.brew;
        if (bagGrams === undefined || doseDg === undefined) continue;
        const limit = bagGrams * DECIGRAMS_PER_GRAM * BAG_DOSE_MARGIN_PERCENT;
        if ((running + doseDg) * PERCENT_DENOMINATOR > limit) rejected.add(item);
        else running += doseDg;
      }
    }
    return rejected;
  },
};

/** 7. A user with at least STRAIGHT_LINING_MIN_BREWS brews left whose scores are all one and the same value: all of them. */
const straightLining: Rule = {
  reason: 'straight_lining',
  rejects: (live) => {
    const rejected = new Set<Judged>();
    for (const group of groupBy(live, ({ brew }) => brew.userId).values()) {
      if (group.length < STRAIGHT_LINING_MIN_BREWS) continue;
      const values = group.flatMap(({ brew }) => (brew.scores ? Object.values(brew.scores) : []));
      const [reference] = values;
      if (values.every((value) => value === reference)) for (const item of group) rejected.add(item);
    }
    return rejected;
  },
};

/** 8. The first DAILY_CAP cups of a user, bean and UTC day (by brewedAt, then brew id) count. This runs before n is computed. */
const dailyCapExceeded: Rule = {
  reason: 'daily_cap_exceeded',
  rejects: (live) => {
    const rejected = new Set<Judged>();
    for (const group of groupBy(live, ({ brew, entry, day }) => joinKey(brew.userId, entry.beanId, day)).values()) {
      for (const item of group.slice(DAILY_CAP)) rejected.add(item);
    }
    return rejected;
  },
};

/** The rules in the fixed order of ADR 0035 point 4. */
export const RULES: readonly Rule[] = [
  noConsent,
  unrated,
  brewedInFuture,
  brewedBeforeRoast,
  burst,
  bagDoseExceeded,
  straightLining,
  dailyCapExceeded,
];
