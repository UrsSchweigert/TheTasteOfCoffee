// Typed reads and writes of the table `cupmark-<stage>-main`. The only module
// that talks to DynamoDB; key formats come from keys.ts (ADR 0010).
//
// Rules every method follows:
// - User-scoped methods take a `UserId` (only `userIdFromEvent` makes one) and
//   derive the partition key from it. No method takes a user id as a string.
// - Every item read in a user context is checked to lie in that user's partition.
// - Creates are conditional on `attribute_not_exists(pk)`; updates and deletes on
//   the item existing. A failed condition becomes a typed error from errors.ts.
// - Values are parsed with the generated contract schemas on the way in and on
//   the way out, so nothing outside the contract is stored or returned.
// - References are kept in the same transaction as the write: a shelf entry
//   needs its bean in the catalogue, a brew needs its shelf entry in the
//   caller's partition, and each shelf entry counts the brews that reference it
//   (`brewCount`, ADR 0012), so a shelf entry with brews cannot be deleted
//   and cannot change its bean (D14).
// - The aggregation pipeline (M3) is not here; keys.ts has its key builders.
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, QueryCommandInput, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { UserId } from '../auth/user-id.ts';
import {
  BarcodeSchema,
  BeanAttributesSchema,
  BrewInputSchema,
  IdSchema,
  OpenFoodFactsProductSchema,
  ProfileSchema,
  RecipeInputSchema,
  ShelfEntryInputSchema,
  VocabularyVersionSchema,
} from '../generated/contract.ts';
import type {
  Barcode,
  Bean,
  BeanAttributes,
  Brew,
  BrewInput,
  OpenFoodFactsProduct,
  Profile,
  Recipe,
  RecipeInput,
  ShelfEntry,
  ShelfEntryInput,
  VocabularyVersion,
} from '../generated/contract.ts';
import { newUlid } from '../ids/ulid.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import {
  BarcodeTakenError,
  BeanNotFoundError,
  BeanNotUnverifiedError,
  CorruptItemError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  ShelfEntryBeanLockedError,
  ShelfEntryInUseError,
  ShelfEntryNotFoundError,
  WriteConflictError,
} from './errors.ts';
import {
  PREFIX,
  REVIEW_QUEUE_PK,
  barcodeKey,
  beanMetaKey,
  canonicalBarcode,
  brewKey,
  lookupCounterKey,
  openFoodFactsCacheKey,
  brewRefKey,
  brewSortKey,
  parseBrewSortKey,
  parseRecipeSortKey,
  parseReviewQueueSortKey,
  parseShelfSortKey,
  profileKey,
  recipeKey,
  reviewQueueKey,
  shelfEntryKey,
  userPk,
  utcOf,
} from './keys.ts';
import type { Key } from './keys.ts';
import { REVIEW_QUEUE_INDEX } from './table.ts';

export interface RepositoryOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** Id generator, for tests. Must return a contract `Id` (ULID). */
  readonly newId?: (now: Date) => string;
}

export interface ListOptions {
  /** 1 to 100, default 50 (contracts/openapi.yaml, `LimitQuery`). */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor?: string;
}

export type BeanStatus = 'unverified' | 'verified' | 'rejected';

export interface BeanRecord {
  readonly bean: Bean;
  readonly status: BeanStatus;
  /** Fixed-width UTC (`toISOString()`). */
  readonly createdAt: string;
}

export interface NewBean {
  readonly vocabularyVersion: VocabularyVersion;
  readonly barcode?: Barcode;
  readonly openFoodFactsMatch: boolean;
  /** The Open Food Facts group, copied from the server's cache (M1-T4b). Only with `openFoodFactsMatch`. */
  readonly openFoodFacts?: OpenFoodFactsProduct;
  readonly pickedAttributes: BeanAttributes;
}

/**
 * The server's cached Open Food Facts result for a barcode (`BARCODE#<ean>` /
 * `OFF`): a hit with the cleaned text, or a miss that has not expired yet.
 */
export type OpenFoodFactsCacheEntry =
  | { readonly kind: 'hit'; readonly product: OpenFoodFactsProduct }
  | { readonly kind: 'miss' };

/** How long a cached miss stands before the barcode is fetched again (docs/05, Barcode lookup). */
export const OPEN_FOOD_FACTS_MISS_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A daily lookup counter expires this long after the start of its UTC day (so 24 to 48 hours after its last use). */
export const LOOKUP_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Item types, stored in the `type` attribute so stream consumers can tell items apart. */
export const ITEM_TYPE = {
  profile: 'PROFILE',
  shelfEntry: 'SHELF',
  brew: 'BREW',
  brewRef: 'BREW_REF',
  recipe: 'RECIPE',
  bean: 'BEAN',
  barcode: 'BARCODE',
  openFoodFactsCache: 'OFF_CACHE',
  lookupCounter: 'LOOKUPS',
} as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// ---- stored item shapes (unknown attributes are stripped on read) ----

const KeyAttributes = z.object({ pk: z.string(), sk: z.string() });

const ProfileItem = KeyAttributes.extend({ values: ProfileSchema });
const ShelfItem = KeyAttributes.extend({
  shelfEntryId: IdSchema,
  beanId: IdSchema,
  values: ShelfEntryInputSchema,
}).refine((item) => item.beanId === item.values.bean_id);
/**
 * `shelfEntryId` and `beanId` are copies of the brew's shelf entry and of that
 * entry's bean at the time of the write: the reference count needs the first,
 * and the aggregator (M3) reads the bean of a removed brew from its old image.
 */
const BrewItem = KeyAttributes.extend({
  brewId: IdSchema,
  shelfEntryId: IdSchema,
  beanId: IdSchema,
  values: BrewInputSchema,
}).refine((item) => item.shelfEntryId === item.values.shelf_entry_id);
const BrewRefItem = KeyAttributes.extend({ brewId: IdSchema, brewSk: z.string(), createdAt: z.string() });
const RecipeItem = KeyAttributes.extend({ recipeId: IdSchema, values: RecipeInputSchema });
const BeanItem = KeyAttributes.extend({
  beanId: IdSchema,
  status: z.enum(['unverified', 'verified', 'rejected']),
  createdAt: z.string(),
  vocabularyVersion: VocabularyVersionSchema,
  barcode: BarcodeSchema.optional(),
  openFoodFactsMatch: z.boolean(),
  openFoodFacts: OpenFoodFactsProductSchema.optional(),
  pickedAttributes: BeanAttributesSchema,
  operatorAttributes: BeanAttributesSchema,
});
const BarcodeItem = KeyAttributes.extend({ beanId: IdSchema });
/** Epoch seconds, as the table's TTL attribute `expires_at` holds them. */
const EpochSeconds = z.number().int().nonnegative();
const OpenFoodFactsCacheItem = z.discriminatedUnion('result', [
  KeyAttributes.extend({ result: z.literal('hit'), product: OpenFoodFactsProductSchema, fetchedAt: z.string() }),
  KeyAttributes.extend({ result: z.literal('miss'), fetchedAt: z.string(), expires_at: EpochSeconds }),
]);
const LastKey = z.object({ pk: z.string(), sk: z.string(), gsi1sk: z.string().optional() });

type BeanItemShape = z.infer<typeof BeanItem>;

function validValues<T>(schema: z.ZodType<T>, values: unknown, what: string): T {
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new InvalidValuesError(`invalid ${what}`);
  return parsed.data;
}

function storedItem<T extends { pk: string }>(schema: z.ZodType<T>, item: unknown, expectedPk: string, what: string): T {
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw new CorruptItemError(`stored ${what} does not match its schema`);
  // Defence in depth: the key was built from expectedPk, but never return an item from elsewhere.
  if (parsed.data.pk !== expectedPk) throw new CorruptItemError(`stored ${what} is outside the expected partition`);
  return parsed.data;
}

function canonicalBarcodeValue(value: unknown): string {
  try {
    return canonicalBarcode(value);
  } catch (error) {
    if (error instanceof InvalidKeyError) throw new InvalidValuesError('invalid barcode', { cause: error });
    throw error;
  }
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException;
}

/**
 * Index of each item whose condition failed in a cancelled transaction; undefined if not a cancellation.
 *
 * A transaction cancelled only because another transaction was writing one of
 * its items at the same time (reason `TransactionConflict`, for example two
 * brews counted on one shelf entry, ADR 0012) wrote nothing and is safe to
 * repeat: it throws WriteConflictError, which the API retries.
 */
function failedConditions(error: unknown): number[] | undefined {
  if (!(error instanceof TransactionCanceledException)) return undefined;
  const reasons = error.CancellationReasons ?? [];
  const failed = reasons.flatMap((reason, index) => (reason.Code === 'ConditionalCheckFailed' ? [index] : []));
  if (failed.length === 0 && reasons.some((reason) => reason.Code === 'TransactionConflict')) {
    throw new WriteConflictError('a concurrent transaction wrote the same item', { cause: error });
  }
  return failed;
}

/** A single-item write that met an item inside an ongoing transaction: nothing was written; safe to repeat. */
function rethrowConflict(error: unknown): void {
  if (error instanceof TransactionConflictException) {
    throw new WriteConflictError('a concurrent transaction wrote the same item', { cause: error });
  }
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function limitOf(options: ListOptions): number {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new InvalidValuesError('invalid limit');
  return limit;
}

function beanOf(item: BeanItemShape): BeanRecord {
  const bean: Bean = {
    bean_id: item.beanId,
    vocabulary_version: item.vocabularyVersion,
    verified: item.status === 'verified',
    open_food_facts_match: item.openFoodFactsMatch,
    ...(item.openFoodFacts === undefined ? {} : { open_food_facts: item.openFoodFacts }),
    picked_attributes: item.pickedAttributes,
    operator_attributes: item.operatorAttributes,
    ...(item.barcode === undefined ? {} : { barcode: item.barcode }),
  };
  return { bean, status: item.status, createdAt: item.createdAt };
}

export class Repository {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #now: () => Date;
  readonly #newId: (now: Date) => string;

  public constructor(options: RepositoryOptions) {
    if (options.tableName === '') throw new InvalidValuesError('a table name is required');
    this.#client = options.client;
    this.#table = options.tableName;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? ((now) => newUlid(now.getTime()));
  }

  // ---- profile ----

  public async getProfile(user: UserId): Promise<Profile | undefined> {
    const key = profileKey(user);
    const item = await this.#get(key);
    return item === undefined ? undefined : storedItem(ProfileItem, item, key.pk, 'profile').values;
  }

  /**
   * Creates or replaces consent and locale (PUT /profile). An update, not a put,
   * so other attributes of the profile item (the entitlement, M4) are kept.
   */
  public async putProfile(user: UserId, profile: Profile): Promise<Profile> {
    const key = profileKey(user);
    const values = validValues(ProfileSchema, profile, 'profile');
    const now = utcOf(this.#now());
    const result = await this.#client.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: key,
        UpdateExpression: 'SET #type = :type, #values = :values, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
        ExpressionAttributeNames: { '#type': 'type', '#values': 'values' },
        ExpressionAttributeValues: { ':type': ITEM_TYPE.profile, ':values': values, ':now': now },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return storedItem(ProfileItem, result.Attributes, key.pk, 'profile').values;
  }

  // ---- shelf entries ----

  public async createShelfEntry(user: UserId, input: ShelfEntryInput): Promise<ShelfEntry> {
    const values = validValues(ShelfEntryInputSchema, input, 'shelf entry');
    const now = this.#now();
    const shelfEntryId = this.#newId(now);
    const key = shelfEntryKey(user, shelfEntryId);
    const at = utcOf(now);
    const item = {
      ...key,
      type: ITEM_TYPE.shelfEntry,
      shelfEntryId,
      beanId: values.bean_id,
      purchaseDate: values.purchase_date,
      values,
      brewCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: this.#beanUsable(values.bean_id) },
            { Put: { TableName: this.#table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(0)) throw new BeanNotFoundError('no such bean');
      if (failed?.length) throw new ItemExistsError('shelf entry exists');
      throw error;
    }
    return { shelf_entry_id: shelfEntryId, values };
  }

  public async getShelfEntry(user: UserId, shelfEntryId: string): Promise<ShelfEntry | undefined> {
    const key = shelfEntryKey(user, shelfEntryId);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const stored = storedItem(ShelfItem, item, key.pk, 'shelf entry');
    return { shelf_entry_id: stored.shelfEntryId, values: stored.values };
  }

  /**
   * Replaces a shelf entry. `bean_id` may change only while no brew references
   * the entry (D14): one condition on the entry item, `beanId` unchanged or
   * `brewCount` 0 (or absent), decides atomically. A brew create racing with a
   * bean change is conditional on the bean it read (#countBrew), so one of the
   * two transactions fails: either this replace (ShelfEntryBeanLockedError) or
   * the brew (WriteConflictError, retried against the new bean).
   * A failed condition reads the item once: gone is ItemNotFoundError, an
   * unknown bean is BeanNotFoundError, otherwise ShelfEntryBeanLockedError.
   *
   * The bean must exist and not be rejected (M1-T11), checked in the same
   * transaction. A ConditionCheck cannot see the entry, so an entry that keeps
   * a bean rejected after it was shelved fails that check alone; then the entry
   * is read once and, if it names that bean, the replace is written again with
   * the bean only required to exist and the entry required to still name it
   * (#replaceKeepingBean). A user can always edit a bag they already have.
   */
  public async replaceShelfEntry(user: UserId, shelfEntryId: string, input: ShelfEntryInput): Promise<ShelfEntry> {
    const key = shelfEntryKey(user, shelfEntryId);
    const values = validValues(ShelfEntryInputSchema, input, 'shelf entry');
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: this.#beanUsable(values.bean_id) },
            {
              Update: this.#shelfReplaceUpdate(
                key,
                values,
                'attribute_exists(pk) AND (beanId = :bean OR attribute_not_exists(brewCount) OR brewCount = :zero)',
                { ':zero': 0 },
              ),
            },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(1)) {
        // The item cannot reappear under this id (ids are server-generated ULIDs), so present now means present then.
        if ((await this.#get(key)) === undefined) throw new ItemNotFoundError('no such shelf entry');
        if (failed.includes(0)) throw new BeanNotFoundError('no such bean');
        throw new ShelfEntryBeanLockedError('brews reference the shelf entry');
      }
      if (failed?.includes(0)) {
        // Only the bean check failed: the bean is unknown or rejected. If the entry already names it, keep it.
        const shelf = await this.#shelfItem(user, shelfEntryId);
        if (shelf?.beanId !== values.bean_id) throw new BeanNotFoundError('no such bean');
        await this.#replaceKeepingBean(key, values);
        return { shelf_entry_id: shelf.shelfEntryId, values };
      }
      throw error;
    }
    return { shelf_entry_id: parseShelfSortKey(key.sk) ?? shelfEntryId, values };
  }

  /**
   * The second attempt of a replace that keeps a bean rejected after it was
   * shelved: the bean need only exist, and the entry must still name it, so a
   * concurrent bean change cannot slip a rejected bean in. That race is
   * WriteConflictError, and the router retries the whole replace.
   */
  async #replaceKeepingBean(key: Key, values: ShelfEntryInput): Promise<void> {
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: this.#beanExists(values.bean_id) },
            { Update: this.#shelfReplaceUpdate(key, values, 'attribute_exists(pk) AND beanId = :bean', {}) },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(1)) {
        if ((await this.#get(key)) === undefined) throw new ItemNotFoundError('no such shelf entry');
        throw new WriteConflictError('the shelf entry changed its bean during the write');
      }
      if (failed?.includes(0)) throw new BeanNotFoundError('no such bean');
      throw error;
    }
  }

  /** The Update of a shelf replace, under `condition`. */
  #shelfReplaceUpdate(
    key: Key,
    values: ShelfEntryInput,
    condition: string,
    extraValues: Record<string, unknown>,
  ): {
    TableName: string;
    Key: Key;
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    return {
      TableName: this.#table,
      Key: key,
      UpdateExpression: 'SET beanId = :bean, purchaseDate = :date, #values = :values, updatedAt = :now',
      ConditionExpression: condition,
      ExpressionAttributeNames: { '#values': 'values' },
      ExpressionAttributeValues: {
        ':bean': values.bean_id,
        ':date': values.purchase_date,
        ':values': values,
        ':now': utcOf(this.#now()),
        ...extraValues,
      },
    };
  }

  /** Deletes a shelf entry that no brew references; ShelfEntryInUseError otherwise (ADR 0012). */
  public async deleteShelfEntry(user: UserId, shelfEntryId: string): Promise<void> {
    const key = shelfEntryKey(user, shelfEntryId);
    try {
      await this.#client.send(
        new DeleteCommand({
          TableName: this.#table,
          Key: key,
          ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(brewCount) OR brewCount = :zero)',
          ExpressionAttributeValues: { ':zero': 0 },
        }),
      );
    } catch (error) {
      rethrowConflict(error);
      if (!isConditionFailure(error)) throw error;
      if ((await this.#get(key)) === undefined) throw new ItemNotFoundError('no such shelf entry');
      throw new ShelfEntryInUseError('brews reference the shelf entry');
    }
  }

  /** The caller's shelf entries, newest first. */
  public async listShelfEntries(user: UserId, options: ListOptions = {}): Promise<Page<ShelfEntry>> {
    const pk = userPk(user);
    return this.#listUserItems(pk, PREFIX.shelf, options, (sk) => parseShelfSortKey(sk) !== undefined, (item) => {
      const stored = storedItem(ShelfItem, item, pk, 'shelf entry');
      return { shelf_entry_id: stored.shelfEntryId, values: stored.values };
    });
  }

  // ---- brews (two items per brew, ADR 0010) ----

  /**
   * Logs a brew. Its shelf entry must be in the caller's partition; the same
   * transaction counts the brew on that entry, on the condition that the entry
   * still exists and still names the bean that was read.
   */
  public async createBrew(user: UserId, input: BrewInput): Promise<Brew> {
    const values = validValues(BrewInputSchema, input, 'brew');
    const shelf = await this.#shelfItem(user, values.shelf_entry_id);
    if (shelf === undefined) throw new ShelfEntryNotFoundError('no such shelf entry');
    const now = this.#now();
    const brewId = this.#newId(now);
    const key = brewKey(user, values.brewed_at, brewId);
    const ref = brewRefKey(user, brewId);
    const at = utcOf(now);
    const references = { shelfEntryId: shelf.shelfEntryId, beanId: shelf.beanId };
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#table,
                Item: { ...key, type: ITEM_TYPE.brew, brewId, ...references, values, createdAt: at, updatedAt: at },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.#table,
                Item: { ...ref, type: ITEM_TYPE.brewRef, brewId, brewSk: key.sk, createdAt: at },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Update: this.#countBrew(shelf, 1) },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(2)) {
        if ((await this.#shelfItem(user, values.shelf_entry_id)) === undefined) throw new ShelfEntryNotFoundError('no such shelf entry');
        throw new WriteConflictError('the shelf entry changed during the write');
      }
      if (failed?.length) throw new ItemExistsError('brew exists');
      throw error;
    }
    return { brew_id: brewId, values };
  }

  /**
   * Reads a brew by id: the pointer, then the brew it names. A replace that moves
   * the brew can land between the two reads; then the pointer is read again and
   * followed once more, so a concurrent move never shows as not found.
   */
  public async getBrew(user: UserId, brewId: string): Promise<Brew | undefined> {
    let followed: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ref = await this.#brewRef(user, brewId);
      // No pointer, or it still names the key just found empty: the brew is gone.
      if (ref === undefined || ref.brewSk === followed) return undefined;
      followed = ref.brewSk;
      const item = await this.#get({ pk: ref.pk, sk: ref.brewSk });
      if (item === undefined) continue;
      const stored = storedItem(BrewItem, item, ref.pk, 'brew');
      if (stored.brewId !== ref.brewId) throw new CorruptItemError('stored brew does not match its pointer');
      return { brew_id: stored.brewId, values: stored.values };
    }
    throw new WriteConflictError('the brew kept moving during the read');
  }

  /**
   * Replaces a brew. When `brewed_at` moves, the brew item moves to its new sort
   * key in one transaction (delete old, put new, repoint), which the aggregator
   * sees as a remove and an insert: the correct difference. When the shelf
   * entry changes, the same transaction moves the count from the old entry to
   * the new one, which must exist in the caller's partition.
   */
  public async replaceBrew(user: UserId, brewId: string, input: BrewInput): Promise<Brew> {
    const values = validValues(BrewInputSchema, input, 'brew');
    const current = await this.#brewWithRef(user, brewId);
    const shelf = await this.#shelfItem(user, values.shelf_entry_id);
    if (shelf === undefined) throw new ShelfEntryNotFoundError('no such shelf entry');
    const { ref, brew } = current;
    const refKey = brewRefKey(user, brewId);
    const newSk = brewSortKey(values.brewed_at, brewId);
    const at = utcOf(this.#now());
    const references = { shelfEntryId: shelf.shelfEntryId, beanId: shelf.beanId };
    const pointerUnchanged = {
      TableName: this.#table,
      Key: refKey,
      ConditionExpression: 'brewSk = :old',
      ExpressionAttributeValues: { ':old': ref.brewSk },
    };
    // The brew item must still reference the shelf entry read above, or the counts would drift.
    const brewUnchanged = {
      ConditionExpression: 'attribute_exists(pk) AND shelfEntryId = :oldShelf',
      ExpressionAttributeValues: { ':oldShelf': brew.shelfEntryId },
    };
    const brewItems: NonNullable<TransactWriteCommandInput['TransactItems']> =
      newSk === ref.brewSk
        ? [
            { ConditionCheck: pointerUnchanged },
            {
              Update: {
                TableName: this.#table,
                Key: { pk: ref.pk, sk: ref.brewSk },
                UpdateExpression: 'SET #values = :values, shelfEntryId = :shelf, beanId = :bean, updatedAt = :now',
                ConditionExpression: brewUnchanged.ConditionExpression,
                ExpressionAttributeNames: { '#values': 'values' },
                ExpressionAttributeValues: {
                  ...brewUnchanged.ExpressionAttributeValues,
                  ':values': values,
                  ':shelf': references.shelfEntryId,
                  ':bean': references.beanId,
                  ':now': at,
                },
              },
            },
          ]
        : [
            { Delete: { TableName: this.#table, Key: { pk: ref.pk, sk: ref.brewSk }, ...brewUnchanged } },
            {
              Put: {
                TableName: this.#table,
                Item: {
                  pk: ref.pk,
                  sk: newSk,
                  type: ITEM_TYPE.brew,
                  brewId,
                  ...references,
                  values,
                  createdAt: ref.createdAt,
                  updatedAt: at,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                ...pointerUnchanged,
                UpdateExpression: 'SET brewSk = :new',
                ExpressionAttributeValues: { ':old': ref.brewSk, ':new': newSk },
              },
            },
          ];
    const newShelfIndex = brewItems.length;
    const shelfItems: NonNullable<TransactWriteCommandInput['TransactItems']> =
      shelf.shelfEntryId === brew.shelfEntryId
        ? [{ ConditionCheck: this.#shelfUnchanged(shelf) }]
        : [{ Update: this.#countBrew(shelf, 1) }, { Update: this.#uncountBrew(user, brew.shelfEntryId) }];
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [...brewItems, ...shelfItems] }));
    } catch (error) {
      const failed = failedConditions(error);
      if (!failed?.length) throw error;
      if ((await this.#brewRef(user, brewId)) === undefined) throw new ItemNotFoundError('no such brew');
      if (failed.includes(newShelfIndex) && (await this.#shelfItem(user, values.shelf_entry_id)) === undefined) {
        throw new ShelfEntryNotFoundError('no such shelf entry');
      }
      throw new WriteConflictError('the brew or its shelf entry changed during the write');
    }
    return { brew_id: brewId, values };
  }

  /** Deletes a brew, its pointer and its count on the shelf entry, in one transaction. */
  public async deleteBrew(user: UserId, brewId: string): Promise<void> {
    const { ref, brew } = await this.#brewWithRef(user, brewId);
    await this.#transactOnExisting(
      [
        {
          Delete: {
            TableName: this.#table,
            Key: { pk: ref.pk, sk: ref.brewSk },
            ConditionExpression: 'attribute_exists(pk) AND shelfEntryId = :shelf',
            ExpressionAttributeValues: { ':shelf': brew.shelfEntryId },
          },
        },
        {
          Delete: {
            TableName: this.#table,
            Key: brewRefKey(user, brewId),
            ConditionExpression: 'brewSk = :sk',
            ExpressionAttributeValues: { ':sk': ref.brewSk },
          },
        },
        { Update: this.#uncountBrew(user, brew.shelfEntryId) },
      ],
      () => this.#brewRef(user, brewId),
    );
  }

  /** The caller's brews, newest `brewed_at` first. */
  public async listBrews(user: UserId, options: ListOptions = {}): Promise<Page<Brew>> {
    const pk = userPk(user);
    return this.#listUserItems(
      pk,
      PREFIX.brew,
      options,
      (sk) => parseBrewSortKey(sk) !== undefined,
      (item) => {
        const stored = storedItem(BrewItem, item, pk, 'brew');
        return { brew_id: stored.brewId, values: stored.values };
      },
    );
  }

  // ---- recipes ----

  public async createRecipe(user: UserId, input: RecipeInput): Promise<Recipe> {
    const values = validValues(RecipeInputSchema, input, 'recipe');
    const now = this.#now();
    const recipeId = this.#newId(now);
    const at = utcOf(now);
    await this.#create(recipeKey(user, recipeId), {
      type: ITEM_TYPE.recipe,
      recipeId,
      values,
      createdAt: at,
      updatedAt: at,
    });
    return { recipe_id: recipeId, values };
  }

  public async getRecipe(user: UserId, recipeId: string): Promise<Recipe | undefined> {
    const key = recipeKey(user, recipeId);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const stored = storedItem(RecipeItem, item, key.pk, 'recipe');
    return { recipe_id: stored.recipeId, values: stored.values };
  }

  public async replaceRecipe(user: UserId, recipeId: string, input: RecipeInput): Promise<Recipe> {
    const key = recipeKey(user, recipeId);
    const values = validValues(RecipeInputSchema, input, 'recipe');
    const item = await this.#update(key, { values, updatedAt: utcOf(this.#now()) });
    const stored = storedItem(RecipeItem, item, key.pk, 'recipe');
    return { recipe_id: stored.recipeId, values: stored.values };
  }

  public async deleteRecipe(user: UserId, recipeId: string): Promise<void> {
    await this.#delete(recipeKey(user, recipeId));
  }

  /** The caller's recipes, newest first. */
  public async listRecipes(user: UserId, options: ListOptions = {}): Promise<Page<Recipe>> {
    const pk = userPk(user);
    return this.#listUserItems(pk, PREFIX.recipe, options, (sk) => parseRecipeSortKey(sk) !== undefined, (item) => {
      const stored = storedItem(RecipeItem, item, pk, 'recipe');
      return { recipe_id: stored.recipeId, values: stored.values };
    });
  }

  // ---- bean catalogue (shared, not user-scoped) ----

  /**
   * Creates an unverified bean, in the review queue (`gsi1`). With a barcode, the
   * `BARCODE#` pointer is written in the same transaction; a barcode that already
   * points to a bean fails with BarcodeTakenError and writes nothing.
   */
  public async createBean(input: NewBean): Promise<BeanRecord> {
    const vocabularyVersion = validValues(VocabularyVersionSchema, input.vocabularyVersion, 'vocabulary version');
    const pickedAttributes = validValues(BeanAttributesSchema, input.pickedAttributes, 'bean attributes');
    // Stored and keyed in the canonical 13-digit form, so UPC-A and EAN-13 of one product collide.
    const barcode = input.barcode === undefined ? undefined : canonicalBarcodeValue(input.barcode);
    const openFoodFactsMatch = validValues(z.boolean(), input.openFoodFactsMatch, 'Open Food Facts match');
    const openFoodFacts =
      input.openFoodFacts === undefined ? undefined : validValues(OpenFoodFactsProductSchema, input.openFoodFacts, 'Open Food Facts product');
    // The group is the source tag of its text (D5, ODbL): it exists only on a bean from a confirmed hit.
    if (openFoodFacts !== undefined && (!openFoodFactsMatch || barcode === undefined)) {
      throw new InvalidValuesError('Open Food Facts data needs a confirmed match and a barcode');
    }
    const now = this.#now();
    const beanId = this.#newId(now);
    const key = beanMetaKey(beanId);
    const createdAt = utcOf(now);
    const item: BeanItemShape & Record<string, unknown> = {
      ...key,
      ...reviewQueueKey(now, beanId),
      type: ITEM_TYPE.bean,
      beanId,
      status: 'unverified',
      createdAt,
      updatedAt: createdAt,
      vocabularyVersion,
      openFoodFactsMatch,
      ...(openFoodFacts === undefined ? {} : { openFoodFacts }),
      pickedAttributes,
      operatorAttributes: {},
      ...(barcode === undefined ? {} : { barcode }),
    };
    if (barcode === undefined) {
      await this.#create(key, item);
      return beanOf(item);
    }
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.#table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
            {
              Put: {
                TableName: this.#table,
                Item: { ...barcodeKey(barcode), type: ITEM_TYPE.barcode, beanId, barcode, createdAt },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(1)) throw new BarcodeTakenError('barcode already points to a bean');
      if (failed?.length) throw new ItemExistsError('bean exists');
      throw error;
    }
    return beanOf(item);
  }

  public async getBean(beanId: string): Promise<BeanRecord | undefined> {
    const key = beanMetaKey(beanId);
    const item = await this.#get(key);
    return item === undefined ? undefined : beanOf(storedItem(BeanItem, item, key.pk, 'bean'));
  }

  /** The bean a barcode points to, or undefined for an unknown barcode. */
  public async findBeanIdByBarcode(barcode: string): Promise<string | undefined> {
    const key = barcodeKey(barcode);
    const item = await this.#get(key);
    return item === undefined ? undefined : storedItem(BarcodeItem, item, key.pk, 'barcode').beanId;
  }

  /**
   * The bean a barcode (EAN-13 or UPC-A, canonicalised) points to, whatever its
   * status, or undefined for an unknown barcode. Two consistent reads: the
   * `BARCODE#` pointer, then the bean. A pointer whose bean is missing or names
   * another barcode is CorruptItemError: beans are never deleted, and a pointer
   * is only written together with its bean.
   */
  public async getBeanByBarcode(barcode: string): Promise<BeanRecord | undefined> {
    const ean = canonicalBarcode(barcode);
    const beanId = await this.findBeanIdByBarcode(ean);
    if (beanId === undefined) return undefined;
    const record = await this.getBean(beanId);
    if (record?.bean.barcode !== ean) throw new CorruptItemError('barcode pointer names no bean with this barcode');
    return record;
  }

  // ---- Open Food Facts cache and the daily lookup cap (M1-T4b; docs/05, Barcode lookup) ----

  /**
   * The cached Open Food Facts result for a barcode (either form), or undefined
   * if there is none. A miss whose `expires_at` has passed is undefined too:
   * TTL deletes it some time later, so the read compares with the clock.
   */
  public async getOpenFoodFactsCache(barcode: string): Promise<OpenFoodFactsCacheEntry | undefined> {
    const key = openFoodFactsCacheKey(barcode);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    return this.#cacheEntryOf(storedItem(OpenFoodFactsCacheItem, item, key.pk, 'Open Food Facts cache entry'));
  }

  /**
   * Caches what a fetch found: a hit (cleaned name and brand, and the id of
   * the stored image copy, M1-T4c; at least one of the three) or a miss with
   * `expires_at` now plus OPEN_FOOD_FACTS_MISS_TTL_SECONDS. A hit is never
   * overwritten (it does not expire, and its image is copied once, before
   * this write): the put is conditional on no item or a miss, and if a hit is
   * already there, that hit is returned. So the answer is always what is
   * stored, even when two fetches of one barcode race; the losing fetch's
   * image object is then left unreferenced in the bucket.
   */
  public async cacheOpenFoodFactsResult(barcode: string, result: OpenFoodFactsCacheEntry): Promise<OpenFoodFactsCacheEntry> {
    const key = openFoodFactsCacheKey(barcode);
    const now = this.#now();
    const fetchedAt = utcOf(now);
    let item: Record<string, unknown>;
    if (result.kind === 'hit') {
      const product = validValues(OpenFoodFactsProductSchema, result.product, 'Open Food Facts product');
      if (product.name === undefined && product.brand === undefined && product.image_id === undefined) {
        throw new InvalidValuesError('an Open Food Facts hit needs a name, a brand or an image');
      }
      item = { ...key, type: ITEM_TYPE.openFoodFactsCache, result: 'hit', product, fetchedAt };
    } else {
      item = { ...key, type: ITEM_TYPE.openFoodFactsCache, result: 'miss', fetchedAt, expires_at: epochSeconds(now) + OPEN_FOOD_FACTS_MISS_TTL_SECONDS };
    }
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR #result = :miss',
          ExpressionAttributeNames: { '#result': 'result' },
          ExpressionAttributeValues: { ':miss': 'miss' },
        }),
      );
    } catch (error) {
      rethrowConflict(error);
      if (!isConditionFailure(error)) throw error;
      const stored = await this.getOpenFoodFactsCache(barcode);
      if (stored?.kind !== 'hit') throw new WriteConflictError('the Open Food Facts cache entry changed during the write');
      return stored;
    }
    const written = this.#cacheEntryOf(storedItem(OpenFoodFactsCacheItem, item, key.pk, 'Open Food Facts cache entry'));
    if (written === undefined) throw new CorruptItemError('a fresh miss is already expired');
    return written;
  }

  /**
   * Counts one Open Food Facts fetch against the caller's cap for the current
   * UTC day: one atomic update of `USER#<sub>` / `LOOKUPS#<day>`, `ADD lookups 1`
   * on the condition that the count is below `cap`. True if counted, false if
   * the cap is used up (nothing is written then). The item carries
   * `expires_at`, the start of its day plus LOOKUP_COUNTER_TTL_SECONDS.
   */
  public async countLookup(user: UserId, cap: number): Promise<boolean> {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new InvalidValuesError('invalid lookup cap');
    const now = this.#now();
    const day = utcOf(now).slice(0, 10);
    const key = lookupCounterKey(user, day);
    if (cap === 0) return false;
    const expiresAt = epochSeconds(new Date(`${day}T00:00:00.000Z`)) + LOOKUP_COUNTER_TTL_SECONDS;
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: key,
          UpdateExpression: 'SET #type = :type, expires_at = if_not_exists(expires_at, :expires) ADD lookups :one',
          ConditionExpression: 'attribute_not_exists(lookups) OR lookups < :cap',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':type': ITEM_TYPE.lookupCounter, ':expires': expiresAt, ':one': 1, ':cap': cap },
        }),
      );
      return true;
    } catch (error) {
      rethrowConflict(error);
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  #cacheEntryOf(item: z.infer<typeof OpenFoodFactsCacheItem>): OpenFoodFactsCacheEntry | undefined {
    if (item.result === 'hit') return { kind: 'hit', product: item.product };
    return item.expires_at > epochSeconds(this.#now()) ? { kind: 'miss' } : undefined;
  }

  /** The operator verifies an unverified bean: it leaves the review queue. Its barcode keeps pointing to it. */
  public async verifyBean(beanId: string, operatorAttributes?: BeanAttributes): Promise<BeanRecord> {
    const attributes =
      operatorAttributes === undefined ? undefined : validValues(BeanAttributesSchema, operatorAttributes, 'bean attributes');
    return this.#review(beanId, 'verified', attributes);
  }

  /**
   * The operator rejects an unverified bean: it leaves the review queue, and its
   * `BARCODE#` pointer is deleted in the same transaction (only while it still
   * names this bean), so the next scan of the barcode can submit a fresh entry.
   * The bean's `META` item stays, with status `rejected`, as the operator's
   * record; the API answers 404 for it.
   */
  public async rejectBean(beanId: string): Promise<BeanRecord> {
    return this.#review(beanId, 'rejected', undefined);
  }

  /** Unverified beans, oldest first, from the sparse index `gsi1`. */
  public async listReviewQueue(options: ListOptions = {}): Promise<Page<BeanRecord>> {
    const limit = limitOf(options);
    const input: QueryCommandInput = {
      TableName: this.#table,
      IndexName: REVIEW_QUEUE_INDEX.indexName,
      KeyConditionExpression: '#gpk = :queue',
      ExpressionAttributeNames: { '#gpk': REVIEW_QUEUE_INDEX.partitionKey },
      ExpressionAttributeValues: { ':queue': REVIEW_QUEUE_PK },
      ScanIndexForward: true,
      Limit: limit,
    };
    if (options.cursor !== undefined) {
      const gsi1sk = decodeCursor(options.cursor, (sk) => parseReviewQueueSortKey(sk) !== undefined);
      const parsed = parseReviewQueueSortKey(gsi1sk);
      if (parsed === undefined) throw new InvalidKeyError('invalid review queue position');
      input.ExclusiveStartKey = { ...beanMetaKey(parsed.beanId), gsi1pk: REVIEW_QUEUE_PK, gsi1sk };
    }
    const result = await this.#client.send(new QueryCommand(input));
    const items = (result.Items ?? []).map((item) => {
      const pk = z.object({ pk: z.string() }).safeParse(item);
      if (!pk.success || !pk.data.pk.startsWith(PREFIX.bean)) throw new CorruptItemError('review queue item is not a bean');
      const record = beanOf(storedItem(BeanItem, item, pk.data.pk, 'bean'));
      if (record.status !== 'unverified') throw new CorruptItemError('review queue holds a reviewed bean');
      return record;
    });
    const last = LastKey.safeParse(result.LastEvaluatedKey);
    return last.success && last.data.gsi1sk !== undefined
      ? { items, nextCursor: encodeCursor(last.data.gsi1sk) }
      : { items };
  }

  // ---- internals ----

  /** ConditionCheck: the bean is in the catalogue, whatever its status. */
  #beanExists(beanId: string): { TableName: string; Key: Key; ConditionExpression: string } {
    return { TableName: this.#table, Key: beanMetaKey(beanId), ConditionExpression: 'attribute_exists(pk)' };
  }

  /** ConditionCheck: the bean is in the catalogue and not rejected, so a shelf entry may newly name it (M1-T11). */
  #beanUsable(beanId: string): {
    TableName: string;
    Key: Key;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    return {
      TableName: this.#table,
      Key: beanMetaKey(beanId),
      ConditionExpression: 'attribute_exists(pk) AND #status <> :rejected',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':rejected': 'rejected' },
    };
  }

  async #shelfItem(user: UserId, shelfEntryId: string): Promise<z.infer<typeof ShelfItem> | undefined> {
    const key = shelfEntryKey(user, shelfEntryId);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const stored = storedItem(ShelfItem, item, key.pk, 'shelf entry');
    if (stored.sk !== key.sk || stored.shelfEntryId !== parseShelfSortKey(key.sk)) {
      throw new CorruptItemError('stored shelf entry does not match its key');
    }
    return stored;
  }

  /** Condition: the shelf entry exists and still names the bean that was read. */
  #shelfUnchanged(shelf: z.infer<typeof ShelfItem>): {
    TableName: string;
    Key: Key;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    return {
      TableName: this.#table,
      Key: { pk: shelf.pk, sk: shelf.sk },
      ConditionExpression: 'attribute_exists(pk) AND beanId = :bean',
      ExpressionAttributeValues: { ':bean': shelf.beanId },
    };
  }

  /** Update: one more brew references the shelf entry (atomic ADD; ADR 0012). */
  #countBrew(shelf: z.infer<typeof ShelfItem>, by: 1): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']> {
    const condition = this.#shelfUnchanged(shelf);
    return {
      ...condition,
      UpdateExpression: 'ADD brewCount :by',
      ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ':by': by },
    };
  }

  /** Update: one brew fewer references the shelf entry. Never creates the entry, never goes below 0. */
  #uncountBrew(user: UserId, shelfEntryId: string): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']> {
    return {
      TableName: this.#table,
      Key: shelfEntryKey(user, shelfEntryId),
      UpdateExpression: 'ADD brewCount :by',
      ConditionExpression: 'attribute_exists(pk) AND brewCount > :zero',
      ExpressionAttributeValues: { ':by': -1, ':zero': 0 },
    };
  }

  /** The pointer and the brew it names; ItemNotFoundError if either is gone. */
  async #brewWithRef(
    user: UserId,
    brewId: string,
  ): Promise<{ ref: z.infer<typeof BrewRefItem>; brew: z.infer<typeof BrewItem> }> {
    const ref = await this.#brewRef(user, brewId);
    if (ref === undefined) throw new ItemNotFoundError('no such brew');
    const item = await this.#get({ pk: ref.pk, sk: ref.brewSk });
    if (item === undefined) {
      // Deleted or moved between the two reads.
      if ((await this.#brewRef(user, brewId)) === undefined) throw new ItemNotFoundError('no such brew');
      throw new WriteConflictError('the brew moved during the read');
    }
    const brew = storedItem(BrewItem, item, ref.pk, 'brew');
    if (brew.brewId !== brewId) throw new CorruptItemError('stored brew does not match its pointer');
    return { ref, brew };
  }

  async #get(key: Key): Promise<unknown> {
    const result = await this.#client.send(new GetCommand({ TableName: this.#table, Key: key, ConsistentRead: true }));
    return result.Item;
  }

  async #create(key: Key, attributes: Record<string, unknown>): Promise<void> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#table,
          Item: { ...attributes, ...key },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new ItemExistsError('item exists');
      throw error;
    }
  }

  /** SET each attribute on an existing item; returns the item after the update. */
  async #update(key: Key, attributes: Record<string, unknown>): Promise<unknown> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = Object.entries(attributes).map(([name, value], index) => {
      names[`#a${String(index)}`] = name;
      values[`:v${String(index)}`] = value;
      return `#a${String(index)} = :v${String(index)}`;
    });
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: key,
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes;
    } catch (error) {
      if (isConditionFailure(error)) throw new ItemNotFoundError('no such item');
      throw error;
    }
  }

  async #delete(key: Key): Promise<void> {
    try {
      await this.#client.send(
        new DeleteCommand({ TableName: this.#table, Key: key, ConditionExpression: 'attribute_exists(pk)' }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new ItemNotFoundError('no such item');
      throw error;
    }
  }

  /** Runs a transaction on an item that existed; on a failed condition, tells "gone" from "raced". */
  async #transactOnExisting(
    transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
    stillThere: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (error) {
      if (!failedConditions(error)?.length) throw error;
      if ((await stillThere()) === undefined) throw new ItemNotFoundError('no such item');
      throw new WriteConflictError('the item changed during the write');
    }
  }

  async #brewRef(user: UserId, brewId: string): Promise<z.infer<typeof BrewRefItem> | undefined> {
    const key = brewRefKey(user, brewId);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const ref = storedItem(BrewRefItem, item, key.pk, 'brew pointer');
    const target = parseBrewSortKey(ref.brewSk);
    if (target?.brewId !== brewId || ref.brewId !== brewId) throw new CorruptItemError('brew pointer does not match its id');
    return ref;
  }

  async #listUserItems<T>(
    pk: string,
    prefix: string,
    options: ListOptions,
    isSortKey: (sk: string) => boolean,
    toRecord: (item: unknown) => T,
  ): Promise<Page<T>> {
    const limit = limitOf(options);
    const input: QueryCommandInput = {
      TableName: this.#table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: limit,
    };
    if (options.cursor !== undefined) {
      // Only the sort key comes from the cursor; the partition is always the caller's.
      input.ExclusiveStartKey = { pk, sk: decodeCursor(options.cursor, isSortKey) };
    }
    const result = await this.#client.send(new QueryCommand(input));
    const items = (result.Items ?? []).map(toRecord);
    const last = LastKey.safeParse(result.LastEvaluatedKey);
    return last.success ? { items, nextCursor: encodeCursor(last.data.sk) } : { items };
  }

  /**
   * Verifies or rejects an unverified bean. Reads it first: missing is
   * ItemNotFoundError, already reviewed BeanNotUnverifiedError. The update is
   * conditional on the bean still being unverified and removes both review
   * queue attributes in the same write.
   *
   * A reject also deletes the bean's `BARCODE#` pointer in the same
   * transaction, on the condition that it still names this bean. A pointer that
   * already names another bean (or none) is left alone, and the reject is the
   * single update. A pointer that changed between the read and the write
   * cancels the transaction with WriteConflictError, which is safe to repeat.
   * A write that met a concurrent transaction is WriteConflictError too.
   */
  async #review(beanId: string, status: 'verified' | 'rejected', operatorAttributes: BeanAttributes | undefined): Promise<BeanRecord> {
    const key = beanMetaKey(beanId);
    const current = await this.getBean(beanId);
    if (current === undefined) throw new ItemNotFoundError('no such bean');
    if (current.status !== 'unverified') throw new BeanNotUnverifiedError('bean is not unverified');

    const sets = ['#status = :status', 'updatedAt = :now'];
    const values: Record<string, unknown> = {
      ':status': status,
      ':unverified': 'unverified',
      ':now': utcOf(this.#now()),
    };
    if (operatorAttributes !== undefined) {
      sets.push('operatorAttributes = :attributes');
      values[':attributes'] = operatorAttributes;
    }
    const update = {
      TableName: this.#table,
      Key: key,
      // Both index attributes go in the same write: the bean leaves the queue atomically.
      UpdateExpression: `SET ${sets.join(', ')} REMOVE #gpk, #gsk`,
      ConditionExpression: 'attribute_exists(pk) AND #status = :unverified',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#gpk': REVIEW_QUEUE_INDEX.partitionKey,
        '#gsk': REVIEW_QUEUE_INDEX.sortKey,
      },
      ExpressionAttributeValues: values,
    };

    const barcode = current.bean.barcode;
    const freesBarcode = status === 'rejected' && barcode !== undefined && (await this.findBeanIdByBarcode(barcode)) === beanId;
    if (!freesBarcode) {
      try {
        const result = await this.#client.send(new UpdateCommand({ ...update, ReturnValues: 'ALL_NEW' }));
        return beanOf(storedItem(BeanItem, result.Attributes, key.pk, 'bean'));
      } catch (error) {
        rethrowConflict(error);
        if (!isConditionFailure(error)) throw error;
        throw await this.#reviewFailure(beanId);
      }
    }

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: update },
            {
              Delete: {
                TableName: this.#table,
                Key: barcodeKey(barcode),
                ConditionExpression: 'beanId = :bean',
                ExpressionAttributeValues: { ':bean': beanId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      rethrowConflict(error);
      const failed = failedConditions(error);
      if (!failed?.length) throw error;
      if (failed.includes(0)) throw await this.#reviewFailure(beanId);
      throw new WriteConflictError('the barcode pointer changed during the write', { cause: error });
    }
    // A transaction returns no item. Only status, updatedAt and the queue attributes changed.
    return { ...current, status: 'rejected' };
  }

  /** Why a review's condition failed: the bean is gone, or no longer unverified. */
  async #reviewFailure(beanId: string): Promise<Error> {
    return (await this.getBean(beanId)) === undefined
      ? new ItemNotFoundError('no such bean')
      : new BeanNotUnverifiedError('bean is not unverified');
  }
}
