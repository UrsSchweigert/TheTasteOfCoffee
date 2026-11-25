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
//   (`brewCount`, ADR 0012), so a shelf entry with brews cannot be deleted.
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
  readonly pickedAttributes: BeanAttributes;
}

/** Item types, stored in the `type` attribute so stream consumers can tell items apart. */
export const ITEM_TYPE = {
  profile: 'PROFILE',
  shelfEntry: 'SHELF',
  brew: 'BREW',
  brewRef: 'BREW_REF',
  recipe: 'RECIPE',
  bean: 'BEAN',
  barcode: 'BARCODE',
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
  pickedAttributes: BeanAttributesSchema,
  operatorAttributes: BeanAttributesSchema,
});
const BarcodeItem = KeyAttributes.extend({ beanId: IdSchema });
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
            { ConditionCheck: this.#beanExists(values.bean_id) },
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

  public async replaceShelfEntry(user: UserId, shelfEntryId: string, input: ShelfEntryInput): Promise<ShelfEntry> {
    const key = shelfEntryKey(user, shelfEntryId);
    const values = validValues(ShelfEntryInputSchema, input, 'shelf entry');
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: this.#beanExists(values.bean_id) },
            {
              Update: {
                TableName: this.#table,
                Key: key,
                UpdateExpression: 'SET beanId = :bean, purchaseDate = :date, #values = :values, updatedAt = :now',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeNames: { '#values': 'values' },
                ExpressionAttributeValues: {
                  ':bean': values.bean_id,
                  ':date': values.purchase_date,
                  ':values': values,
                  ':now': utcOf(this.#now()),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (failed?.includes(1)) throw new ItemNotFoundError('no such shelf entry');
      if (failed?.includes(0)) throw new BeanNotFoundError('no such bean');
      throw error;
    }
    return { shelf_entry_id: parseShelfSortKey(key.sk) ?? shelfEntryId, values };
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

  /** The operator verifies an unverified bean: it leaves the review queue. */
  public async verifyBean(beanId: string, operatorAttributes?: BeanAttributes): Promise<BeanRecord> {
    const attributes =
      operatorAttributes === undefined ? undefined : validValues(BeanAttributesSchema, operatorAttributes, 'bean attributes');
    return this.#review(beanId, 'verified', attributes);
  }

  /** The operator rejects an unverified bean: it leaves the review queue and stays unverified to users. */
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

  /** ConditionCheck: the bean is in the catalogue. */
  #beanExists(beanId: string): { TableName: string; Key: Key; ConditionExpression: string } {
    return { TableName: this.#table, Key: beanMetaKey(beanId), ConditionExpression: 'attribute_exists(pk)' };
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

  async #review(beanId: string, status: 'verified' | 'rejected', operatorAttributes: BeanAttributes | undefined): Promise<BeanRecord> {
    const key = beanMetaKey(beanId);
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
    try {
      const result = await this.#client.send(
        new UpdateCommand({
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
          ReturnValues: 'ALL_NEW',
        }),
      );
      return beanOf(storedItem(BeanItem, result.Attributes, key.pk, 'bean'));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      if ((await this.getBean(beanId)) === undefined) throw new ItemNotFoundError('no such bean');
      throw new BeanNotUnverifiedError('bean is not unverified');
    }
  }
}
