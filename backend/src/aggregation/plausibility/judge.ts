// Pure plausibility judge (ADR 0035 point 4, M3-T4). No I/O, no clock: the run
// time is a parameter. A brew gets the reason of the first rule that rejects
// it, or `counted`. Each rule sees only the brews that passed the rules before
// it, so a rejected brew takes no place in a burst window, a bag's running dose,
// a straight-lining history or the daily cap. Rejected brews are only left out
// of the numbers: nothing here reads or changes stored items.
import { utcDay } from '../age.ts';
import { RULES, type Judged } from './rules.ts';
import { PlausibilityInputError, type BrewVerdict, type PlausibilityBrew, type PlausibilityShelfEntry } from './types.ts';

const SEPARATOR = '\u0000';

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Canonical order: oldest first, ties by brew id, then user id. Independent of the input order. */
function compareCanonical(a: Judged, b: Judged): number {
  return a.brew.brewedAtMs - b.brew.brewedAtMs || compareText(a.brew.brewId, b.brew.brewId) || compareText(a.brew.userId, b.brew.userId);
}

/**
 * The verdict of every brew, sorted by user id then brew id (so the output does
 * not depend on the input order). Throws `PlausibilityInputError` for a brew
 * whose shelf entry is missing or a repeated (user, brew) pair: the run fails
 * closed instead of guessing.
 */
export function judgeBrews(
  brews: readonly PlausibilityBrew[],
  shelfEntries: readonly PlausibilityShelfEntry[],
  consentByUser: ReadonlyMap<string, boolean>,
  runTimeMs: number,
): readonly BrewVerdict[] {
  const entries = new Map<string, PlausibilityShelfEntry>();
  for (const entry of shelfEntries) {
    const key = entry.userId + SEPARATOR + entry.shelfEntryId;
    if (entries.has(key)) throw new PlausibilityInputError('a shelf entry appears twice');
    entries.set(key, entry);
  }

  const seen = new Set<string>();
  const all: Judged[] = brews.map((brew) => {
    const key = brew.userId + SEPARATOR + brew.brewId;
    if (seen.has(key)) throw new PlausibilityInputError('a brew appears twice');
    seen.add(key);
    const entry = entries.get(brew.userId + SEPARATOR + brew.shelfEntryId);
    if (!entry) throw new PlausibilityInputError('a brew has no shelf entry');
    return { brew, entry, day: utcDay(brew.brewedAtMs) };
  });
  all.sort(compareCanonical);

  const verdicts = new Map<Judged, BrewVerdict['verdict']>();
  let live: readonly Judged[] = all;
  for (const rule of RULES) {
    const rejected = rule.rejects(live, { consentByUser, runTimeMs });
    for (const item of rejected) verdicts.set(item, rule.reason);
    live = live.filter((item) => !rejected.has(item));
  }

  return all
    .map((item): BrewVerdict => ({ userId: item.brew.userId, brewId: item.brew.brewId, verdict: verdicts.get(item) ?? 'counted' }))
    .sort((a, b) => compareText(a.userId, b.userId) || compareText(a.brewId, b.brewId));
}
