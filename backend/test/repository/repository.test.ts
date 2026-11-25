// The repository without a database: a stub client returns crafted items, to show
// that reads refuse items outside the caller's partition or outside the contract,
// and that bad input is refused before any request is sent.
import { ConditionalCheckFailedException, TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { UserId } from '../../src/auth/user-id.ts';
import { BrewInputSchema } from '../../src/generated/contract.ts';
import type { BrewInput } from '../../src/generated/contract.ts';
import {
  BeanNotFoundError,
  CorruptItemError,
  InvalidCursorError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  Repository,
  ShelfEntryInUseError,
  ShelfEntryNotFoundError,
  WriteConflictError,
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
    const moved = { Item: { pk: userPk(ALICE), sk: newSk, brewId: ID, shelfEntryId: brew.shelf_entry_id, beanId: ID, values: brew } };
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

describe('references under a race (ADR 0012)', () => {
  const shelfItem = { Item: { pk: userPk(ALICE), sk: `SHELF#${ID}`, shelfEntryId: ID, beanId: ID, values: shelfValues } };
  const cancelled = (failedIndex: number, count: number): TransactionCanceledException =>
    new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: Array.from({ length: count }, (_, i) => ({ Code: i === failedIndex ? 'ConditionalCheckFailed' : 'None' })),
    });

  /** Answers GetItem from `gets` in order and fails every transaction with `error`. */
  function racing(gets: unknown[], error: Error): { repo: Repository; sent: Record<string, unknown>[] } {
    let i = 0;
    return stub((input) => {
      if ('TransactItems' in input) throw error;
      return gets[i++] ?? {};
    });
  }

  const brew = (): BrewInput => BrewInputSchema.parse({ ...validBrewInput(), shelf_entry_id: ID });

  it('a brew whose shelf entry was deleted during the write is ShelfEntryNotFoundError', async () => {
    const { repo } = racing([shelfItem, {}], cancelled(2, 3));
    await expect(repo.createBrew(ALICE, brew())).rejects.toThrow(ShelfEntryNotFoundError);
  });

  it('a brew whose shelf entry changed its bean during the write is WriteConflictError', async () => {
    const { repo } = racing([shelfItem, shelfItem], cancelled(2, 3));
    await expect(repo.createBrew(ALICE, brew())).rejects.toThrow(WriteConflictError);
  });

  it('the count update is in the same transaction as the brew and conditional on the bean read', async () => {
    const { repo, sent } = racing([shelfItem], cancelled(0, 3));
    await expect(repo.createBrew(ALICE, brew())).rejects.toThrow(ItemExistsError);
    const items = (sent.find((input) => 'TransactItems' in input)?.TransactItems ?? []) as Record<string, Record<string, unknown>>[];
    expect(items[2]?.Update).toMatchObject({
      Key: { pk: userPk(ALICE), sk: `SHELF#${ID}` },
      UpdateExpression: 'ADD brewCount :by',
      ConditionExpression: 'attribute_exists(pk) AND beanId = :bean',
      ExpressionAttributeValues: { ':bean': ID, ':by': 1 },
    });
  });

  it('a shelf entry for a missing bean is BeanNotFoundError; on replace a missing entry wins', async () => {
    const values = { ...shelfValues, bean_id: ID };
    await expect(racing([], cancelled(0, 2)).repo.createShelfEntry(ALICE, values)).rejects.toThrow(BeanNotFoundError);
    await expect(racing([], cancelled(0, 2)).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(BeanNotFoundError);
    await expect(racing([], cancelled(1, 2)).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(ItemNotFoundError);
  });

  it('a failed shelf delete is 404 if the entry is gone and in use if it is there', async () => {
    const condition = new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
    const gone = stub((input) => {
      if (!('ConditionExpression' in input)) return {};
      throw condition;
    });
    await expect(gone.repo.deleteShelfEntry(ALICE, ID)).rejects.toThrow(ItemNotFoundError);
    const there = stub((input) => {
      if (!('ConditionExpression' in input)) return shelfItem;
      throw condition;
    });
    await expect(there.repo.deleteShelfEntry(ALICE, ID)).rejects.toThrow(ShelfEntryInUseError);
  });
});

describe('concurrent transactions on a hot shelf entry (ADR 0012)', () => {
  const shelfItem = { Item: { pk: userPk(ALICE), sk: `SHELF#${ID}`, shelfEntryId: ID, beanId: ID, values: shelfValues } };
  const brewSk = brewSortKey('2026-11-25T07:00:00Z', ID);
  const refItem = { Item: { pk: userPk(ALICE), sk: `BREWID#${ID}`, brewId: ID, brewSk, createdAt: 'x' } };
  const brewValues = BrewInputSchema.parse({ ...validBrewInput(), shelf_entry_id: ID, brewed_at: '2026-11-25T07:00:00Z' });
  const brewItem = { Item: { pk: userPk(ALICE), sk: brewSk, brewId: ID, shelfEntryId: ID, beanId: ID, values: brewValues } };

  const cancelledWith = (codes: string[]): TransactionCanceledException =>
    new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });

  /** GetItem answers from `gets` in order; every transaction fails with `error`. */
  function racing(gets: unknown[], error: Error): Repository {
    let i = 0;
    return stub((input) => {
      if ('TransactItems' in input) throw error;
      return gets[i++] ?? {};
    }).repo;
  }

  const conflict = (count: number, at: number): TransactionCanceledException =>
    cancelledWith(Array.from({ length: count }, (_, i) => (i === at ? 'TransactionConflict' : 'None')));

  it('a brew create cancelled by TransactionConflict is WriteConflictError (retryable), not a 500', async () => {
    await expect(racing([shelfItem], conflict(3, 2)).createBrew(ALICE, brewValues)).rejects.toThrow(WriteConflictError);
  });

  it('a brew replace and delete cancelled by TransactionConflict are WriteConflictError', async () => {
    await expect(racing([refItem, brewItem, shelfItem], conflict(3, 2)).replaceBrew(ALICE, ID, brewValues)).rejects.toThrow(
      WriteConflictError,
    );
    await expect(racing([refItem, brewItem], conflict(3, 2)).deleteBrew(ALICE, ID)).rejects.toThrow(WriteConflictError);
  });

  it('shelf create and replace cancelled by TransactionConflict are WriteConflictError', async () => {
    await expect(racing([], conflict(2, 1)).createShelfEntry(ALICE, shelfValues)).rejects.toThrow(WriteConflictError);
    await expect(racing([], conflict(2, 1)).replaceShelfEntry(ALICE, ID, shelfValues)).rejects.toThrow(WriteConflictError);
  });

  it('a failed condition still wins over a conflict in the same cancellation', async () => {
    const mixed = cancelledWith(['ConditionalCheckFailed', 'TransactionConflict']);
    await expect(racing([], mixed).createShelfEntry(ALICE, shelfValues)).rejects.toThrow(BeanNotFoundError);
  });

  it('a cancellation for another reason is not turned into a retry', async () => {
    const other = cancelledWith(['None', 'ValidationError']);
    const error = await racing([], other).createShelfEntry(ALICE, shelfValues).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionCanceledException);
  });

  it('a shelf delete that meets a counting transaction is WriteConflictError', async () => {
    const { repo } = stub(() => {
      throw new TransactionConflictException({ message: 'conflict', $metadata: {} });
    });
    await expect(repo.deleteShelfEntry(ALICE, ID)).rejects.toThrow(WriteConflictError);
  });
});
