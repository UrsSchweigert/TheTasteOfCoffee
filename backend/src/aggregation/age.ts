// Age of a stamped aggregate item in whole UTC days (ADR 0035 points 7a and 8).
import { MAX_AGE_DAYS, REFRESH_AFTER_DAYS } from './config.ts';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const match = ISO_DAY.exec(day);
  if (!match) throw new RangeError('not an ISO date YYYY-MM-DD');
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (new Date(ms).toISOString().slice(0, 10) !== day) throw new RangeError('not a real calendar day');
  return ms / DAY_MS;
}

/** The UTC day of an instant as `YYYY-MM-DD`. */
export function utcDay(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
}

/** Whole UTC days from `stampDay` to `readDay` (negative if the stamp is in the future). */
export function ageInDays(stampDay: string, readDay: string): number {
  return dayNumber(readDay) - dayNumber(stampDay);
}

/** True when the item may still be served: age at most `MAX_AGE_DAYS`. A stamp from the future is not served. */
export function isServable(stampDay: string, readDay: string): boolean {
  const age = ageInDays(stampDay, readDay);
  return age >= 0 && age <= MAX_AGE_DAYS;
}

/** True when an unchanged item must be rewritten to refresh its stamp: 2 or more days behind the run day. */
export function needsStampRefresh(stampDay: string, runDay: string): boolean {
  return ageInDays(stampDay, runDay) >= REFRESH_AFTER_DAYS;
}
