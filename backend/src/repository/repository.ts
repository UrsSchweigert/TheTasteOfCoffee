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
// - The aggregation pipeline (M3) is not here; keys.ts has its key builders.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
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
  BeanNotUnverifiedError,
  CorruptItemError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  WriteConflictError,
} from './errors.ts';
import {
  PREFIX,
  REVIEW_QUEUE_PK,
  barcodeKey,
  beanMetaKey,
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
const ShelfItem = KeyAttributes.extend({ shelfEntryId: IdSchema, values: ShelfEntryInputSchema });
const BrewItem = KeyAttributes.extend({ brewId: IdSchema, values: BrewInputSchema });
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

function isConditionFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException;
}

/** Index of each item whose condition failed in a cancelled transaction; undefined if not a cancellation. */
function failedConditions(error: unknown): number[] | undefined {
  if (!(error instanceof TransactionCanceledException)) return undefined;
  const reasons = error.CancellationReasons ?? [];
  return reasons.flatMap((reason, index) => (reason.Code === 'ConditionalCheckFailed' ? [index] : []));
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
    await this.#create(key, {
      type: ITEM_TYPE.shelfEntry,
      shelfEntryId,
      beanId: values.bean_id,
      purchaseDate: values.purchase_date,
      values,
      createdAt: at,
      updatedAt: at,
    });
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
    const item = await this.#update(key, {
      beanId: values.bean_id,
      purchaseDate: values.purchase_date,
      values,
      updatedAt: utcOf(this.#now()),
    });
    const stored = storedItem(ShelfItem, item, key.pk, 'shelf entry');
    return { shelf_entry_id: stored.shelfEntryId, values: stored.values };
  }

  public async deleteShelfEntry(user: UserId, shelfEntryId: string): Promise<void> {
    await this.#delete(shelfEntryKey(user, shelfEntryId));
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

  public async createBrew(user: UserId, input: BrewInput): Promise<Brew> {
    const values = validValues(BrewInputSchema, input, 'brew');
    const now = this.#now();
    const brewId = this.#newId(now);
    const key = brewKey(user, values.brewed_at, brewId);
    const ref = brewRefKey(user, brewId);
    const at = utcOf(now);
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#table,
                Item: { ...key, type: ITEM_TYPE.brew, brewId, values, createdAt: at, updatedAt: at },
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
          ],
        }),
      );
    } catch (error) {
      if (failedConditions(error)?.length) throw new ItemExistsError('brew exists');
      throw error;
    }
    return { brew_id: brewId, values };
  }

  public async getBrew(user: UserId, brewId: string): Promise<Brew | undefined> {
    const ref = await this.#brewRef(user, brewId);
    if (ref === undefined) return undefined;
    const item = await this.#get({ pk: ref.pk, sk: ref.brewSk });
    if (item === undefined) return undefined;
    const stored = storedItem(BrewItem, item, ref.pk, 'brew');
    if (stored.brewId !== ref.brewId) throw new CorruptItemError('stored brew does not match its pointer');
    return { brew_id: stored.brewId, values: stored.values };
  }

  /**
   * Replaces a brew. When `brewed_at` moves, the brew item moves to its new sort
   * key in one transaction (delete old, put new, repoint), which the aggregator
   * sees as a remove and an insert: the correct difference.
   */
  public async replaceBrew(user: UserId, brewId: string, input: BrewInput): Promise<Brew> {
    const values = validValues(BrewInputSchema, input, 'brew');
    const ref = await this.#brewRef(user, brewId);
    if (ref === undefined) throw new ItemNotFoundError('no such brew');
    const refKey = brewRefKey(user, brewId);
    const newSk = brewSortKey(values.brewed_at, brewId);
    const at = utcOf(this.#now());
    const pointerUnchanged = {
      TableName: this.#table,
      Key: refKey,
      ConditionExpression: 'brewSk = :old',
      ExpressionAttributeValues: { ':old': ref.brewSk },
    };
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> =
      newSk === ref.brewSk
        ? [
            { ConditionCheck: pointerUnchanged },
            {
              Update: {
                TableName: this.#table,
                Key: { pk: ref.pk, sk: ref.brewSk },
                UpdateExpression: 'SET #values = :values, updatedAt = :now',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeNames: { '#values': 'values' },
                ExpressionAttributeValues: { ':values': values, ':now': at },
              },
            },
          ]
        : [
            {
              Delete: {
                TableName: this.#table,
                Key: { pk: ref.pk, sk: ref.brewSk },
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.#table,
                Item: { pk: ref.pk, sk: newSk, type: ITEM_TYPE.brew, brewId, values, createdAt: ref.createdAt, updatedAt: at },
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
    await this.#transactOnExisting(transactItems, () => this.#brewRef(user, brewId));
    return { brew_id: brewId, values };
  }

  public async deleteBrew(user: UserId, brewId: string): Promise<void> {
    const ref = await this.#brewRef(user, brewId);
    if (ref === undefined) throw new ItemNotFoundError('no such brew');
    await this.#transactOnExisting(
      [
        {
          Delete: {
            TableName: this.#table,
            Key: { pk: ref.pk, sk: ref.brewSk },
            ConditionExpression: 'attribute_exists(pk)',
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
    const barcode = input.barcode === undefined ? undefined : validValues(BarcodeSchema, input.barcode, 'barcode');
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
