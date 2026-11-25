import { describe, expect, it } from 'vitest';
import { IdSchema } from '../../src/generated/contract.ts';
import { newUlid } from '../../src/ids/ulid.ts';
import { InvalidCursorError, decodeCursor, encodeCursor, parseShelfSortKey } from '../../src/repository/index.ts';
import { CursorSchema } from '../../src/generated/contract.ts';

const ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DE';
const isShelf = (sk: string): boolean => parseShelfSortKey(sk) !== undefined;

describe('cursor', () => {
  it('round-trips a sort key and is a contract Cursor', () => {
    const cursor = encodeCursor(`SHELF#${ID}`);
    expect(CursorSchema.safeParse(cursor).success).toBe(true);
    expect(decodeCursor(cursor, isShelf)).toBe(`SHELF#${ID}`);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a+b/c='],
    ['a sort key of another list', encodeCursor(`RECIPE#${ID}`)],
    ['another partition key', encodeCursor('USER#0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')],
    ['a sort key with a suffix', encodeCursor(`SHELF#${ID}#x`)],
    ['a non-canonical encoding', `${encodeCursor(`SHELF#${ID}`)}A`],
    ['too long', 'A'.repeat(513)],
  ])('rejects %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor, isShelf)).toThrow(InvalidCursorError);
  });
});

describe('newUlid', () => {
  it('makes contract ids that sort by time', () => {
    const a = newUlid(1_764_000_000_000);
    const b = newUlid(1_764_000_000_001);
    expect(IdSchema.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
    expect(newUlid(0).slice(0, 10)).toBe('0000000000');
    expect(newUlid(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  it('is unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newUlid(1_764_000_000_000)));
    expect(ids.size).toBe(1000);
  });

  it.each([-1, 2 ** 48, 1.5, Number.NaN])('rejects time %s', (time) => {
    expect(() => newUlid(time)).toThrow(RangeError);
  });
});
