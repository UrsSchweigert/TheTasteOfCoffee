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
// - Every write of a caller carries a ConditionCheck that the caller's
//   account tombstone (`DELETED#<sub>` / `META`) is not in force, in the same
//   transaction, so a token issued before the account was deleted cannot
//   recreate the partition (ADR 0017, Addendum). A failed check is
//   AccountDeletedError (API: 401). Single puts, updates and deletes of the
//   caller's items are transactions for that reason.
// - The aggregation pipeline (M3) is not here; keys.ts has its key builders.
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
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
  AccountDeletedError,
  BarcodeTakenError,
  BeanNotFoundError,
  BeanNotUnverifiedError,
  CorruptItemError,
  DeletionIncompleteError,
  InvalidKeyError,
  InvalidValuesError,
  ItemExistsError,
  ItemNotFoundError,
  LabelPhotoCapReachedError,
  LabelPhotoCompletedError,
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
  beanLabelPhotoKey,
  labelPhotoCountKey,
  labelPhotoKey,
  labelPhotoUploadCounterKey,
  lookupCounterKey,
  openFoodFactsCacheKey,
  pendingLabelPhotoKey,
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
  tombstoneKey,
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
  /** Wait before retrying unprocessed batch deletes, for tests. Default: setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  labelPhotoPending: 'PHOTO_PENDING',
  labelPhoto: 'LABEL_PHOTO',
  beanLabelPhoto: 'BEAN_LABEL_PHOTO',
  labelPhotoCount: 'BEAN_PHOTOS',
  labelPhotoUploads: 'PHOTO_UPLOADS',
  tombstone: 'ACCOUNT_TOMBSTONE',
} as const;

/**
 * How long a tombstone stays in force after the last DELETE /account call:
 * longer than any access token issued before the deletion can live (60
 * minutes; docs/05, Security). ADR 0017, Addendum.
 */
export const TOMBSTONE_TTL_SECONDS = 2 * 60 * 60;

/** BatchWriteItem takes at most 25 requests. */
export const BATCH_WRITE_SIZE = 25;
/**
 * Batches of deletes in flight at once. About 26,000 items (13,000 brews, the
 * export limit) are 1,040 batches; at 8 at a time and 20 to 40 ms each that is
 * about 3 to 5 s, inside the 10 s timeout (backend/README.md, Account deletion).
 */
export const BATCH_WRITE_CONCURRENCY = 8;
/** Attempts of one batch of deletes, the first one included, before unprocessed items fail the deletion. */
export const BATCH_WRITE_ATTEMPTS = 8;

/** The account tombstone (`DELETED#<sub>` / `META`), as account deletion uses it. */
export interface AccountTombstone {
  /** When the deletion that this tombstone belongs to began; fixed-width UTC. */
  readonly deletedAt: string;
  /** Photo ids whose label photo was deleted in full (D10), recorded before any of it was deleted. */
  readonly photoIds: readonly string[];
  /** True once the deletion log entry for this tombstone was written. */
  readonly logged: boolean;
}

/** A completed label photo of the caller (the user-side `PHOTO#` item). */
export interface LabelPhoto {
  readonly photoId: string;
  readonly beanId: string;
}

/** What account deletion must handle in S3 for a caller: completed and pending label photos. */
export interface AccountPhotos {
  readonly photos: readonly LabelPhoto[];
  readonly pendingPhotoIds: readonly string[];
}

/** Every exported item of a caller (GET /export), each kind sorted by ascending id. */
export interface ExportItems {
  readonly profile?: Profile;
  readonly shelfEntries: readonly ShelfEntry[];
  readonly brews: readonly Brew[];
  readonly recipes: readonly Recipe[];
  readonly labelPhotos: readonly LabelPhoto[];
}

/** Completed label photos per user and bean (docs/04 F1 step 4; ADR 0016). */
export const LABEL_PHOTOS_PER_BEAN = 3;
/** A pending label photo upload expires this long after it was started; the presigned POST itself lasts 10 minutes. */
export const PENDING_LABEL_PHOTO_TTL_SECONDS = 24 * 60 * 60;

/** A label photo upload the caller started and has not completed. */
export interface PendingLabelPhoto {
  readonly photoId: string;
  readonly beanId: string;
}

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
const PendingLabelPhotoItem = KeyAttributes.extend({ photoId: IdSchema, beanId: IdSchema, createdAt: z.string(), expires_at: EpochSeconds });
const LabelPhotoItem = KeyAttributes.extend({ photoId: IdSchema, beanId: IdSchema, createdAt: z.string() });
const LabelPhotoCountItem = KeyAttributes.extend({ beanId: IdSchema, photos: z.number().int().nonnegative() });
const LastKey = z.object({ pk: z.string(), sk: z.string(), gsi1sk: z.string().optional() });
const TombstoneItem = KeyAttributes.extend({
  deletedAt: z.string(),
  expires_at: EpochSeconds,
  photoIds: z.set(IdSchema).optional(),
  loggedAt: z.string().optional(),
});

type TransactItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

function byId<T>(id: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}

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
  readonly #sleep: (ms: number) => Promise<void>;

  public constructor(options: RepositoryOptions) {
    if (options.tableName === '') throw new InvalidValuesError('a table name is required');
    this.#client = options.client;
    this.#table = options.tableName;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? ((now) => newUlid(now.getTime()));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
   * Returns the stored values: the update sets exactly these.
   */
  public async putProfile(user: UserId, profile: Profile): Promise<Profile> {
    const key = profileKey(user);
    const values = validValues(ProfileSchema, profile, 'profile');
    const now = utcOf(this.#now());
    try {
      await this.#transactAs(user, [
        {
          Update: {
            TableName: this.#table,
            Key: key,
            UpdateExpression: 'SET #type = :type, #values = :values, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
            ExpressionAttributeNames: { '#type': 'type', '#values': 'values' },
            ExpressionAttributeValues: { ':type': ITEM_TYPE.profile, ':values': values, ':now': now },
          },
        },
      ]);
    } catch (error) {
      failedConditions(error);
      throw error;
    }
    return values;
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
      await this.#transactAs(user, [
        { ConditionCheck: this.#beanUsable(values.bean_id) },
        { Put: { TableName: this.#table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
      ]);
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
      await this.#transactAs(user, [
        { ConditionCheck: this.#beanUsable(values.bean_id) },
        {
          Update: this.#shelfReplaceUpdate(
            key,
            values,
            'attribute_exists(pk) AND (beanId = :bean OR attribute_not_exists(brewCount) OR brewCount = :zero)',
            { ':zero': 0 },
          ),
        },
      ]);
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
        await this.#replaceKeepingBean(user, key, values);
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
  async #replaceKeepingBean(user: UserId, key: Key, values: ShelfEntryInput): Promise<void> {
    try {
      await this.#transactAs(user, [
        { ConditionCheck: this.#beanExists(values.bean_id) },
        { Update: this.#shelfReplaceUpdate(key, values, 'attribute_exists(pk) AND beanId = :bean', {}) },
      ]);
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
      await this.#transactAs(user, [
        {
          Delete: {
            TableName: this.#table,
            Key: key,
            ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(brewCount) OR brewCount = :zero)',
            ExpressionAttributeValues: { ':zero': 0 },
          },
        },
      ]);
    } catch (error) {
      if (!failedConditions(error)?.length) throw error;
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
      await this.#transactAs(user, [
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
      ]);
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
    const brewItems: TransactItems =
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
    const shelfItems: TransactItems =
      shelf.shelfEntryId === brew.shelfEntryId
        ? [{ ConditionCheck: this.#shelfUnchanged(shelf) }]
        : [{ Update: this.#countBrew(shelf, 1) }, { Update: this.#uncountBrew(user, brew.shelfEntryId) }];
    try {
      await this.#transactAs(user, [...brewItems, ...shelfItems]);
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
      user,
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
    const key = recipeKey(user, recipeId);
    try {
      await this.#transactAs(user, [
        {
          Put: {
            TableName: this.#table,
            Item: { type: ITEM_TYPE.recipe, recipeId, values, createdAt: at, updatedAt: at, ...key },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ]);
    } catch (error) {
      if (failedConditions(error)?.length) throw new ItemExistsError('item exists');
      throw error;
    }
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
    try {
      await this.#transactAs(user, [
        {
          Update: {
            TableName: this.#table,
            Key: key,
            UpdateExpression: 'SET #values = :values, updatedAt = :now',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#values': 'values' },
            ExpressionAttributeValues: { ':values': values, ':now': utcOf(this.#now()) },
          },
        },
      ]);
    } catch (error) {
      if (failedConditions(error)?.length) throw new ItemNotFoundError('no such item');
      throw error;
    }
    // The update sets exactly these values; the id is the one in the key.
    return { recipe_id: parseRecipeSortKey(key.sk) ?? recipeId, values };
  }

  public async deleteRecipe(user: UserId, recipeId: string): Promise<void> {
    try {
      await this.#transactAs(user, [
        { Delete: { TableName: this.#table, Key: recipeKey(user, recipeId), ConditionExpression: 'attribute_exists(pk)' } },
      ]);
    } catch (error) {
      if (failedConditions(error)?.length) throw new ItemNotFoundError('no such item');
      throw error;
    }
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
   *
   * `caller`, the signed-in user who submits the bean (POST /beans), is used
   * only for the tombstone check in the same transaction (AccountDeletedError);
   * it is never stored on the bean. The API always passes it; operator tooling
   * and test setup may leave it out.
   */
  public async createBean(input: NewBean, caller?: UserId): Promise<BeanRecord> {
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
    const items: TransactItems = [{ Put: { TableName: this.#table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } }];
    if (barcode !== undefined) {
      items.push({
        Put: {
          TableName: this.#table,
          Item: { ...barcodeKey(barcode), type: ITEM_TYPE.barcode, beanId, barcode, createdAt },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }
    try {
      if (caller === undefined) await this.#client.send(new TransactWriteCommand({ TransactItems: items }));
      else await this.#transactAs(caller, items);
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
    const day = utcOf(this.#now()).slice(0, 10);
    return this.#countDaily(user, lookupCounterKey(user, day), day, 'lookups', ITEM_TYPE.lookupCounter, cap);
  }

  /**
   * One atomic `ADD <attribute> 1` on a per-user, per-UTC-day counter, on the
   * condition that it is below `cap`. True if counted, false if the cap is used
   * up (nothing is written then). `expires_at` is the start of the day plus
   * LOOKUP_COUNTER_TTL_SECONDS.
   */
  async #countDaily(user: UserId, key: Key, day: string, attribute: string, type: string, cap: number): Promise<boolean> {
    if (cap === 0) return false;
    const expiresAt = epochSeconds(new Date(`${day}T00:00:00.000Z`)) + LOOKUP_COUNTER_TTL_SECONDS;
    try {
      await this.#transactAs(user, [
        {
          Update: {
            TableName: this.#table,
            Key: key,
            UpdateExpression: 'SET #type = :type, expires_at = if_not_exists(expires_at, :expires) ADD #count :one',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :cap',
            ExpressionAttributeNames: { '#type': 'type', '#count': attribute },
            ExpressionAttributeValues: { ':type': type, ':expires': expiresAt, ':one': 1, ':cap': cap },
          },
        },
      ]);
      return true;
    } catch (error) {
      if (failedConditions(error)?.includes(0)) return false;
      throw error;
    }
  }

  // ---- label photos (M1-T4d; ADR 0016) ----

  /**
   * Counts one new label photo upload against the caller's cap for the current
   * UTC day (`USER#<sub>` / `PHOTO_UPLOADS#<day>`, attribute `uploads`), like
   * countLookup. True if counted, false if the cap is used up.
   */
  public async countLabelPhotoUpload(user: UserId, cap: number): Promise<boolean> {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new InvalidValuesError('invalid upload cap');
    const day = utcOf(this.#now()).slice(0, 10);
    return this.#countDaily(user, labelPhotoUploadCounterKey(user, day), day, 'uploads', ITEM_TYPE.labelPhotoUploads, cap);
  }

  /** How many label photos the caller has completed for the bean (`BEANPHOTOS#<beanId>`), 0 if none. */
  public async labelPhotoCount(user: UserId, beanId: string): Promise<number> {
    const key = labelPhotoCountKey(user, beanId);
    const item = await this.#get(key);
    if (item === undefined) return 0;
    const stored = storedItem(LabelPhotoCountItem, item, key.pk, 'label photo count');
    if (stored.sk !== key.sk || stored.beanId !== beanId) throw new CorruptItemError('stored label photo count does not match its key');
    return stored.photos;
  }

  /**
   * Starts a label photo upload: a new photo id and the caller's pending item
   * `USER#<sub>` / `PHOTO_PENDING#<photoId>` holding the bean id, with
   * `expires_at` PENDING_LABEL_PHOTO_TTL_SECONDS ahead. Returns the photo id.
   * Checks nothing about the bean; the API does that first.
   */
  public async createPendingLabelPhoto(user: UserId, beanId: string): Promise<string> {
    const bean = validValues(IdSchema, beanId, 'bean id');
    const now = this.#now();
    const photoId = this.#newId(now);
    const key = pendingLabelPhotoKey(user, photoId);
    const item = {
      type: ITEM_TYPE.labelPhotoPending,
      photoId,
      beanId: bean,
      createdAt: utcOf(now),
      expires_at: epochSeconds(now) + PENDING_LABEL_PHOTO_TTL_SECONDS,
      ...key,
    };
    try {
      await this.#transactAs(user, [{ Put: { TableName: this.#table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } }]);
    } catch (error) {
      if (failedConditions(error)?.length) throw new ItemExistsError('item exists');
      throw error;
    }
    return photoId;
  }

  /**
   * The caller's pending upload with this id, or undefined: none in the
   * caller's partition (so another user's photo id looks unknown), or past its
   * `expires_at` (TTL deletes it later).
   */
  public async getPendingLabelPhoto(user: UserId, photoId: string): Promise<PendingLabelPhoto | undefined> {
    const key = pendingLabelPhotoKey(user, photoId);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const stored = storedItem(PendingLabelPhotoItem, item, key.pk, 'pending label photo');
    if (stored.sk !== key.sk || stored.photoId !== photoId) throw new CorruptItemError('stored pending label photo does not match its key');
    if (stored.expires_at <= epochSeconds(this.#now())) return undefined;
    return { photoId: stored.photoId, beanId: stored.beanId };
  }

  /** Deletes the caller's pending upload, if there is one (a rejected photo). */
  public async discardPendingLabelPhoto(user: UserId, photoId: string): Promise<void> {
    await this.#client.send(new DeleteCommand({ TableName: this.#table, Key: pendingLabelPhotoKey(user, photoId) }));
  }

  /** True if the caller has a completed label photo with this id. */
  public async hasLabelPhoto(user: UserId, photoId: string): Promise<boolean> {
    const key = labelPhotoKey(user, photoId);
    const item = await this.#get(key);
    if (item === undefined) return false;
    storedItem(LabelPhotoItem, item, key.pk, 'label photo');
    return true;
  }

  /**
   * Records a stripped label photo, in one transaction:
   * 0. delete the caller's pending item, on the condition that it exists,
   *    names this bean and has not expired;
   * 1. put `USER#<sub>` / `PHOTO#<photoId>` {photoId, beanId, createdAt};
   * 2. put `BEAN#<beanId>` / `PHOTO#<photoId>` {photoId, createdAt}, no user id;
   * 3. `ADD photos 1` on `USER#<sub>` / `BEANPHOTOS#<beanId>`, on the condition
   *    that it is below LABEL_PHOTOS_PER_BEAN, so parallel completions cannot
   *    pass the cap;
   * 4. a ConditionCheck that the bean is still unverified.
   * Failures: pending gone and the photo recorded, or 1 or 2 already there, is
   * LabelPhotoCompletedError; pending gone otherwise ItemNotFoundError; the
   * bean not unverified BeanNotUnverifiedError; the cap
   * LabelPhotoCapReachedError; a concurrent transaction WriteConflictError.
   */
  public async completeLabelPhoto(user: UserId, photoId: string, beanId: string): Promise<void> {
    const pending = pendingLabelPhotoKey(user, photoId);
    const userPhoto = labelPhotoKey(user, photoId);
    const beanPhoto = beanLabelPhotoKey(beanId, photoId);
    const count = labelPhotoCountKey(user, beanId);
    const now = this.#now();
    const createdAt = utcOf(now);
    try {
      await this.#transactAs(user, [
        {
          Delete: {
            TableName: this.#table,
            Key: pending,
            ConditionExpression: 'attribute_exists(pk) AND beanId = :bean AND expires_at > :now',
            ExpressionAttributeValues: { ':bean': beanId, ':now': epochSeconds(now) },
          },
        },
        {
          Put: {
            TableName: this.#table,
            Item: { ...userPhoto, type: ITEM_TYPE.labelPhoto, photoId, beanId, createdAt },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.#table,
            Item: { ...beanPhoto, type: ITEM_TYPE.beanLabelPhoto, photoId, createdAt },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Update: {
            TableName: this.#table,
            Key: count,
            UpdateExpression: 'SET #type = :type, beanId = :bean ADD photos :one',
            ConditionExpression: 'attribute_not_exists(photos) OR photos < :cap',
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':type': ITEM_TYPE.labelPhotoCount, ':bean': beanId, ':one': 1, ':cap': LABEL_PHOTOS_PER_BEAN },
          },
        },
        {
          ConditionCheck: {
            TableName: this.#table,
            Key: beanMetaKey(beanId),
            ConditionExpression: 'attribute_exists(pk) AND #status = :unverified',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':unverified': 'unverified' },
          },
        },
      ]);
    } catch (error) {
      const failed = failedConditions(error);
      if (!failed?.length) throw error;
      if (failed.includes(0)) {
        if (await this.hasLabelPhoto(user, photoId)) throw new LabelPhotoCompletedError('label photo already completed');
        throw new ItemNotFoundError('no such pending label photo');
      }
      if (failed.includes(1) || failed.includes(2)) throw new LabelPhotoCompletedError('label photo already completed');
      if (failed.includes(4)) throw new BeanNotUnverifiedError('bean is not unverified');
      throw new LabelPhotoCapReachedError('label photo cap reached');
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

  // ---- export (GET /export; ADR 0017) ----

  /**
   * Every exported item of the caller: the profile, shelf entries, brews,
   * recipes and label photo links, read by sort key prefix with all pages and
   * strongly consistent. Counters, pending uploads and brew pointers are left
   * out (they are not the caller's data). Each kind is sorted by ascending id.
   */
  public async exportItems(user: UserId): Promise<ExportItems> {
    const pk = userPk(user);
    const of = async <T>(prefix: string, isSortKey: (sk: string) => boolean, map: (item: unknown) => T): Promise<T[]> =>
      (await this.#queryAll(pk, prefix)).map((item) => {
        const sk = typeof item.sk === 'string' ? item.sk : '';
        if (!isSortKey(sk)) throw new CorruptItemError('stored item does not match its sort key prefix');
        return map(item);
      });
    const [profile, shelfEntries, brews, recipes, labelPhotos] = await Promise.all([
      this.getProfile(user),
      of(PREFIX.shelf, (sk) => parseShelfSortKey(sk) !== undefined, (item) => {
        const stored = storedItem(ShelfItem, item, pk, 'shelf entry');
        return { shelf_entry_id: stored.shelfEntryId, values: stored.values };
      }),
      of(PREFIX.brew, (sk) => parseBrewSortKey(sk) !== undefined, (item) => {
        const stored = storedItem(BrewItem, item, pk, 'brew');
        return { brew_id: stored.brewId, values: stored.values };
      }),
      of(PREFIX.recipe, (sk) => parseRecipeSortKey(sk) !== undefined, (item) => {
        const stored = storedItem(RecipeItem, item, pk, 'recipe');
        return { recipe_id: stored.recipeId, values: stored.values };
      }),
      of(PREFIX.labelPhoto, (sk) => IdSchema.safeParse(sk.slice(PREFIX.labelPhoto.length)).success, (item) => {
        const stored = storedItem(LabelPhotoItem, item, pk, 'label photo');
        return { photoId: stored.photoId, beanId: stored.beanId };
      }),
    ]);
    return {
      ...(profile === undefined ? {} : { profile }),
      shelfEntries: shelfEntries.sort(byId((entry) => entry.shelf_entry_id)),
      brews: brews.sort(byId((brew) => brew.brew_id)),
      recipes: recipes.sort(byId((recipe) => recipe.recipe_id)),
      labelPhotos: labelPhotos.sort(byId((photo) => photo.photoId)),
    };
  }

  // ---- account deletion (DELETE /account; ADR 0017 and its Addendum) ----

  /**
   * True if the caller's tombstone is in force (strongly consistent read).
   * For a route that must refuse a deleted caller before it does work outside
   * the table; the write itself still carries the tombstone check.
   */
  public async isAccountDeleted(user: UserId): Promise<boolean> {
    return (await this.getAccountTombstone(user)) !== undefined;
  }

  /** The caller's tombstone if it is in force (strongly consistent read), else undefined. */
  public async getAccountTombstone(user: UserId): Promise<AccountTombstone | undefined> {
    const stored = await this.#tombstone(user);
    if (stored === undefined || stored.expires_at <= epochSeconds(this.#now())) return undefined;
    return { deletedAt: stored.deletedAt, photoIds: [...(stored.photoIds ?? [])].sort(), logged: stored.loggedAt !== undefined };
  }

  /**
   * Step 1 of account deletion: puts the tombstone `DELETED#<sub>` / `META`
   * with `expires_at` TOMBSTONE_TTL_SECONDS ahead. Idempotent: a tombstone in
   * force is kept, with its `deletedAt`, photo ids and log mark; only its
   * `expires_at` moves forward to now plus TOMBSTONE_TTL_SECONDS, so it still
   * outlives every token when a retry comes long after the first call. An
   * expired one is replaced by a fresh tombstone. Returns what is stored.
   */
  public async markAccountDeleted(user: UserId): Promise<AccountTombstone> {
    const key = tombstoneKey(user);
    const now = this.#now();
    const nowSeconds = epochSeconds(now);
    const expiresAt = nowSeconds + TOMBSTONE_TTL_SECONDS;
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#table,
          Item: { ...key, type: ITEM_TYPE.tombstone, deletedAt: utcOf(now), expires_at: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
          ExpressionAttributeValues: { ':now': nowSeconds },
        }),
      );
    } catch (error) {
      rethrowConflict(error);
      if (!isConditionFailure(error)) throw error;
      try {
        await this.#client.send(
          new UpdateCommand({
            TableName: this.#table,
            Key: key,
            UpdateExpression: 'SET expires_at = :expires',
            ConditionExpression: 'attribute_exists(pk) AND expires_at < :expires',
            ExpressionAttributeValues: { ':expires': expiresAt },
          }),
        );
      } catch (later) {
        rethrowConflict(later);
        // Already at or past the new expiry (two calls in one second): keep it.
        if (!isConditionFailure(later)) throw later;
      }
    }
    const stored = await this.#tombstone(user);
    if (stored === undefined) throw new CorruptItemError('the account tombstone is missing after its write');
    return { deletedAt: stored.deletedAt, photoIds: [...(stored.photoIds ?? [])].sort(), logged: stored.loggedAt !== undefined };
  }

  /**
   * Adds photo ids to the tombstone (a string set, ADD), before any part of
   * those photos is deleted: a retry after the user-side items are gone still
   * knows them for the deletion log. Needs the tombstone.
   */
  public async recordDeletedPhotos(user: UserId, photoIds: readonly string[]): Promise<void> {
    if (photoIds.length === 0) return;
    const ids = new Set(photoIds.map((photoId) => validValues(IdSchema, photoId, 'photo id')));
    await this.#client.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: tombstoneKey(user),
        UpdateExpression: 'ADD photoIds :ids',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':ids': ids },
      }),
    );
  }

  /** Marks the tombstone once the deletion log entry is written, so a retry does not write a second one. */
  public async markDeletionLogged(user: UserId): Promise<void> {
    await this.#client.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: tombstoneKey(user),
        UpdateExpression: 'SET loggedAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':now': utcOf(this.#now()) },
      }),
    );
  }

  /** The caller's completed label photos (`PHOTO#`) and pending uploads (`PHOTO_PENDING#`, expired ones too). */
  public async accountPhotos(user: UserId): Promise<AccountPhotos> {
    const pk = userPk(user);
    const [completed, pending] = await Promise.all([this.#queryAll(pk, PREFIX.labelPhoto), this.#queryAll(pk, PREFIX.labelPhotoPending)]);
    const photos = completed.map((item) => {
      const stored = storedItem(LabelPhotoItem, item, pk, 'label photo');
      if (stored.sk !== `${PREFIX.labelPhoto}${stored.photoId}`) throw new CorruptItemError('stored label photo does not match its key');
      return { photoId: stored.photoId, beanId: stored.beanId };
    });
    const pendingPhotoIds = pending.map((item) => {
      const stored = storedItem(PendingLabelPhotoItem, item, pk, 'pending label photo');
      if (stored.sk !== `${PREFIX.labelPhotoPending}${stored.photoId}`) throw new CorruptItemError('stored pending label photo does not match its key');
      return stored.photoId;
    });
    return { photos, pendingPhotoIds };
  }

  /** Deletes the bean's record of a label photo (`BEAN#<beanId>` / `PHOTO#<photoId>`); nothing if it is gone already. */
  public async deleteBeanLabelPhoto(beanId: string, photoId: string): Promise<void> {
    await this.#client.send(new DeleteCommand({ TableName: this.#table, Key: beanLabelPhotoKey(beanId, photoId) }));
  }

  /**
   * Deletes every item of `USER#<sub>`: all keys are read first (all pages,
   * strongly consistent), then deleted with BatchWriteItem in pages of
   * BATCH_WRITE_SIZE. Unprocessed items are sent again after an exponential
   * wait with jitter, up to BATCH_WRITE_ATTEMPTS times per page; any left
   * then is DeletionIncompleteError, and a repeat of the call finishes the
   * job. The tombstone must be in force first, so no write of the caller can
   * land after the read. Returns how many items were deleted.
   */
  public async deleteUserPartition(user: UserId): Promise<number> {
    const pk = userPk(user);
    const keys = (await this.#queryAll(pk, undefined, 'pk, sk')).map((item) => {
      const parsed = KeyAttributes.safeParse(item);
      // Defence in depth: never send a delete for a key outside the caller's partition.
      if (!parsed.success || parsed.data.pk !== pk) throw new CorruptItemError('stored item is outside the expected partition');
      return { pk: parsed.data.pk, sk: parsed.data.sk };
    });
    const pages: Key[][] = [];
    for (let index = 0; index < keys.length; index += BATCH_WRITE_SIZE) pages.push(keys.slice(index, index + BATCH_WRITE_SIZE));
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!failed && next < pages.length) {
        const page = pages[next] ?? [];
        next += 1;
        try {
          await this.#deleteBatch(pk, page);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_WRITE_CONCURRENCY, pages.length) }, worker));
    return keys.length;
  }

  /** One page of at most BATCH_WRITE_SIZE deletes, with its retries of unprocessed items. */
  async #deleteBatch(pk: string, page: readonly Key[]): Promise<void> {
    let requests = page.map((key) => ({ DeleteRequest: { Key: key } }));
    for (let attempt = 1; requests.length > 0; attempt += 1) {
      if (attempt > BATCH_WRITE_ATTEMPTS) throw new DeletionIncompleteError('items of the partition are left after retries');
      if (attempt > 1) await this.#sleep(Math.min(1000, 25 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
      const result = await this.#client.send(new BatchWriteCommand({ RequestItems: { [this.#table]: requests } }));
      requests = (result.UnprocessedItems?.[this.#table] ?? []).map((request) => {
        const key = KeyAttributes.safeParse(request.DeleteRequest?.Key);
        if (!key.success || key.data.pk !== pk) throw new CorruptItemError('an unprocessed delete is outside the expected partition');
        return { DeleteRequest: { Key: { pk: key.data.pk, sk: key.data.sk } } };
      });
    }
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

  /**
   * ConditionCheck: the caller's account tombstone is not in force. An expired
   * tombstone that TTL has not removed yet no longer blocks (ADR 0017,
   * Addendum): it outlived every token issued before the deletion.
   */
  #notDeleted(user: UserId): NonNullable<TransactItems[number]['ConditionCheck']> {
    return {
      TableName: this.#table,
      Key: tombstoneKey(user),
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
      ExpressionAttributeValues: { ':now': epochSeconds(this.#now()) },
    };
  }

  /**
   * One transaction of the caller's: `items`, then the tombstone check as the
   * last item, so the indices callers inspect on failure stay the same. A
   * failed tombstone check is AccountDeletedError; any other error is thrown
   * as it came.
   */
  async #transactAs(user: UserId, items: TransactItems): Promise<void> {
    const guard = items.length;
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [...items, { ConditionCheck: this.#notDeleted(user) }] }));
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.[guard]?.Code === 'ConditionalCheckFailed') {
        throw new AccountDeletedError('the account is deleted', { cause: error });
      }
      throw error;
    }
  }

  /** Every item of `pk` (with `prefix` on the sort key, if given), all pages, strongly consistent. */
  async #queryAll(pk: string, prefix: string | undefined, projection?: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const input: QueryCommandInput = {
        TableName: this.#table,
        KeyConditionExpression: prefix === undefined ? 'pk = :pk' : 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: prefix === undefined ? { ':pk': pk } : { ':pk': pk, ':prefix': prefix },
        ConsistentRead: true,
        ...(projection === undefined ? {} : { ProjectionExpression: projection }),
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      };
      const result = await this.#client.send(new QueryCommand(input));
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      start = result.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  async #tombstone(user: UserId): Promise<z.infer<typeof TombstoneItem> | undefined> {
    const key = tombstoneKey(user);
    const item = await this.#get(key);
    if (item === undefined) return undefined;
    const stored = storedItem(TombstoneItem, item, key.pk, 'account tombstone');
    if (stored.sk !== key.sk) throw new CorruptItemError('stored account tombstone does not match its key');
    return stored;
  }

  /** Runs a transaction on an item that existed; on a failed condition, tells "gone" from "raced". */
  async #transactOnExisting(user: UserId, transactItems: TransactItems, stillThere: () => Promise<unknown>): Promise<void> {
    try {
      await this.#transactAs(user, transactItems);
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
