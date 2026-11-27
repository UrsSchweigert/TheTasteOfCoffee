// Pure plausibility judge (ADR 0035 point 4, M3-T4). No I/O, no clock: the run
// time is a parameter. A brew gets the reason of the first rule that rejects
// it, or `counted`. Each rule sees only the brews that passed the rules before
// it. A brew rejected by rules 1 to 5 takes no place in a later rule's window,
// dose, history or cap. A brew rejected by rule 6 (bag dose) still held a place
// in the burst window of rule 5, and a brew rejected by rule 7 or 8 still used
// the bag in rule 6. Rejected brews are only left out of the numbers: nothing
// here reads or changes stored items.
import { utcDay } from '../age.ts';
import { RULES, type Judged } from './rules.ts';
import {
  PlausibilityInputError,
  type BrewVerdict,
  type JudgeResult,
  type PlausibilityBrew,
  type PlausibilityShelfEntry,
} from './types.ts';

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
 * The verdict of every judged brew, sorted by user id then brew id (so the
 * output does not depend on the input order).
 *
 * A brew whose shelf entry is missing (an interrupted account deletion, or a
 * Scan that is not a snapshot) cannot be judged by the rules that need the
 * entry. If its user has no consent it is `no_consent`; otherwise it is left
 * out of every rule and only counted in `orphanBrews`. It is never given a
 * contract reason id. Throws `PlausibilityInputError` only for a repeated
 * (user, brew) pair or a repeated shelf entry: one Scan never returns an item
 * twice, so that is a bug and the run fails closed.
 */
export function judgeBrews(
  brews: readonly PlausibilityBrew[],
  shelfEntries: readonly PlausibilityShelfEntry[],
  consentByUser: ReadonlyMap<string, boolean>,
  runTimeMs: number,
): JudgeResult {
  const entries = new Map<string, PlausibilityShelfEntry>();
  for (const entry of shelfEntries) {
    const key = entry.userId + SEPARATOR + entry.shelfEntryId;
    if (entries.has(key)) throw new PlausibilityInputError('a shelf entry appears twice');
    entries.set(key, entry);
  }

  const seen = new Set<string>();
  const all: Judged[] = [];
  const unconsentedOrphans: BrewVerdict[] = [];
  let orphanBrews = 0;
  for (const brew of brews) {
    const key = brew.userId + SEPARATOR + brew.brewId;
    if (seen.has(key)) throw new PlausibilityInputError('a brew appears twice');
    seen.add(key);
    const entry = entries.get(brew.userId + SEPARATOR + brew.shelfEntryId);
    if (entry) all.push({ brew, entry, day: utcDay(brew.brewedAtMs) });
    else if (consentByUser.get(brew.userId) !== true) unconsentedOrphans.push({ userId: brew.userId, brewId: brew.brewId, verdict: 'no_consent' });
    else orphanBrews += 1;
  }
  all.sort(compareCanonical);

  const verdicts = new Map<Judged, BrewVerdict['verdict']>();
  let live: readonly Judged[] = all;
  for (const rule of RULES) {
    const rejected = rule.rejects(live, { consentByUser, runTimeMs });
    for (const item of rejected) verdicts.set(item, rule.reason);
    live = live.filter((item) => !rejected.has(item));
  }

  const judged = all.map((item): BrewVerdict => ({ userId: item.brew.userId, brewId: item.brew.brewId, verdict: verdicts.get(item) ?? 'counted' }));
  return {
    verdicts: [...judged, ...unconsentedOrphans].sort((a, b) => compareText(a.userId, b.userId) || compareText(a.brewId, b.brewId)),
    orphanBrews,
  };
}
