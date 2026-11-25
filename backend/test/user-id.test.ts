import { describe, expect, it } from 'vitest';
import { UserId, userIdFromEvent } from '../src/auth/user-id.ts';
import { event, PLANTED_OTHER } from './events.ts';

const SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718';

describe('userIdFromEvent', () => {
  it('returns the token subject', () => {
    expect(userIdFromEvent(event({ sub: SUB }))?.value).toBe(SUB);
  });

  it('ignores user ids in the query, path, headers and body', () => {
    expect(userIdFromEvent(event({ sub: SUB }))?.value).not.toBe(PLANTED_OTHER);
  });

  it.each([
    ['no authorizer', undefined],
    ['no sub claim', { username: SUB }],
    ['an empty sub', { sub: '' }],
    ['a non-string sub', { sub: 42 }],
    ['a list as sub', { sub: [SUB] }],
    ['an upper-case sub', { sub: SUB.toUpperCase() }],
    ['a sub with a partition key separator', { sub: `${SUB}#PROFILE` }],
    ['a sub that is not a UUID', { sub: 'apple-user.0001' }],
  ])('returns undefined for %s', (_name, claims) => {
    expect(userIdFromEvent(event(claims))).toBeUndefined();
  });
});

describe('UserId', () => {
  it('is a UserId only when made by userIdFromEvent', () => {
    expect(UserId.is(userIdFromEvent(event({ sub: SUB })))).toBe(true);
  });

  it.each([
    ['a raw string', SUB],
    ['a look-alike object', { value: SUB }],
    ['undefined', undefined],
    ['null', null],
  ])('is not a UserId: %s', (_name, value) => {
    expect(UserId.is(value)).toBe(false);
  });

  it('cannot be constructed outside its module, even reflectively', () => {
    const Forge = UserId as unknown as new (token: unknown, sub: string) => UserId;
    expect(() => new Forge(undefined, SUB)).toThrow(TypeError);
    expect(() => new Forge(Symbol('UserId'), SUB)).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error the constructor is private, and its token is not exported
      const forged: unknown = new UserId(Symbol('UserId'), SUB);
      return forged;
    }).toThrow(TypeError);
  });

  it('cannot be forged at the type level', () => {
    // @ts-expect-error a string is not a UserId
    const fromString: UserId = SUB;
    // @ts-expect-error an object with the same public shape is not a UserId (private field)
    const fromShape: UserId = { value: SUB }; // eslint-disable-line @typescript-eslint/no-unsafe-class-instance-assignment -- deliberate forgery attempt
    expect([fromString, fromShape].some((v) => UserId.is(v))).toBe(false);
  });
});
