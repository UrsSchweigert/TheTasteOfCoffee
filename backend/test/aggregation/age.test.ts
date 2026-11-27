import { describe, expect, it } from 'vitest';
import { ageInDays, isServable, needsStampRefresh, utcDay } from '../../src/aggregation/age.ts';

describe('age of a stamped item (ADR 0035 points 7a and 8)', () => {
  it('last success on day D: D+3 is still served, D+4 is not available', () => {
    expect(isServable('2026-11-24', '2026-11-24')).toBe(true);
    expect(isServable('2026-11-24', '2026-11-27')).toBe(true);
    expect(isServable('2026-11-24', '2026-11-28')).toBe(false);
  });

  it('counts calendar days across months, years and leap days', () => {
    expect(ageInDays('2026-11-30', '2026-12-03')).toBe(3);
    expect(ageInDays('2026-12-31', '2027-01-01')).toBe(1);
    expect(ageInDays('2028-02-28', '2028-03-01')).toBe(2);
    expect(isServable('2026-12-30', '2027-01-02')).toBe(true);
    expect(isServable('2026-12-30', '2027-01-03')).toBe(false);
  });

  it('does not serve a stamp from the future', () => {
    expect(isServable('2026-11-28', '2026-11-27')).toBe(false);
  });

  it('refreshes an unchanged stamp once it is 2 or more days behind the run day', () => {
    expect(needsStampRefresh('2026-11-26', '2026-11-27')).toBe(false);
    expect(needsStampRefresh('2026-11-25', '2026-11-27')).toBe(true);
    expect(needsStampRefresh('2026-11-20', '2026-11-27')).toBe(true);
  });

  it('a refreshed stamp never reaches the limit while runs succeed', () => {
    let stamp = '2026-11-01';
    for (let day = 1; day <= 30; day += 1) {
      const runDay = utcDay(Date.UTC(2026, 10, day));
      if (needsStampRefresh(stamp, runDay)) stamp = runDay;
      expect(isServable(stamp, runDay)).toBe(true);
      expect(ageInDays(stamp, runDay)).toBeLessThan(2);
    }
  });

  it('utcDay is the UTC calendar day of an instant', () => {
    expect(utcDay(Date.UTC(2026, 10, 27, 23, 59, 59, 999))).toBe('2026-11-27');
    expect(utcDay(Date.UTC(2026, 10, 28, 0, 0, 0, 0))).toBe('2026-11-28');
  });

  it.each(['2026-13-01', '2026-02-30', '2026-1-1', 'today', ''])('rejects %j', (day) => {
    expect(() => ageInDays(day, '2026-11-27')).toThrow(RangeError);
  });
});
