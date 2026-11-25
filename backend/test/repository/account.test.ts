// The repository's part of M1-T6 without a database: the tombstone check on
// every write of a caller, the batch deletion of a partition with retries of
// unprocessed items, the tombstone's own writes, and the export read.
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  AccountDeletedError,
  BATCH_WRITE_ATTEMPTS,
  BATCH_WRITE_SIZE,
  CorruptItemError,
  DeletionIncompleteError,
  Repository,
  TOMBSTONE_TTL_SECONDS,
  tombstoneKey,
  userPk,
} from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';
import { validBrewInput } from '../fixtures.ts';

const ALICE = verifiedUserId('3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718');
const ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DE';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

type Input = Record<string, unknown>;

function stub(reply: (input: Input, name: string) => unknown): { repo: Repository; sent: { name: string; input: Input }[]; waits: number[] } {
  const sent: { name: string; input: Input }[] = [];
  const waits: number[] = [];
  const client = {
    send: (command: { input: Input; constructor: { name: string } }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      try {
        return Promise.resolve(reply(command.input, name));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('stub failure'));
      }
    },
  } as unknown as DynamoDBDocumentClient;
  const repo = new Repository({
    client,
    tableName: 'cupmark-test-main',
    now: () => new Date(NOW),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { repo, sent, waits };
}

const shelfItem = { pk: userPk(ALICE), sk: `SHELF#${ID}`, shelfEntryId: ID, beanId: ID, values: { vocabulary_version: 1, bean_id: ID, purchase_date: '2026-11-20' }, brewCount: 0 };
const brewValues = { ...validBrewInput(), shelf_entry_id: ID, brewed_at: '2026-11-25T07:00:00.000Z' };
const brewSk = `BREW#2026-11-25T07:00:00.000Z#${ID}`;

/** Answers GetItem for the items a write reads first; transactions succeed. */
function reads(input: Input): unknown {
  const key = input.Key as { sk?: string } | undefined;
  if (key?.sk === `SHELF#${ID}`) return { Item: shelfItem };
  if (key?.sk === `BREWID#${ID}`) return { Item: { pk: userPk(ALICE), sk: `BREWID#${ID}`, brewId: ID, brewSk, createdAt: 'x' } };
  if (key?.sk === brewSk) return { Item: { pk: userPk(ALICE), sk: brewSk, brewId: ID, shelfEntryId: ID, beanId: ID, values: brewValues } };
  if (key?.sk === `RECIPE#${ID}`) return { Item: { pk: userPk(ALICE), sk: `RECIPE#${ID}`, recipeId: ID, values: { vocabulary_version: 1, parameters: { method: 'v60' } } } };
  return {};
}

const tombstoneCheck = {
  ConditionCheck: {
    TableName: 'cupmark-test-main',
    Key: { pk: `DELETED#${ALICE.value}`, sk: 'META' },
    ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
    ExpressionAttributeValues: { ':now': NOW_SECONDS },
  },
};

const WRITES: [string, (repo: Repository) => Promise<unknown>][] = [
  ['putProfile', (r) => r.putProfile(ALICE, { locale: 'en', consent: { contribute_to_aggregates: false } })],
  ['createShelfEntry', (r) => r.createShelfEntry(ALICE, shelfItem.values)],
  ['replaceShelfEntry', (r) => r.replaceShelfEntry(ALICE, ID, shelfItem.values)],
  ['deleteShelfEntry', (r) => r.deleteShelfEntry(ALICE, ID)],
  ['createBrew', (r) => r.createBrew(ALICE, brewValues as never)],
  ['replaceBrew', (r) => r.replaceBrew(ALICE, ID, brewValues as never)],
  ['deleteBrew', (r) => r.deleteBrew(ALICE, ID)],
  ['createRecipe', (r) => r.createRecipe(ALICE, { vocabulary_version: 1, parameters: { method: 'v60' } })],
  ['replaceRecipe', (r) => r.replaceRecipe(ALICE, ID, { vocabulary_version: 1, parameters: { method: 'v60' } })],
  ['deleteRecipe', (r) => r.deleteRecipe(ALICE, ID)],
  ['createBean (as a caller)', (r) => r.createBean({ vocabularyVersion: 1, openFoodFactsMatch: false, pickedAttributes: {} }, ALICE)],
  ['countLookup', (r) => r.countLookup(ALICE, 5)],
  ['countLabelPhotoUpload', (r) => r.countLabelPhotoUpload(ALICE, 5)],
  ['createPendingLabelPhoto', (r) => r.createPendingLabelPhoto(ALICE, ID)],
  ['completeLabelPhoto', (r) => r.completeLabelPhoto(ALICE, ID, ID)],
];

describe('the tombstone check', () => {
  it.each(WRITES)('%s is one transaction whose last item checks the caller’s tombstone', async (_name, write) => {
    const { repo, sent } = stub(reads);
    await write(repo);
    const writes = sent.filter((entry) => entry.name !== 'GetCommand');
    expect(writes.map((entry) => entry.name)).toEqual(['TransactWriteCommand']);
    const items = (writes[0]?.input.TransactItems ?? []) as unknown[];
    expect(items.at(-1)).toEqual(tombstoneCheck);
  });

  it.each(WRITES)('%s: a failed tombstone check is AccountDeletedError', async (_name, write) => {
    const { repo } = stub((input, name) => {
      if (name !== 'TransactWriteCommand') return reads(input);
      const count = (input.TransactItems as unknown[]).length;
      throw new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: Array.from({ length: count }, (_, i) => ({ Code: i === count - 1 ? 'ConditionalCheckFailed' : 'None' })),
      });
    });
    await expect(write(repo)).rejects.toThrow(AccountDeletedError);
  });

  it('isAccountDeleted is a strongly consistent read; an expired tombstone is not in force', async () => {
    const tomb = (expires: number) => ({ Item: { ...tombstoneKey(ALICE), deletedAt: 'x', expires_at: expires } });
    for (const [answer, expected] of [
      [{}, false],
      [tomb(NOW_SECONDS + 1), true],
      [tomb(NOW_SECONDS), false],
    ] as const) {
      const { repo, sent } = stub(() => answer);
      expect(await repo.isAccountDeleted(ALICE)).toBe(expected);
      expect(sent[0]?.input).toMatchObject({ Key: tombstoneKey(ALICE), ConsistentRead: true });
    }
  });
});

describe('markAccountDeleted', () => {
  it('puts a fresh tombstone 2 hours ahead, conditional on none in force', async () => {
    const { repo, sent } = stub((_input, name) =>
      name === 'GetCommand' ? { Item: { ...tombstoneKey(ALICE), deletedAt: NOW.toISOString(), expires_at: NOW_SECONDS + TOMBSTONE_TTL_SECONDS } } : {},
    );
    expect(await repo.markAccountDeleted(ALICE)).toEqual({ deletedAt: NOW.toISOString(), photoIds: [], logged: false });
    expect(sent[0]?.input).toEqual({
      TableName: 'cupmark-test-main',
      Item: { ...tombstoneKey(ALICE), type: 'ACCOUNT_TOMBSTONE', deletedAt: NOW.toISOString(), expires_at: NOW_SECONDS + 7200 },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
      ExpressionAttributeValues: { ':now': NOW_SECONDS },
    });
    expect(tombstoneKey(ALICE)).toEqual({ pk: `DELETED#${ALICE.value}`, sk: 'META' });
  });

  it('keeps a tombstone in force and only moves its expiry forward', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const stored = { ...tombstoneKey(ALICE), deletedAt: '2026-11-25T11:00:00.000Z', expires_at: NOW_SECONDS + 3600, photoIds: new Set([ID]), loggedAt: 'x' };
    const { repo, sent } = stub((_input, name) => {
      if (name === 'PutCommand') throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      return name === 'GetCommand' ? { Item: stored } : {};
    });
    expect(await repo.markAccountDeleted(ALICE)).toEqual({ deletedAt: '2026-11-25T11:00:00.000Z', photoIds: [ID], logged: true });
    expect(sent[1]?.input).toMatchObject({
      UpdateExpression: 'SET expires_at = :expires',
      ConditionExpression: 'attribute_exists(pk) AND expires_at < :expires',
      ExpressionAttributeValues: { ':expires': NOW_SECONDS + 7200 },
    });
  });

  it('recordDeletedPhotos adds to a string set, and only valid ids', async () => {
    const { repo, sent } = stub(() => ({}));
    await repo.recordDeletedPhotos(ALICE, []);
    expect(sent).toEqual([]);
    await repo.recordDeletedPhotos(ALICE, [ID, ID]);
    expect(sent[0]?.input).toMatchObject({ Key: tombstoneKey(ALICE), UpdateExpression: 'ADD photoIds :ids', ExpressionAttributeValues: { ':ids': new Set([ID]) } });
    await expect(repo.recordDeletedPhotos(ALICE, ['x'])).rejects.toThrow();
  });
});

describe('deleteUserPartition', () => {
  const keys = (count: number): Input[] => Array.from({ length: count }, (_, i) => ({ pk: userPk(ALICE), sk: `RECIPE#${String(i).padStart(26, '0')}` }));

  it('reads every page, then deletes in pages of 25', async () => {
    const all = keys(60);
    const { repo, sent } = stub((input, name) => {
      if (name === 'QueryCommand') return input.ExclusiveStartKey === undefined ? { Items: all.slice(0, 40), LastEvaluatedKey: all[39] } : { Items: all.slice(40) };
      return {};
    });
    expect(await repo.deleteUserPartition(ALICE)).toBe(60);
    const queries = sent.filter((e) => e.name === 'QueryCommand');
    expect(queries).toHaveLength(2);
    expect(queries[0]?.input).toMatchObject({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': userPk(ALICE) }, ConsistentRead: true, ProjectionExpression: 'pk, sk' });
    const batches = sent.filter((e) => e.name === 'BatchWriteCommand').map((e) => (e.input.RequestItems as Record<string, unknown[]>)['cupmark-test-main'] ?? []);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
    expect(BATCH_WRITE_SIZE).toBe(25);
    expect(batches.flat()).toEqual(all.map((key) => ({ DeleteRequest: { Key: key } })));
  });

  it('retries unprocessed items with a growing wait, then succeeds', async () => {
    const all = keys(3);
    let round = 0;
    const { repo, sent, waits } = stub((_input, name) => {
      if (name === 'QueryCommand') return { Items: all };
      round += 1;
      if (round === 1) return { UnprocessedItems: { 'cupmark-test-main': [{ DeleteRequest: { Key: all[1] } }, { DeleteRequest: { Key: all[2] } }] } };
      if (round === 2) return { UnprocessedItems: { 'cupmark-test-main': [{ DeleteRequest: { Key: all[2] } }] } };
      return {};
    });
    await repo.deleteUserPartition(ALICE);
    const batches = sent.filter((e) => e.name === 'BatchWriteCommand').map((e) => (e.input.RequestItems as Record<string, unknown[]>)['cupmark-test-main']?.length);
    expect(batches).toEqual([3, 2, 1]);
    expect(waits).toHaveLength(2);
    expect(waits[1] ?? 0).toBeGreaterThan(waits[0] ?? 0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1000);
  });

  it('gives up after BATCH_WRITE_ATTEMPTS with DeletionIncompleteError; a repeat finishes', async () => {
    const all = keys(2);
    let stuck = true;
    const { repo } = stub((_input, name) => {
      if (name === 'QueryCommand') return { Items: all };
      return stuck ? { UnprocessedItems: { 'cupmark-test-main': [{ DeleteRequest: { Key: all[0] } }] } } : {};
    });
    await expect(repo.deleteUserPartition(ALICE)).rejects.toThrow(DeletionIncompleteError);
    expect(BATCH_WRITE_ATTEMPTS).toBeGreaterThan(3);
    stuck = false;
    await expect(repo.deleteUserPartition(ALICE)).resolves.toBe(2);
  });

  it('never sends a delete for a key outside the caller’s partition', async () => {
    const { repo, sent } = stub((_input, name) => (name === 'QueryCommand' ? { Items: [{ pk: 'USER#someone-else', sk: 'PROFILE' }] } : {}));
    await expect(repo.deleteUserPartition(ALICE)).rejects.toThrow(CorruptItemError);
    expect(sent.filter((e) => e.name === 'BatchWriteCommand')).toEqual([]);
  });
});

describe('exportItems', () => {
  it('queries each exported prefix of the caller’s partition only, all pages, consistent', async () => {
    const { repo, sent } = stub(() => ({ Items: [] }));
    expect(await repo.exportItems(ALICE)).toEqual({ shelfEntries: [], brews: [], recipes: [], labelPhotos: [] });
    const prefixes = sent.filter((e) => e.name === 'QueryCommand').map((e) => (e.input.ExpressionAttributeValues as Input)[':prefix']);
    expect(prefixes.sort()).toEqual(['BREW#', 'PHOTO#', 'RECIPE#', 'SHELF#']);
    for (const entry of sent.filter((e) => e.name === 'QueryCommand')) {
      expect(entry.input).toMatchObject({ ConsistentRead: true, ExpressionAttributeValues: { ':pk': userPk(ALICE) } });
    }
  });

  it('refuses an item whose sort key does not match its prefix', async () => {
    const { repo } = stub((input, name) =>
      name === 'QueryCommand' && (input.ExpressionAttributeValues as Input)[':prefix'] === 'PHOTO#' ? { Items: [{ pk: userPk(ALICE), sk: 'PHOTO#nope', photoId: ID, beanId: ID, createdAt: 'x' }] } : { Items: [] },
    );
    await expect(repo.exportItems(ALICE)).rejects.toThrow(CorruptItemError);
  });
});
