// An in-memory stand-in for the repository, for the API unit tests. It keeps
// the repository's observable rules: one partition per UserId, newest first,
// the repository's own cursor format (base64url sort key, checked on use),
// references (a shelf entry needs a known bean, a brew needs the caller's
// shelf entry; a rejected bean may stay on an entry but not be newly put on one) and the 409 on deleting a shelf entry that brews reference or
// changing its bean (D14); the shared bean catalogue with its barcode
// pointers (canonical EAN-13, one bean per barcode, a reject frees the barcode);
// the Open Food Facts cache (a hit is never overwritten, a miss expires) and
// the per-user daily lookup counter with its cap; the label photo items
// (pending uploads with their expiry, completed photos in the user and bean
// partitions, the per-bean count with its cap of 3, the daily upload counter)
// and the completion's all-or-nothing conditions; the profile; the export
// read; the account tombstone, which makes every write of a deleted caller
// fail with AccountDeletedError and nothing written; and the deletion steps.
// The real repository is tested against DynamoDB Local.
import type { UserId } from '../../src/auth/user-id.ts';
import type { Brew, BrewInput, Profile, Recipe, RecipeInput, ShelfEntry, ShelfEntryInput } from '../../src/generated/contract.ts';
import type { ApiStore } from '../../src/api/resources.ts';
import { newUlid } from '../../src/ids/ulid.ts';
import {
  BarcodeTakenError,
  BeanNotFoundError,
  BeanNotUnverifiedError,
  beanMetaKey,
  canonicalBarcode,
  ItemNotFoundError,
  ShelfEntryBeanLockedError,
  ShelfEntryInUseError,
  ShelfEntryNotFoundError,
  brewSortKey,
  decodeCursor,
  encodeCursor,
  parseBrewSortKey,
  parseRecipeSortKey,
  parseShelfSortKey,
  recipeKey,
  shelfEntryKey,
  userPk,
} from '../../src/repository/index.ts';
import type { BeanRecord, ListOptions, NewBean, OpenFoodFactsCacheEntry, Page } from '../../src/repository/index.ts';
import { InvalidValuesError, OPEN_FOOD_FACTS_MISS_TTL_SECONDS, lookupCounterKey, openFoodFactsCacheKey } from '../../src/repository/index.ts';
import {
  LABEL_PHOTOS_PER_BEAN,
  LabelPhotoCapReachedError,
  LabelPhotoCompletedError,
  PENDING_LABEL_PHOTO_TTL_SECONDS,
  beanLabelPhotoKey,
  labelPhotoCountKey,
  labelPhotoKey,
  labelPhotoUploadCounterKey,
  pendingLabelPhotoKey,
} from '../../src/repository/index.ts';
import type { PendingLabelPhoto } from '../../src/repository/index.ts';
import { AccountDeletedError, TOMBSTONE_TTL_SECONDS } from '../../src/repository/index.ts';
import type { AccountPhotos, AccountTombstone, ExportItems } from '../../src/repository/index.ts';

interface Partition {
  readonly shelf: Map<string, ShelfEntry>;
  readonly brews: Map<string, Brew>;
  readonly recipes: Map<string, Recipe>;
}

function keyId(key: { pk: string; sk: string }): string {
  return `${key.pk}|${key.sk}`;
}

function page<T>(sorted: { sk: string; item: T }[], options: ListOptions, isSortKey: (sk: string) => boolean): Page<T> {
  const limit = options.limit ?? 50;
  // Newest first, as the repository queries in reverse.
  sorted.sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0));
  const start = options.cursor === undefined ? undefined : decodeCursor(options.cursor, isSortKey);
  const rest = start === undefined ? sorted : sorted.filter((entry) => entry.sk < start);
  const items = rest.slice(0, limit);
  const last = items.at(-1);
  return rest.length > limit && last !== undefined ? { items: items.map((e) => e.item), nextCursor: encodeCursor(last.sk) } : { items: items.map((e) => e.item) };
}

export class FakeStore implements ApiStore {
  /** Bean ids a shelf entry may reference. createBean adds to it; tests may add ids directly. */
  public readonly beans = new Set<string>();
  /** The catalogue: bean id to record. */
  public readonly catalogue = new Map<string, BeanRecord>();
  /** `BARCODE#` pointers: canonical EAN-13 to bean id. */
  public readonly barcodes = new Map<string, string>();
  readonly #partitions = new Map<string, Partition>();
  /** The Open Food Facts cache: canonical EAN-13 to entry (a miss with its expiry in epoch seconds). */
  public readonly openFoodFactsCache = new Map<string, { entry: OpenFoodFactsCacheEntry; expiresAt?: number }>();
  /** Lookup counters by `pk|sk` of the counter key. */
  public readonly lookupCounters = new Map<string, number>();
  /** Label photo items by `pk|sk`. */
  public readonly pendingPhotos = new Map<string, { beanId: string; expiresAt: number }>();
  public readonly userPhotos = new Map<string, { beanId: string; createdAt: string }>();
  public readonly beanPhotos = new Map<string, { createdAt: string }>();
  public readonly photoCounts = new Map<string, number>();
  public readonly uploadCounters = new Map<string, number>();
  /** Photo ids to hand out first, for tests; then fresh ULIDs. */
  public readonly photoIds: string[] = [];
  /** If set, completeLabelPhoto fails with it (a transaction failure after the S3 write). */
  public failComplete: Error | undefined;
  /** The clock for cache expiry and counter days; tests move it. */
  public now = new Date('2026-11-25T12:00:00.000Z');
  /** Every call, by method name, for assertions. */
  public readonly calls: string[] = [];
  /** Profiles by user partition key. */
  public readonly profiles = new Map<string, Profile>();
  /** Account tombstones by user partition key (the repository keeps them under `DELETED#<sub>`). */
  public readonly tombstones = new Map<string, { deletedAt: string; expiresAt: number; photoIds: Set<string>; logged: boolean }>();
  /** Ids are made one millisecond apart, so newest first is deterministic. */
  #clock = Date.UTC(2026, 10, 1);

  #newId(): string {
    this.#clock += 1;
    return newUlid(this.#clock);
  }

  #seconds(): number {
    return Math.floor(this.now.getTime() / 1000);
  }

  /** Like the repository's tombstone ConditionCheck: a tombstone in force refuses the write, and nothing is written. */
  #guard(user: UserId): void {
    const tombstone = this.tombstones.get(userPk(user));
    if (tombstone !== undefined && tombstone.expiresAt > this.#seconds()) throw new AccountDeletedError('the account is deleted');
  }

  /** Runs a write of the caller under the tombstone guard, as a promise. */
  async #write<T>(user: UserId, write: () => Promise<T>): Promise<T> {
    this.#guard(user);
    return write();
  }

  #of(user: UserId): Partition {
    const pk = userPk(user); // throws for anything but a real UserId, like the repository
    let partition = this.#partitions.get(pk);
    if (partition === undefined) {
      partition = { shelf: new Map(), brews: new Map(), recipes: new Map() };
      this.#partitions.set(pk, partition);
    }
    return partition;
  }

  /** A deep copy of one user's items, to prove a request changed nothing. */
  public snapshot(user: UserId): unknown {
    const p = this.#of(user);
    return structuredClone({ shelf: [...p.shelf], brews: [...p.brews], recipes: [...p.recipes] });
  }

  #brewCount(p: Partition, shelfEntryId: string): number {
    return [...p.brews.values()].filter((brew) => brew.values.shelf_entry_id === shelfEntryId).length;
  }

  public listShelfEntries(user: UserId, options: ListOptions = {}): Promise<Page<ShelfEntry>> {
    this.calls.push('listShelfEntries');
    const entries = [...this.#of(user).shelf.values()].map((item) => ({ sk: shelfEntryKey(user, item.shelf_entry_id).sk, item }));
    return Promise.resolve(page(entries, options, (sk) => parseShelfSortKey(sk) !== undefined));
  }

  public createShelfEntry(user: UserId, input: ShelfEntryInput): Promise<ShelfEntry> {
    this.calls.push('createShelfEntry');
    return this.#write(user, () => this.#createShelfEntry(user, input));
  }

  #createShelfEntry(user: UserId, input: ShelfEntryInput): Promise<ShelfEntry> {
    if (!this.#beanUsable(input.bean_id)) return Promise.reject(new BeanNotFoundError('no such bean'));
    const entry = { shelf_entry_id: this.#newId(), values: structuredClone(input) };
    this.#of(user).shelf.set(entry.shelf_entry_id, entry);
    return Promise.resolve(structuredClone(entry));
  }

  public getShelfEntry(user: UserId, id: string): Promise<ShelfEntry | undefined> {
    this.calls.push('getShelfEntry');
    shelfEntryKey(user, id);
    return Promise.resolve(structuredClone(this.#of(user).shelf.get(id)));
  }

  public replaceShelfEntry(user: UserId, id: string, input: ShelfEntryInput): Promise<ShelfEntry> {
    this.calls.push('replaceShelfEntry');
    return this.#write(user, () => this.#replaceShelfEntry(user, id, input));
  }

  #replaceShelfEntry(user: UserId, id: string, input: ShelfEntryInput): Promise<ShelfEntry> {
    const p = this.#of(user);
    if (!p.shelf.has(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    const keepsBean = p.shelf.get(id)?.values.bean_id === input.bean_id;
    if (!(keepsBean ? this.beans.has(input.bean_id) : this.#beanUsable(input.bean_id))) {
      return Promise.reject(new BeanNotFoundError('no such bean'));
    }
    if (p.shelf.get(id)?.values.bean_id !== input.bean_id && this.#brewCount(p, id) > 0) {
      return Promise.reject(new ShelfEntryBeanLockedError('bean locked'));
    }
    const entry = { shelf_entry_id: id, values: structuredClone(input) };
    p.shelf.set(id, entry);
    return Promise.resolve(structuredClone(entry));
  }

  public deleteShelfEntry(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteShelfEntry');
    return this.#write(user, () => this.#deleteShelfEntry(user, id));
  }

  #deleteShelfEntry(user: UserId, id: string): Promise<void> {
    const p = this.#of(user);
    if (!p.shelf.has(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    if (this.#brewCount(p, id) > 0) return Promise.reject(new ShelfEntryInUseError('in use'));
    p.shelf.delete(id);
    return Promise.resolve();
  }

  public listBrews(user: UserId, options: ListOptions = {}): Promise<Page<Brew>> {
    this.calls.push('listBrews');
    const entries = [...this.#of(user).brews.values()].map((item) => ({ sk: brewSortKey(item.values.brewed_at, item.brew_id), item }));
    return Promise.resolve(page(entries, options, (sk) => parseBrewSortKey(sk) !== undefined));
  }

  public createBrew(user: UserId, input: BrewInput): Promise<Brew> {
    this.calls.push('createBrew');
    return this.#write(user, () => this.#createBrew(user, input));
  }

  #createBrew(user: UserId, input: BrewInput): Promise<Brew> {
    const p = this.#of(user);
    if (!p.shelf.has(input.shelf_entry_id)) return Promise.reject(new ShelfEntryNotFoundError('no such shelf entry'));
    const brew = { brew_id: this.#newId(), values: structuredClone(input) };
    p.brews.set(brew.brew_id, brew);
    return Promise.resolve(structuredClone(brew));
  }

  public getBrew(user: UserId, id: string): Promise<Brew | undefined> {
    this.calls.push('getBrew');
    return Promise.resolve(structuredClone(this.#of(user).brews.get(id)));
  }

  public replaceBrew(user: UserId, id: string, input: BrewInput): Promise<Brew> {
    this.calls.push('replaceBrew');
    return this.#write(user, () => this.#replaceBrew(user, id, input));
  }

  #replaceBrew(user: UserId, id: string, input: BrewInput): Promise<Brew> {
    const p = this.#of(user);
    if (!p.brews.has(id)) return Promise.reject(new ItemNotFoundError('no such brew'));
    if (!p.shelf.has(input.shelf_entry_id)) return Promise.reject(new ShelfEntryNotFoundError('no such shelf entry'));
    const brew = { brew_id: id, values: structuredClone(input) };
    p.brews.set(id, brew);
    return Promise.resolve(structuredClone(brew));
  }

  public deleteBrew(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteBrew');
    return this.#write(user, () => this.#deleteBrew(user, id));
  }

  #deleteBrew(user: UserId, id: string): Promise<void> {
    const p = this.#of(user);
    if (!p.brews.delete(id)) return Promise.reject(new ItemNotFoundError('no such brew'));
    return Promise.resolve();
  }

  public listRecipes(user: UserId, options: ListOptions = {}): Promise<Page<Recipe>> {
    this.calls.push('listRecipes');
    const entries = [...this.#of(user).recipes.values()].map((item) => ({ sk: recipeKey(user, item.recipe_id).sk, item }));
    return Promise.resolve(page(entries, options, (sk) => parseRecipeSortKey(sk) !== undefined));
  }

  public createRecipe(user: UserId, input: RecipeInput): Promise<Recipe> {
    this.calls.push('createRecipe');
    return this.#write(user, () => this.#createRecipe(user, input));
  }

  #createRecipe(user: UserId, input: RecipeInput): Promise<Recipe> {
    const recipe = { recipe_id: this.#newId(), values: structuredClone(input) };
    this.#of(user).recipes.set(recipe.recipe_id, recipe);
    return Promise.resolve(structuredClone(recipe));
  }

  public getRecipe(user: UserId, id: string): Promise<Recipe | undefined> {
    this.calls.push('getRecipe');
    return Promise.resolve(structuredClone(this.#of(user).recipes.get(id)));
  }

  public replaceRecipe(user: UserId, id: string, input: RecipeInput): Promise<Recipe> {
    this.calls.push('replaceRecipe');
    return this.#write(user, () => this.#replaceRecipe(user, id, input));
  }

  #replaceRecipe(user: UserId, id: string, input: RecipeInput): Promise<Recipe> {
    const p = this.#of(user);
    if (!p.recipes.has(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    const recipe = { recipe_id: id, values: structuredClone(input) };
    p.recipes.set(id, recipe);
    return Promise.resolve(structuredClone(recipe));
  }

  public deleteRecipe(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteRecipe');
    return this.#write(user, () => this.#deleteRecipe(user, id));
  }

  #deleteRecipe(user: UserId, id: string): Promise<void> {
    if (!this.#of(user).recipes.delete(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    return Promise.resolve();
  }

  public createBean(input: NewBean, caller?: UserId): Promise<BeanRecord> {
    this.calls.push('createBean');
    if (caller !== undefined && (this.tombstones.get(userPk(caller))?.expiresAt ?? 0) > this.#seconds()) {
      return Promise.reject(new AccountDeletedError('the account is deleted'));
    }
    const barcode = input.barcode === undefined ? undefined : canonicalBarcode(input.barcode);
    if (barcode !== undefined && this.barcodes.has(barcode)) return Promise.reject(new BarcodeTakenError('barcode taken'));
    const beanId = this.#newId();
    const record: BeanRecord = {
      bean: {
        bean_id: beanId,
        vocabulary_version: input.vocabularyVersion,
        verified: false,
        open_food_facts_match: input.openFoodFactsMatch,
        ...(input.openFoodFacts === undefined ? {} : { open_food_facts: structuredClone(input.openFoodFacts) }),
        picked_attributes: structuredClone(input.pickedAttributes),
        operator_attributes: {},
        ...(barcode === undefined ? {} : { barcode }),
      },
      status: 'unverified',
      createdAt: new Date(this.#clock).toISOString(),
    };
    this.catalogue.set(beanId, record);
    this.beans.add(beanId);
    if (barcode !== undefined) this.barcodes.set(barcode, beanId);
    return Promise.resolve(structuredClone(record));
  }

  public getBean(beanId: string): Promise<BeanRecord | undefined> {
    this.calls.push('getBean');
    beanMetaKey(beanId); // throws for a bad id, like the repository
    return Promise.resolve(structuredClone(this.catalogue.get(beanId)));
  }

  public getBeanByBarcode(barcode: string): Promise<BeanRecord | undefined> {
    this.calls.push('getBeanByBarcode');
    const beanId = this.barcodes.get(canonicalBarcode(barcode));
    return Promise.resolve(beanId === undefined ? undefined : structuredClone(this.catalogue.get(beanId)));
  }

  public getOpenFoodFactsCache(barcode: string): Promise<OpenFoodFactsCacheEntry | undefined> {
    this.calls.push('getOpenFoodFactsCache');
    openFoodFactsCacheKey(barcode);
    const stored = this.openFoodFactsCache.get(canonicalBarcode(barcode));
    if (stored === undefined) return Promise.resolve(undefined);
    if (stored.expiresAt !== undefined && stored.expiresAt <= Math.floor(this.now.getTime() / 1000)) return Promise.resolve(undefined);
    return Promise.resolve(structuredClone(stored.entry));
  }

  public cacheOpenFoodFactsResult(barcode: string, result: OpenFoodFactsCacheEntry): Promise<OpenFoodFactsCacheEntry> {
    this.calls.push('cacheOpenFoodFactsResult');
    const ean = canonicalBarcode(barcode);
    const existing = this.openFoodFactsCache.get(ean);
    if (existing?.entry.kind === 'hit') return Promise.resolve(structuredClone(existing.entry));
    const expiresAt = result.kind === 'miss' ? Math.floor(this.now.getTime() / 1000) + OPEN_FOOD_FACTS_MISS_TTL_SECONDS : undefined;
    this.openFoodFactsCache.set(ean, { entry: structuredClone(result), ...(expiresAt === undefined ? {} : { expiresAt }) });
    return Promise.resolve(structuredClone(result));
  }

  public countLookup(user: UserId, cap: number): Promise<boolean> {
    this.calls.push('countLookup');
    return this.#write(user, () => this.#countLookup(user, cap));
  }

  #countLookup(user: UserId, cap: number): Promise<boolean> {
    if (!Number.isSafeInteger(cap) || cap < 0) return Promise.reject(new InvalidValuesError('invalid lookup cap'));
    const key = lookupCounterKey(user, this.now.toISOString().slice(0, 10));
    const id = `${key.pk}|${key.sk}`;
    const count = this.lookupCounters.get(id) ?? 0;
    if (count >= cap) return Promise.resolve(false);
    this.lookupCounters.set(id, count + 1);
    return Promise.resolve(true);
  }

  // ---- label photos (M1-T4d) ----

  public countLabelPhotoUpload(user: UserId, cap: number): Promise<boolean> {
    this.calls.push('countLabelPhotoUpload');
    return this.#write(user, () => this.#countLabelPhotoUpload(user, cap));
  }

  #countLabelPhotoUpload(user: UserId, cap: number): Promise<boolean> {
    if (!Number.isSafeInteger(cap) || cap < 0) return Promise.reject(new InvalidValuesError('invalid upload cap'));
    const id = keyId(labelPhotoUploadCounterKey(user, this.now.toISOString().slice(0, 10)));
    const count = this.uploadCounters.get(id) ?? 0;
    if (count >= cap) return Promise.resolve(false);
    this.uploadCounters.set(id, count + 1);
    return Promise.resolve(true);
  }

  public labelPhotoCount(user: UserId, beanId: string): Promise<number> {
    this.calls.push('labelPhotoCount');
    return Promise.resolve(this.photoCounts.get(keyId(labelPhotoCountKey(user, beanId))) ?? 0);
  }

  public createPendingLabelPhoto(user: UserId, beanId: string): Promise<string> {
    this.calls.push('createPendingLabelPhoto');
    return this.#write(user, () => this.#createPendingLabelPhoto(user, beanId));
  }

  #createPendingLabelPhoto(user: UserId, beanId: string): Promise<string> {
    const photoId = this.photoIds.shift() ?? this.#newId();
    this.pendingPhotos.set(keyId(pendingLabelPhotoKey(user, photoId)), {
      beanId,
      expiresAt: Math.floor(this.now.getTime() / 1000) + PENDING_LABEL_PHOTO_TTL_SECONDS,
    });
    return Promise.resolve(photoId);
  }

  public getPendingLabelPhoto(user: UserId, photoId: string): Promise<PendingLabelPhoto | undefined> {
    this.calls.push('getPendingLabelPhoto');
    const pending = this.pendingPhotos.get(keyId(pendingLabelPhotoKey(user, photoId)));
    if (pending === undefined || pending.expiresAt <= Math.floor(this.now.getTime() / 1000)) return Promise.resolve(undefined);
    return Promise.resolve({ photoId, beanId: pending.beanId });
  }

  public discardPendingLabelPhoto(user: UserId, photoId: string): Promise<void> {
    this.calls.push('discardPendingLabelPhoto');
    this.pendingPhotos.delete(keyId(pendingLabelPhotoKey(user, photoId)));
    return Promise.resolve();
  }

  public hasLabelPhoto(user: UserId, photoId: string): Promise<boolean> {
    this.calls.push('hasLabelPhoto');
    return Promise.resolve(this.userPhotos.has(keyId(labelPhotoKey(user, photoId))));
  }

  public completeLabelPhoto(user: UserId, photoId: string, beanId: string): Promise<void> {
    this.calls.push('completeLabelPhoto');
    return this.#write(user, () => this.#completeLabelPhoto(user, photoId, beanId));
  }

  #completeLabelPhoto(user: UserId, photoId: string, beanId: string): Promise<void> {
    if (this.failComplete !== undefined) return Promise.reject(this.failComplete);
    const pendingId = keyId(pendingLabelPhotoKey(user, photoId));
    const userId = keyId(labelPhotoKey(user, photoId));
    const beanPhotoId = keyId(beanLabelPhotoKey(beanId, photoId));
    const countId = keyId(labelPhotoCountKey(user, beanId));
    const pending = this.pendingPhotos.get(pendingId);
    if (pending?.beanId !== beanId || pending.expiresAt <= Math.floor(this.now.getTime() / 1000)) {
      return Promise.reject(this.userPhotos.has(userId) ? new LabelPhotoCompletedError('completed') : new ItemNotFoundError('no such pending'));
    }
    if (this.userPhotos.has(userId) || this.beanPhotos.has(beanPhotoId)) return Promise.reject(new LabelPhotoCompletedError('completed'));
    if (this.catalogue.get(beanId)?.status !== 'unverified') return Promise.reject(new BeanNotUnverifiedError('not unverified'));
    const count = this.photoCounts.get(countId) ?? 0;
    if (count >= LABEL_PHOTOS_PER_BEAN) return Promise.reject(new LabelPhotoCapReachedError('cap'));
    const createdAt = this.now.toISOString();
    this.pendingPhotos.delete(pendingId);
    this.userPhotos.set(userId, { beanId, createdAt });
    this.beanPhotos.set(beanPhotoId, { createdAt });
    this.photoCounts.set(countId, count + 1);
    return Promise.resolve();
  }

  // ---- profile, export and account deletion (M1-T6) ----

  public getProfile(user: UserId): Promise<Profile | undefined> {
    this.calls.push('getProfile');
    return Promise.resolve(structuredClone(this.profiles.get(userPk(user))));
  }

  public putProfile(user: UserId, profile: Profile): Promise<Profile> {
    this.calls.push('putProfile');
    return this.#write(user, () => {
      this.profiles.set(userPk(user), structuredClone(profile));
      return Promise.resolve(structuredClone(profile));
    });
  }

  /** The label photo items of the caller's partition (keys `pk|sk`), as photo id and bean id. */
  #userPhotosOf(user: UserId): { photoId: string; beanId: string }[] {
    const prefix = `${userPk(user)}|PHOTO#`;
    return [...this.userPhotos].filter(([id]) => id.startsWith(prefix)).map(([id, photo]) => ({ photoId: id.slice(prefix.length), beanId: photo.beanId }));
  }

  public exportItems(user: UserId): Promise<ExportItems> {
    this.calls.push('exportItems');
    const p = this.#of(user);
    const sorted = <T>(items: T[], id: (item: T) => string): T[] => items.sort((a, b) => (id(a) < id(b) ? -1 : 1));
    const profile = this.profiles.get(userPk(user));
    return Promise.resolve(
      structuredClone({
        ...(profile === undefined ? {} : { profile }),
        shelfEntries: sorted([...p.shelf.values()], (entry) => entry.shelf_entry_id),
        brews: sorted([...p.brews.values()], (brew) => brew.brew_id),
        recipes: sorted([...p.recipes.values()], (recipe) => recipe.recipe_id),
        labelPhotos: sorted(this.#userPhotosOf(user), (photo) => photo.photoId),
      }),
    );
  }

  public isAccountDeleted(user: UserId): Promise<boolean> {
    this.calls.push('isAccountDeleted');
    const tombstone = this.tombstones.get(userPk(user));
    return Promise.resolve(tombstone !== undefined && tombstone.expiresAt > this.#seconds());
  }

  public markAccountDeleted(user: UserId): Promise<AccountTombstone> {
    this.calls.push('markAccountDeleted');
    const pk = userPk(user);
    const expiresAt = this.#seconds() + TOMBSTONE_TTL_SECONDS;
    let tombstone = this.tombstones.get(pk);
    if (tombstone === undefined || tombstone.expiresAt <= this.#seconds()) {
      tombstone = { deletedAt: this.now.toISOString(), expiresAt, photoIds: new Set(), logged: false };
      this.tombstones.set(pk, tombstone);
    } else if (tombstone.expiresAt < expiresAt) {
      tombstone.expiresAt = expiresAt;
    }
    return Promise.resolve({ deletedAt: tombstone.deletedAt, photoIds: [...tombstone.photoIds].sort(), logged: tombstone.logged });
  }

  public recordDeletedPhotos(user: UserId, photoIds: readonly string[]): Promise<void> {
    this.calls.push('recordDeletedPhotos');
    const tombstone = this.tombstones.get(userPk(user));
    if (tombstone === undefined) return Promise.reject(new ItemNotFoundError('no tombstone'));
    for (const id of photoIds) tombstone.photoIds.add(id);
    return Promise.resolve();
  }

  public markDeletionLogged(user: UserId): Promise<void> {
    this.calls.push('markDeletionLogged');
    const tombstone = this.tombstones.get(userPk(user));
    if (tombstone === undefined) return Promise.reject(new ItemNotFoundError('no tombstone'));
    tombstone.logged = true;
    return Promise.resolve();
  }

  public accountPhotos(user: UserId): Promise<AccountPhotos> {
    this.calls.push('accountPhotos');
    const prefix = `${userPk(user)}|PHOTO_PENDING#`;
    const pendingPhotoIds = [...this.pendingPhotos.keys()].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    return Promise.resolve({ photos: this.#userPhotosOf(user), pendingPhotoIds });
  }

  public deleteBeanLabelPhoto(beanId: string, photoId: string): Promise<void> {
    this.calls.push('deleteBeanLabelPhoto');
    this.beanPhotos.delete(keyId(beanLabelPhotoKey(beanId, photoId)));
    return Promise.resolve();
  }

  public deleteUserPartition(user: UserId): Promise<number> {
    this.calls.push('deleteUserPartition');
    const pk = userPk(user);
    let deleted = 0;
    const p = this.#of(user);
    deleted += p.shelf.size + p.brews.size * 2 + p.recipes.size;
    this.#partitions.delete(pk);
    if (this.profiles.delete(pk)) deleted += 1;
    for (const map of [this.lookupCounters, this.pendingPhotos, this.userPhotos, this.photoCounts, this.uploadCounters] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) {
        if (id.startsWith(`${pk}|`)) {
          map.delete(id);
          deleted += 1;
        }
      }
    }
    return Promise.resolve(deleted);
  }

  /** True if nothing of the user's partition is left in this store. */
  public partitionIsEmpty(user: UserId): boolean {
    const pk = userPk(user);
    const p = this.#partitions.get(pk);
    const inMaps = [this.lookupCounters, this.pendingPhotos, this.userPhotos, this.photoCounts, this.uploadCounters].some((map) =>
      [...(map as Map<string, unknown>).keys()].some((id) => id.startsWith(`${pk}|`)),
    );
    return (p === undefined || p.shelf.size + p.brews.size + p.recipes.size === 0) && !this.profiles.has(pk) && !inMaps;
  }

  /** A shelf entry may newly name the bean: known, and not rejected (M1-T11). */
  #beanUsable(beanId: string): boolean {
    return this.beans.has(beanId) && this.catalogue.get(beanId)?.status !== 'rejected';
  }

  /** The operator's reject (not an API route): status rejected, and the barcode pointer goes if it names this bean. */
  public rejectBean(beanId: string): BeanRecord {
    const record = this.catalogue.get(beanId);
    if (record === undefined) throw new ItemNotFoundError('no such bean');
    if (record.status !== 'unverified') throw new BeanNotUnverifiedError('not unverified');
    const rejected: BeanRecord = { ...record, status: 'rejected' };
    this.catalogue.set(beanId, rejected);
    const barcode = record.bean.barcode;
    if (barcode !== undefined && this.barcodes.get(barcode) === beanId) this.barcodes.delete(barcode);
    return structuredClone(rejected);
  }
}
