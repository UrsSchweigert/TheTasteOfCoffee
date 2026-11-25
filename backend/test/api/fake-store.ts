// An in-memory stand-in for the repository, for the API unit tests. It keeps
// the repository's observable rules: one partition per UserId, newest first,
// the repository's own cursor format (base64url sort key, checked on use),
// references (a shelf entry needs a known bean, a brew needs the caller's
// shelf entry) and the 409 on deleting a shelf entry that brews reference.
// The real repository is tested against DynamoDB Local.
import type { UserId } from '../../src/auth/user-id.ts';
import type { Brew, BrewInput, Recipe, RecipeInput, ShelfEntry, ShelfEntryInput } from '../../src/generated/contract.ts';
import type { ApiStore } from '../../src/api/resources.ts';
import { newUlid } from '../../src/ids/ulid.ts';
import {
  BeanNotFoundError,
  ItemNotFoundError,
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
import type { ListOptions, Page } from '../../src/repository/index.ts';

interface Partition {
  readonly shelf: Map<string, ShelfEntry>;
  readonly brews: Map<string, Brew>;
  readonly recipes: Map<string, Recipe>;
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
  public readonly beans = new Set<string>();
  readonly #partitions = new Map<string, Partition>();
  /** Every call, by method name, for assertions. */
  public readonly calls: string[] = [];
  /** Ids are made one millisecond apart, so newest first is deterministic. */
  #clock = Date.UTC(2026, 10, 1);

  #newId(): string {
    this.#clock += 1;
    return newUlid(this.#clock);
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
    if (!this.beans.has(input.bean_id)) return Promise.reject(new BeanNotFoundError('no such bean'));
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
    const p = this.#of(user);
    if (!p.shelf.has(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    if (!this.beans.has(input.bean_id)) return Promise.reject(new BeanNotFoundError('no such bean'));
    const entry = { shelf_entry_id: id, values: structuredClone(input) };
    p.shelf.set(id, entry);
    return Promise.resolve(structuredClone(entry));
  }

  public deleteShelfEntry(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteShelfEntry');
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
    const p = this.#of(user);
    if (!p.brews.has(id)) return Promise.reject(new ItemNotFoundError('no such brew'));
    if (!p.shelf.has(input.shelf_entry_id)) return Promise.reject(new ShelfEntryNotFoundError('no such shelf entry'));
    const brew = { brew_id: id, values: structuredClone(input) };
    p.brews.set(id, brew);
    return Promise.resolve(structuredClone(brew));
  }

  public deleteBrew(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteBrew');
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
    const p = this.#of(user);
    if (!p.recipes.has(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    const recipe = { recipe_id: id, values: structuredClone(input) };
    p.recipes.set(id, recipe);
    return Promise.resolve(structuredClone(recipe));
  }

  public deleteRecipe(user: UserId, id: string): Promise<void> {
    this.calls.push('deleteRecipe');
    if (!this.#of(user).recipes.delete(id)) return Promise.reject(new ItemNotFoundError('no such item'));
    return Promise.resolve();
  }
}
