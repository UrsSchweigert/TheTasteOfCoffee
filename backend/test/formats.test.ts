import { describe, expect, it } from 'vitest';
import { codePointLength, hasUniqueItems, isDateTime, isFullDate, isPresent } from '../src/contract/formats.ts';

describe('isFullDate', () => {
  it.each(['2026-11-25', '2028-02-29', '2000-02-29', '2026-12-31', '0001-01-01'])('accepts %s', (value) => {
    expect(isFullDate(value)).toBe(true);
  });
  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    '20261125',
    '2026-11-25 ',
    '2026-11-25\n',
    '+02026-11-25',
    '２０２６-11-25',
  ])('rejects %j', (value) => {
    expect(isFullDate(value)).toBe(false);
  });
});

describe('isDateTime', () => {
  it.each([
    '2026-11-25T07:30:00Z',
    '2026-11-25t07:30:00z',
    '2026-11-25T07:30:00.123Z',
    '2026-11-25T07:30:00+01:00',
    '2026-11-25T07:30:00-23:59',
    '2016-12-31T23:59:60Z',
    '2017-01-01T00:59:60+01:00',
    '2016-12-31T18:59:60-05:00',
  ])('accepts %s', (value) => {
    expect(isDateTime(value)).toBe(true);
  });
  it.each([
    '2026-11-25T07:30:00',
    '2026-11-25T07:30Z',
    '2026-11-25 07:30:00Z',
    '2026-11-25T07:30:00+0100',
    '2026-11-25T07:30:00+01',
    '2026-11-25T24:00:00Z',
    '2026-11-25T07:60:00Z',
    '2026-11-25T07:30:61Z',
    '2026-11-25T07:30:60Z',
    '2026-11-25T07:30:00+24:00',
    '2026-11-25T07:30:00+01:60',
    '2026-02-29T07:30:00Z',
    '2026-11-25T07:30:00.Z',
    '2026-11-25',
  ])('rejects %s', (value) => {
    expect(isDateTime(value)).toBe(false);
  });
});

describe('hasUniqueItems', () => {
  it('compares structurally, ignoring key order', () => {
    expect(hasUniqueItems(['a', 'b'])).toBe(true);
    expect(hasUniqueItems(['a', 'a'])).toBe(false);
    expect(hasUniqueItems([1, '1'])).toBe(true);
    expect(hasUniqueItems([{ a: 1, b: 2 }, { b: 2, a: 1 }])).toBe(false);
    expect(hasUniqueItems([[1], [1]])).toBe(false);
    expect(hasUniqueItems([])).toBe(true);
  });
});

describe('codePointLength and isPresent', () => {
  it('counts code points', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('\u{1F600}')).toBe(1);
  });
  it('treats only own, defined keys as present', () => {
    expect(isPresent({ a: 1 }, 'a')).toBe(true);
    expect(isPresent({ a: undefined }, 'a')).toBe(false);
    expect(isPresent({}, 'toString')).toBe(false);
  });
});
