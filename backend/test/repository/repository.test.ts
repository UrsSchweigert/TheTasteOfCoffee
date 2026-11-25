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
  BeanNotUnverifiedError,
  CorruptItemError,
  InvalidCursorError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  Repository,
  ShelfEntryBeanLockedError,
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

  it('a shelf replace may change the bean only while no brew is counted, in one condition (D14)', async () => {
    const { repo, sent } = stub(() => ({}));
    const other = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DG';
    await repo.replaceShelfEntry(ALICE, ID, { ...shelfValues, bean_id: other });
    expect(sent).toHaveLength(1);
    const items = (sent[0]?.TransactItems ?? []) as Record<string, Record<string, unknown>>[];
    expect(items[1]?.Update).toMatchObject({
      Key: { pk: userPk(ALICE), sk: `SHELF#${ID}` },
      ConditionExpression: 'attribute_exists(pk) AND (beanId = :bean OR attribute_not_exists(brewCount) OR brewCount = :zero)',
      ExpressionAttributeValues: { ':bean': other, ':zero': 0 },
    });
  });

  it('a failed shelf replace condition: gone is 404, an unknown bean is 404, otherwise the bean is locked', async () => {
    const values = { ...shelfValues, bean_id: ID };
    await expect(racing([{}], cancelled(1, 2)).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(ItemNotFoundError);
    const locked = racing([shelfItem], cancelled(1, 2));
    await expect(locked.repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(ShelfEntryBeanLockedError);
    // One transaction, then one consistent read of the entry; no write after the read.
    expect(locked.sent.map((input) => ('TransactItems' in input ? 'transact' : 'get'))).toEqual(['transact', 'get']);
    expect(locked.sent[1]).toMatchObject({ Key: { pk: userPk(ALICE), sk: `SHELF#${ID}` }, ConsistentRead: true });
    const both = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }],
    });
    await expect(racing([shelfItem], both).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(BeanNotFoundError);
    await expect(racing([{}], both).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(ItemNotFoundError);
  });

  const usable = {
    Key: { pk: `BEAN#${ID}`, sk: 'META' },
    ConditionExpression: 'attribute_exists(pk) AND #status <> :rejected',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':rejected': 'rejected' },
  };

  it('a new shelf entry and a replace check, in the same transaction, that the bean exists and is not rejected (M1-T11)', async () => {
    const { repo, sent } = stub(() => ({}));
    await repo.createShelfEntry(ALICE, shelfValues);
    await repo.replaceShelfEntry(ALICE, ID, shelfValues);
    expect(sent).toHaveLength(2);
    for (const input of sent) {
      const items = (input.TransactItems ?? []) as Record<string, Record<string, unknown>>[];
      expect(items).toHaveLength(2);
      expect(items[0]?.ConditionCheck).toMatchObject(usable);
    }
  });

  /** Answers transactions from `transactions` in order (an Error is thrown) and GetItem from `gets` in order. */
  function scripted(transactions: (Error | undefined)[], gets: unknown[]): { repo: Repository; sent: Record<string, unknown>[] } {
    let t = 0;
    let g = 0;
    return stub((input) => {
      if ('TransactItems' in input) {
        const outcome = transactions[t++];
        if (outcome !== undefined) throw outcome;
        return {};
      }
      return gets[g++] ?? {};
    });
  }

  it('a replace that keeps a bean rejected later is written again, requiring the entry to still name that bean', async () => {
    const values = { ...shelfValues, bean_id: ID, price_band: 'from_80' as const };
    const { repo, sent } = scripted([cancelled(0, 2), undefined], [shelfItem]);
    await expect(repo.replaceShelfEntry(ALICE, ID, values)).resolves.toEqual({ shelf_entry_id: ID, values });
    expect(sent.map((input) => ('TransactItems' in input ? 'transact' : 'get'))).toEqual(['transact', 'get', 'transact']);
    const items = (sent[2]?.TransactItems ?? []) as Record<string, Record<string, unknown>>[];
    expect(items[0]?.ConditionCheck).toEqual({
      TableName: 'cupmark-test-main',
      Key: { pk: `BEAN#${ID}`, sk: 'META' },
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(items[1]?.Update).toMatchObject({
      Key: { pk: userPk(ALICE), sk: `SHELF#${ID}` },
      ConditionExpression: 'attribute_exists(pk) AND beanId = :bean',
      ExpressionAttributeValues: { ':bean': ID, ':values': values },
    });
  });

  it('a replace that switches to a rejected bean is BeanNotFoundError, with no second write', async () => {
    const other = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DG';
    const { repo, sent } = scripted([cancelled(0, 2), undefined], [shelfItem]);
    await expect(repo.replaceShelfEntry(ALICE, ID, { ...shelfValues, bean_id: other })).rejects.toThrow(BeanNotFoundError);
    expect(sent.map((input) => ('TransactItems' in input ? 'transact' : 'get'))).toEqual(['transact', 'get']);
  });

  it('the second write of a same-bean replace: gone is 404, a bean changed meanwhile is a conflict, a missing bean is 404', async () => {
    const values = { ...shelfValues, bean_id: ID };
    await expect(scripted([cancelled(0, 2), cancelled(1, 2)], [shelfItem, {}]).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(
      ItemNotFoundError,
    );
    await expect(
      scripted([cancelled(0, 2), cancelled(1, 2)], [shelfItem, shelfItem]).repo.replaceShelfEntry(ALICE, ID, values),
    ).rejects.toThrow(WriteConflictError);
    await expect(scripted([cancelled(0, 2), cancelled(0, 2)], [shelfItem]).repo.replaceShelfEntry(ALICE, ID, values)).rejects.toThrow(
      BeanNotFoundError,
    );
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

describe('bean review: verify, reject, and the barcode pointer (M1-T4a)', () => {
  const EAN = '4006381333931';
  const OTHER = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
  const beanItem = (status: string, barcode: string | null = EAN): Record<string, unknown> => ({
    pk: `BEAN#${ID}`,
    sk: 'META',
    beanId: ID,
    status,
    createdAt: '2026-11-25T07:00:00.000Z',
    vocabularyVersion: 1,
    openFoodFactsMatch: false,
    pickedAttributes: { process: 'washed' },
    operatorAttributes: {},
    ...(barcode === null ? {} : { barcode }),
  });
  const pointer = (beanId: string): Record<string, unknown> => ({ pk: `BARCODE#${EAN}`, sk: 'BEAN', beanId, barcode: EAN });

  /**
   * GetItem answers from `items` by sort key (META: the bean, BEAN: the pointer).
   * Updates return the bean with the new status; `write` may throw instead.
   */
  function catalogue(
    items: { meta?: Record<string, unknown> | (() => Record<string, unknown>); pointer?: Record<string, unknown> },
    write: (input: Record<string, unknown>) => unknown = (input) =>
      'TransactItems' in input ? {} : { Attributes: { ...beanItem('x'), status: (input.ExpressionAttributeValues as Record<string, unknown>)[':status'] } },
  ): { repo: Repository; sent: Record<string, unknown>[] } {
    return stub((input) => {
      if ('Key' in input && !('UpdateExpression' in input)) {
        const sk = (input.Key as { sk: string }).sk;
        const meta = typeof items.meta === 'function' ? items.meta() : items.meta;
        return { Item: sk === 'META' ? meta : items.pointer };
      }
      return write(input);
    });
  }
  const writes = (sent: Record<string, unknown>[]): Record<string, unknown>[] =>
    sent.filter((input) => 'TransactItems' in input || 'UpdateExpression' in input);

  it('reject deletes the pointer in the same transaction, only while it names this bean', async () => {
    const { repo, sent } = catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) });
    const rejected = await repo.rejectBean(ID);
    expect(rejected.status).toBe('rejected');
    expect(rejected.bean.barcode).toBe(EAN);
    const [transaction] = writes(sent);
    expect(writes(sent)).toHaveLength(1);
    const items = (transaction as { TransactItems: Record<string, Record<string, unknown>>[] }).TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0]?.Update).toMatchObject({
      Key: { pk: `BEAN#${ID}`, sk: 'META' },
      ConditionExpression: 'attribute_exists(pk) AND #status = :unverified',
      ExpressionAttributeValues: expect.objectContaining({ ':status': 'rejected' }) as unknown,
    });
    expect(String(items[0]?.Update?.UpdateExpression)).toContain('REMOVE #gpk, #gsk');
    expect(items[1]?.Delete).toEqual({
      TableName: 'cupmark-test-main',
      Key: { pk: `BARCODE#${EAN}`, sk: 'BEAN' },
      ConditionExpression: 'beanId = :bean',
      ExpressionAttributeValues: { ':bean': ID },
    });
  });

  it.each([
    ['a bean without a barcode', beanItem('unverified', null), undefined],
    ['a pointer that names another bean', beanItem('unverified'), pointer(OTHER)],
    ['no pointer at all', beanItem('unverified'), undefined],
  ])('reject of %s is the single update and leaves any pointer alone', async (_name, meta, ptr) => {
    const { repo, sent } = catalogue({ meta, ...(ptr === undefined ? {} : { pointer: ptr }) });
    expect((await repo.rejectBean(ID)).status).toBe('rejected');
    expect(writes(sent)).toHaveLength(1);
    expect(writes(sent)[0]).not.toHaveProperty('TransactItems');
  });

  it('verify keeps the pointer: a single update, never a delete', async () => {
    const { repo, sent } = catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) });
    expect((await repo.verifyBean(ID)).status).toBe('verified');
    expect(writes(sent)).toHaveLength(1);
    expect(writes(sent)[0]).not.toHaveProperty('TransactItems');
    expect(sent.some((input) => (input.Key as { sk?: string } | undefined)?.sk === 'BEAN')).toBe(false);
  });

  it('a missing bean is ItemNotFoundError and an already reviewed one BeanNotUnverifiedError, with nothing written', async () => {
    const missing = catalogue({});
    await expect(missing.repo.rejectBean(ID)).rejects.toThrow(ItemNotFoundError);
    await expect(missing.repo.verifyBean(ID)).rejects.toThrow(ItemNotFoundError);
    for (const status of ['verified', 'rejected']) {
      const reviewed = catalogue({ meta: beanItem(status), pointer: pointer(ID) });
      await expect(reviewed.repo.rejectBean(ID)).rejects.toThrow(BeanNotUnverifiedError);
      await expect(reviewed.repo.verifyBean(ID)).rejects.toThrow(BeanNotUnverifiedError);
      expect(writes(reviewed.sent)).toEqual([]);
    }
  });

  it('verify and reject that meet a concurrent transaction are WriteConflictError (rethrowConflict)', async () => {
    const conflict = (): never => {
      throw new TransactionConflictException({ message: 'conflict', $metadata: {} });
    };
    await expect(catalogue({ meta: beanItem('unverified') }, conflict).repo.verifyBean(ID)).rejects.toThrow(WriteConflictError);
    await expect(catalogue({ meta: beanItem('unverified', null) }, conflict).repo.rejectBean(ID)).rejects.toThrow(WriteConflictError);
    await expect(catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) }, conflict).repo.rejectBean(ID)).rejects.toThrow(
      WriteConflictError,
    );
    const cancelled = (): never => {
      throw new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
      });
    };
    await expect(catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) }, cancelled).repo.rejectBean(ID)).rejects.toThrow(
      WriteConflictError,
    );
  });

  it('a reject whose pointer changed during the write is WriteConflictError; one whose bean was reviewed meanwhile is not', async () => {
    const failing = (index: number) => (): never => {
      throw new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [0, 1].map((i) => ({ Code: i === index ? 'ConditionalCheckFailed' : 'None' })),
      });
    };
    await expect(catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) }, failing(1)).repo.rejectBean(ID)).rejects.toThrow(
      WriteConflictError,
    );
    // The bean was verified between the read and the write: the second read says so.
    let reads = 0;
    const meta = (): Record<string, unknown> => beanItem(reads++ === 0 ? 'unverified' : 'verified');
    await expect(catalogue({ meta, pointer: pointer(ID) }, failing(0)).repo.rejectBean(ID)).rejects.toThrow(BeanNotUnverifiedError);
  });

  it('a single-update review whose condition failed tells gone from reviewed', async () => {
    const conditionFailed = (): never => {
      throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
    };
    let reads = 0;
    const meta = (): Record<string, unknown> => beanItem(reads++ === 0 ? 'unverified' : 'rejected');
    await expect(catalogue({ meta }, conditionFailed).repo.verifyBean(ID)).rejects.toThrow(BeanNotUnverifiedError);
  });

  it('getBeanByBarcode: a pointer to a missing bean or to a bean with another barcode is CorruptItemError', async () => {
    await expect(catalogue({ pointer: pointer(ID) }).repo.getBeanByBarcode(EAN)).rejects.toThrow(CorruptItemError);
    await expect(catalogue({ meta: beanItem('unverified', '0036000291452'), pointer: pointer(ID) }).repo.getBeanByBarcode(EAN)).rejects.toThrow(
      CorruptItemError,
    );
    expect(await catalogue({}).repo.getBeanByBarcode(EAN)).toBeUndefined();
    expect((await catalogue({ meta: beanItem('unverified'), pointer: pointer(ID) }).repo.getBeanByBarcode(EAN))?.bean.bean_id).toBe(ID);
  });

  it('getBeanByBarcode refuses a malformed barcode or a bad check digit before any request', async () => {
    const { repo, sent } = catalogue({});
    await expect(repo.getBeanByBarcode('4006381333932')).rejects.toThrow(InvalidKeyError);
    await expect(repo.getBeanByBarcode('BEAN#x')).rejects.toThrow(InvalidKeyError);
    expect(sent).toEqual([]);
  });
});
