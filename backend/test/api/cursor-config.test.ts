// The cursor signer and the configuration that feeds it. Every key here is
// generated in the test; no key exists in the repo.
import { randomBytes } from 'node:crypto';
import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { afterEach, describe, expect, it } from 'vitest';
import { CURSOR_KEY_FAILURE_TTL_MS, cursorSignerFromParameterStore, decodeCursorKey, isCursorKeyParameterName } from '../../src/api/config.ts';
import { CursorSigner } from '../../src/api/cursor.ts';
import { CursorSchema } from '../../src/generated/contract.ts';
import { handler } from '../../src/handlers/api.ts';
import { encodeCursor } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { ALICE_SUB, BOB_SUB, apiEvent } from './helpers.ts';

const ALICE = verifiedUserId(ALICE_SUB);
const BOB = verifiedUserId(BOB_SUB);
const INNER = encodeCursor('BREW#2026-11-25T06:30:00.250Z#01ARZ3NDEKTSV4RRFFQ69G5FAV');

describe('CursorSigner', () => {
  const signer = new CursorSigner(randomBytes(32));

  it('round-trips, and the result is a contract Cursor', () => {
    const cursor = signer.sign('brews', ALICE, INNER);
    expect(CursorSchema.safeParse(cursor).success).toBe(true);
    expect(cursor.endsWith(INNER)).toBe(true);
    expect(signer.verify('brews', ALICE, cursor)).toBe(INNER);
  });

  it('binds the list, the caller and the key', () => {
    const cursor = signer.sign('brews', ALICE, INNER);
    expect(signer.verify('shelf', ALICE, cursor)).toBeUndefined();
    expect(signer.verify('recipes', ALICE, cursor)).toBeUndefined();
    expect(signer.verify('brews', BOB, cursor)).toBeUndefined();
    expect(new CursorSigner(randomBytes(32)).verify('brews', ALICE, cursor)).toBeUndefined();
  });

  it('refuses every single-character change', () => {
    const cursor = signer.sign('brews', ALICE, INNER);
    for (let i = 0; i < cursor.length; i += 1) {
      const c = cursor.charAt(i) === 'x' ? 'y' : 'x';
      expect(signer.verify('brews', ALICE, `${cursor.slice(0, i)}${c}${cursor.slice(i + 1)}`)).toBeUndefined();
    }
    expect(signer.verify('brews', ALICE, cursor.slice(0, 43))).toBeUndefined();
    expect(signer.verify('brews', ALICE, '')).toBeUndefined();
  });

  it('needs a key of at least 32 bytes', () => {
    expect(() => new CursorSigner(randomBytes(31))).toThrow(RangeError);
    expect(() => new CursorSigner(new Uint8Array())).toThrow(RangeError);
  });
});

describe('cursor key from Parameter Store', () => {
  const key = randomBytes(32).toString('base64');

  function client(reply: () => unknown): { client: Pick<SSMClient, 'send'>; sent: unknown[] } {
    const sent: unknown[] = [];
    return {
      sent,
      client: {
        send: (command: GetParameterCommand) => {
          sent.push(command.input);
          return Promise.resolve(reply());
        },
      },
    };
  }

  it('reads the SecureString once, decrypted, and caches the signer', async () => {
    const stub = client(() => ({ Parameter: { Type: 'SecureString', Value: key } }));
    const load = cursorSignerFromParameterStore('/cupmark/dev/cursor-key', stub.client);
    const first = await load();
    expect(first).toBeInstanceOf(CursorSigner);
    expect(await load()).toBe(first);
    expect(stub.sent).toEqual([{ Name: '/cupmark/dev/cursor-key', WithDecryption: true }]);
  });

  it.each([
    ['a plain String', { Parameter: { Type: 'String', Value: key } }],
    ['no value', { Parameter: { Type: 'SecureString' } }],
    ['a short key', { Parameter: { Type: 'SecureString', Value: randomBytes(16).toString('base64') } }],
    ['not base64', { Parameter: { Type: 'SecureString', Value: 'not base64 at all, but long enough to be a key!' } }],
    ['no parameter', {}],
  ])('fails closed on %s, remembers the failure for 60 s, then asks again', async (_name, reply) => {
    const stub = client(() => reply);
    let now = 1_000_000;
    const load = cursorSignerFromParameterStore('/cupmark/dev/cursor-key', stub.client, { now: () => now });
    expect(await load()).toBeUndefined();
    for (const later of [0, 1, 30_000, CURSOR_KEY_FAILURE_TTL_MS - 1]) {
      now = 1_000_000 + later;
      expect(await load()).toBeUndefined();
    }
    expect(stub.sent).toHaveLength(1);
    now = 1_000_000 + CURSOR_KEY_FAILURE_TTL_MS;
    expect(await load()).toBeUndefined();
    expect(stub.sent).toHaveLength(2);
    // The second failure starts a new 60 s.
    now += CURSOR_KEY_FAILURE_TTL_MS - 1;
    expect(await load()).toBeUndefined();
    expect(stub.sent).toHaveLength(2);
  });

  it('recovers once the key is there, after the failure window', async () => {
    const stored: { value?: string } = {};
    const stub = client(() => ({ Parameter: { Type: 'SecureString', ...(stored.value === undefined ? {} : { Value: stored.value }) } }));
    let now = 0;
    const load = cursorSignerFromParameterStore('/cupmark/dev/cursor-key', stub.client, { now: () => now });
    expect(await load()).toBeUndefined();
    stored.value = key;
    now = CURSOR_KEY_FAILURE_TTL_MS - 1;
    expect(await load()).toBeUndefined();
    now = CURSOR_KEY_FAILURE_TTL_MS;
    expect(await load()).toBeInstanceOf(CursorSigner);
    now = 10 * CURSOR_KEY_FAILURE_TTL_MS;
    expect(await load()).toBeInstanceOf(CursorSigner);
    expect(stub.sent).toHaveLength(2);
  });

  it('concurrent calls share one read', async () => {
    const stub = client(() => ({ Parameter: { Type: 'SecureString', Value: key } }));
    const load = cursorSignerFromParameterStore('/cupmark/dev/cursor-key', stub.client);
    const signers = await Promise.all([load(), load(), load()]);
    expect(new Set(signers).size).toBe(1);
    expect(stub.sent).toHaveLength(1);
  });

  it('fails closed when the call fails', async () => {
    const load = cursorSignerFromParameterStore('/cupmark/dev/cursor-key', {
      send: () => Promise.reject(new Error('AccessDenied')),
    });
    expect(await load()).toBeUndefined();
  });

  it.each([undefined, '', 'cursor-key', '/other-project/key', '/cupmark/', '/cupmark//key', '/cupmark/a b'])(
    'never asks for parameter %j, which this project does not own or is malformed',
    async (name) => {
      const stub = client(() => ({ Parameter: { Type: 'SecureString', Value: key } }));
      expect(isCursorKeyParameterName(name)).toBe(false);
      expect(await cursorSignerFromParameterStore(name, stub.client)()).toBeUndefined();
      expect(stub.sent).toEqual([]);
    },
  );

  it('decodes strict base64 of at least 32 bytes only', () => {
    expect(decodeCursorKey(key)?.length).toBe(32);
    expect(decodeCursorKey(`${key}\n`)?.length).toBe(32);
    expect(decodeCursorKey(randomBytes(64).toString('base64'))?.length).toBe(64);
    expect(decodeCursorKey(randomBytes(31).toString('base64'))).toBeUndefined();
    expect(decodeCursorKey(randomBytes(32).toString('base64url').replace(/^./, '-'))).toBeUndefined();
    expect(decodeCursorKey('')).toBeUndefined();
  });
});

describe('the Lambda entry point', () => {
  const saved = process.env.TABLE_NAME;
  afterEach(() => {
    if (saved === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = saved;
  });

  it('answers 500 with no body when TABLE_NAME is missing', async () => {
    delete process.env.TABLE_NAME;
    const result = await handler(apiEvent('GET', '/shelf'));
    expect(result.statusCode).toBe(500);
    expect(result.body).toBeUndefined();
  });
});
