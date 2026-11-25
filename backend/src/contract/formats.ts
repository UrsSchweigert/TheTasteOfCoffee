// Checks the generated contract schemas need beyond what zod offers directly.
// They follow JSON Schema 2020-12 semantics, which is what contracts/openapi.yaml
// is written in (and what ajv checks in contracts/), so that the backend accepts
// exactly what the contract accepts.

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

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
 * RFC 3339 `date-time` (JSON Schema `format: date-time`). Seconds and an
 * offset are required; fractions of a second are optional. Second 60 (a leap
 * second) is accepted only at 23:59 UTC, as ajv-formats does.
 */
export function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zulu, sign, offsetHour, offsetMinute] = match;
  if (!isCalendarDay(Number(year), Number(month), Number(day))) return false;
  const hr = Number(hour);
  const min = Number(minute);
  const sec = Number(second);
  const offHr = zulu === undefined ? Number(offsetHour) : 0;
  const offMin = zulu === undefined ? Number(offsetMinute) : 0;
  if (offHr > 23 || offMin > 59) return false;
  if (hr <= 23 && min <= 59 && sec <= 59) return true;
  if (sec !== 60) return false;
  // Leap second: the UTC time must be 23:59.
  const direction = sign === '-' ? -1 : 1;
  const utcMin = min - direction * offMin;
  const utcHr = hr - direction * offHr - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1);
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
