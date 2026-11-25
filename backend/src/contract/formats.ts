// Checks the generated contract schemas need beyond what zod offers directly.
// They follow JSON Schema 2020-12 semantics, which contracts/openapi.yaml is
// written in. The date formats are never more lenient than the contract's own
// checker (contracts/lib/openapi.mjs); they are stricter only in requiring a
// day that exists in the calendar.

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The same shape as contracts/lib/openapi.mjs (compileComponentSchemas): upper-case
// T and Z only, at most 9 fraction digits, offset as +hh:mm or -hh:mm.
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isCalendarDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** RFC 3339 `full-date` (JSON Schema `format: date`): a real calendar day. */
export function isFullDate(value: string): boolean {
  const match = FULL_DATE.exec(value);
  if (!match) return false;
  return isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * RFC 3339 `date-time` (JSON Schema `format: date-time`), no more lenient than
 * the contract's own checker: seconds and an offset are required, `T` and `Z`
 * are upper case, fractions have 1 to 9 digits, and second 60 (a leap second)
 * is rejected. The day must exist in the calendar, which the contract's
 * regular expression does not check.
 */
export function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (!isCalendarDay(Number(year), Number(month), Number(day))) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  // Without an offset the time is Z; the groups are then undefined.
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

/** String length in Unicode code points, as JSON Schema counts it. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** JSON Schema `uniqueItems`: no two items are structurally equal. */
export function hasUniqueItems(items: readonly unknown[]): boolean {
  return new Set(items.map(canonical)).size === items.length;
}

/** True if the property is present (JSON Schema presence: the key exists). */
export function isPresent(value: object, key: string): boolean {
  return Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] !== undefined;
}
