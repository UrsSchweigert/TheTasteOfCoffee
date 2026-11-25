// The repository without a database: a stub client returns crafted items, to show
// that reads refuse items outside the caller's partition or outside the contract,
// and that bad input is refused before any request is sent.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { UserId } from '../../src/auth/user-id.ts';
import { BrewInputSchema } from '../../src/generated/contract.ts';
import {
  CorruptItemError,
  InvalidCursorError,
  InvalidKeyError,
  InvalidValuesError,
  Repository,
  brewSortKey,
  userPk,
} from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { validBrewInput } from '../fixtures.ts';

const ALICE = verifiedUserId('3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718');
const BOB = verifiedUserId('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
const ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DE';

/** A client that answers every command with `reply` and records what was sent. */
function stub(reply: (input: Record<string, unknown>) => unknown): { repo: Repository; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      sent.push(command.input);
      return Promise.resolve(reply(command.input));
    },
  } as unknown as DynamoDBDocumentClient;
  return { repo: new Repository({ client, tableName: 'cupmark-test-main' }), sent };
}

const shelfValues = { vocabulary_version: 1, bean_id: ID, purchase_date: '2026-11-20' };

describe('Repository reads', () => {
  it('derive the key from the UserId', async () => {
    const { repo, sent } = stub(() => ({}));
    await repo.getShelfEntry(ALICE, ID);
    expect(sent[0]?.Key).toEqual({ pk: userPk(ALICE), sk: `SHELF#${ID}` });
    expect(sent[0]?.ConsistentRead).toBe(true);
  });

  it('refuse an item from another partition', async () => {
    const { repo } = stub(() => ({ Item: { pk: userPk(BOB), sk: `SHELF#${ID}`, shelfEntryId: ID, values: shelfValues } }));
    await expect(repo.getShelfEntry(ALICE, ID)).rejects.toThrow(CorruptItemError);
  });

  it('refuse a listed item from another partition', async () => {
    const { repo } = stub(() => ({ Items: [{ pk: userPk(BOB), sk: `SHELF#${ID}`, shelfEntryId: ID, values: shelfValues }] }));
    await expect(repo.listShelfEntries(ALICE)).rejects.toThrow(CorruptItemError);
  });

  it('refuse an item whose values break the contract', async () => {
    const { repo } = stub(() => ({
      Item: { pk: userPk(ALICE), sk: `SHELF#${ID}`, shelfEntryId: ID, values: { ...shelfValues, note: 'free text' } },
    }));
    await expect(repo.getShelfEntry(ALICE, ID)).rejects.toThrow(CorruptItemError);
  });

  it('refuse a brew pointer that names another brew', async () => {
    const other = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
    const { repo } = stub(() => ({
      Item: { pk: userPk(ALICE), sk: `BREWID#${ID}`, brewId: ID, brewSk: brewSortKey('2026-11-25T07:00:00Z', other), createdAt: 'x' },
    }));
    await expect(repo.getBrew(ALICE, ID)).rejects.toThrow(CorruptItemError);
  });

  it('build the next page only inside the caller partition', async () => {
    const { repo, sent } = stub(() => ({ Items: [] }));
    const cursor = Buffer.from(`SHELF#${ID}`).toString('base64url');
    await repo.listShelfEntries(BOB, { cursor });
    expect(sent[0]?.ExclusiveStartKey).toEqual({ pk: userPk(BOB), sk: `SHELF#${ID}` });
    expect(sent[0]?.ExpressionAttributeValues).toEqual({ ':pk': userPk(BOB), ':prefix': 'SHELF#' });
  });
});

describe('getBrew under a concurrent move', () => {
  const brew = BrewInputSchema.parse(validBrewInput());
  const oldSk = brewSortKey('2026-11-25T07:00:00Z', ID);
  const newSk = brewSortKey('2026-11-26T07:00:00Z', ID);
  const ref = (sk: string) => ({ Item: { pk: userPk(ALICE), sk: `BREWID#${ID}`, brewId: ID, brewSk: sk, createdAt: 'x' } });

  /** Answers each GetItem from a script, in order. */
  function scripted(replies: unknown[]): { repo: Repository; sent: Record<string, unknown>[] } {
    let i = 0;
    return stub(() => replies[i++] ?? {});
  }

  it('follows the pointer again when the brew moved between the two reads', async () => {
    const moved = { Item: { pk: userPk(ALICE), sk: newSk, brewId: ID, values: brew } };
    const { repo, sent } = scripted([ref(oldSk), {}, ref(newSk), moved]);
    expect(await repo.getBrew(ALICE, ID)).toEqual({ brew_id: ID, values: brew });
    expect(sent.map((input) => (input.Key as { sk: string }).sk)).toEqual([`BREWID#${ID}`, oldSk, `BREWID#${ID}`, newSk]);
  });

  it('is not found when the brew was deleted between the two reads', async () => {
    const { repo, sent } = scripted([ref(oldSk), {}, {}]);
    expect(await repo.getBrew(ALICE, ID)).toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it('is not found when the pointer still names the empty key', async () => {
    const { repo, sent } = scripted([ref(oldSk), {}, ref(oldSk)]);
    expect(await repo.getBrew(ALICE, ID)).toBeUndefined();
    expect(sent).toHaveLength(3);
  });
});

describe('Repository input checks happen before any request', () => {
  it.each([
    ['a raw string user', () => stub(() => ({})).repo.getProfile('3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718' as unknown as UserId), InvalidKeyError],
    ['an injected id', () => stub(() => ({})).repo.getRecipe(ALICE, `${ID}#x`), InvalidKeyError],
    ['an unknown property', () => stub(() => ({})).repo.createShelfEntry(ALICE, { ...shelfValues, note: 'x' } as never), InvalidValuesError],
    ['a bad cursor', () => stub(() => ({})).repo.listBrews(ALICE, { cursor: Buffer.from('PROFILE').toString('base64url') }), InvalidCursorError],
    ['limit 0', () => stub(() => ({})).repo.listRecipes(ALICE, { limit: 0 }), InvalidValuesError],
  ])('%s', async (_name, call, error) => {
    await expect(call()).rejects.toThrow(error);
  });

  it('sends nothing for a refused write', async () => {
    const { repo, sent } = stub(() => ({}));
    const brew = BrewInputSchema.parse(validBrewInput());
    await expect(repo.createBrew(ALICE, { ...brew, brewed_at: '2026-11-25' })).rejects.toThrow(InvalidValuesError);
    await expect(repo.createBean({ vocabularyVersion: 1, barcode: '12#4', openFoodFactsMatch: false, pickedAttributes: {} })).rejects.toThrow(
      InvalidValuesError,
    );
    await expect(
      repo.createBean({ vocabularyVersion: 1, barcode: '0012345678901', openFoodFactsMatch: false, pickedAttributes: {} }),
    ).rejects.toThrow(InvalidValuesError);
    expect(sent).toEqual([]);
  });

  it('needs a table name', () => {
    expect(() => new Repository({ client: {} as unknown as DynamoDBDocumentClient, tableName: '' })).toThrow(InvalidValuesError);
  });
});
