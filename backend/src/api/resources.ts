// The shelf, brew and recipe routes (task M1-T5; docs/04-specification.md F1
// step 5, F2, F3). All three follow one pattern, so each is described once as a
// `Resource` and served by the same five operations: list, create, get,
// replace, delete. What differs (input schema, method-dependent rules, the
// repository calls) is data here; references and their 404 and 409 answers
// are enforced by the repository in the same transaction as the write.
import type { z } from 'zod';
import type { UserId } from '../auth/user-id.ts';
import { BrewInputSchema, RecipeInputSchema, ShelfEntryInputSchema } from '../generated/contract.ts';
import type { Brew, BrewInput, BrewParameters, Recipe, RecipeInput, ShelfEntry, ShelfEntryInput } from '../generated/contract.ts';
import type { ListOptions, Page, Repository } from '../repository/index.ts';
import { methodRulesFor, violatesMethodRules } from '../vocabulary/method-rules.ts';
import type { CursorList } from './cursor.ts';

/** The part of the repository the API uses. Unit tests pass an in-memory fake. */
export type ApiStore = Pick<
  Repository,
  | 'listShelfEntries'
  | 'createShelfEntry'
  | 'getShelfEntry'
  | 'replaceShelfEntry'
  | 'deleteShelfEntry'
  | 'listBrews'
  | 'createBrew'
  | 'getBrew'
  | 'replaceBrew'
  | 'deleteBrew'
  | 'listRecipes'
  | 'createRecipe'
  | 'getRecipe'
  | 'replaceRecipe'
  | 'deleteRecipe'
  | 'createBean'
  | 'getBean'
  | 'getBeanByBarcode'
  | 'getOpenFoodFactsCache'
  | 'cacheOpenFoodFactsResult'
  | 'countLookup'
>;

export interface Resource<I extends { vocabulary_version: number }, O> {
  /** Path segment and cursor list name. */
  readonly collection: CursorList;
  /** Path parameter of the item routes (contracts/openapi.yaml). */
  readonly idParam: string;
  /** operationIds, for logs. */
  readonly operations: { readonly list: string; readonly create: string; readonly get: string; readonly replace: string; readonly delete: string };
  readonly inputSchema: z.ZodType<I>;
  /** The name of `inputSchema` in contracts/openapi.yaml, for the vocabulary bindings. */
  readonly inputSchemaName: string;
  /** Checks beyond the schema and the vocabulary: the method-dependent rules. */
  readonly accepts: (input: I) => boolean;
  readonly list: (store: ApiStore, user: UserId, options: ListOptions) => Promise<Page<O>>;
  readonly create: (store: ApiStore, user: UserId, input: I) => Promise<O>;
  readonly get: (store: ApiStore, user: UserId, id: string) => Promise<O | undefined>;
  readonly replace: (store: ApiStore, user: UserId, id: string, input: I) => Promise<O>;
  readonly remove: (store: ApiStore, user: UserId, id: string) => Promise<void>;
}

function methodRulesHold(input: { vocabulary_version: number; parameters: BrewParameters }): boolean {
  return !violatesMethodRules(input.parameters, methodRulesFor(input.vocabulary_version));
}

export const shelfResource: Resource<ShelfEntryInput, ShelfEntry> = {
  collection: 'shelf',
  idParam: 'shelf_entry_id',
  operations: {
    list: 'listShelfEntries',
    create: 'createShelfEntry',
    get: 'getShelfEntry',
    replace: 'replaceShelfEntry',
    delete: 'deleteShelfEntry',
  },
  inputSchema: ShelfEntryInputSchema,
  inputSchemaName: 'ShelfEntryInput',
  accepts: () => true,
  list: (store, user, options) => store.listShelfEntries(user, options),
  create: (store, user, input) => store.createShelfEntry(user, input),
  get: (store, user, id) => store.getShelfEntry(user, id),
  replace: (store, user, id, input) => store.replaceShelfEntry(user, id, input),
  remove: (store, user, id) => store.deleteShelfEntry(user, id),
};

export const brewResource: Resource<BrewInput, Brew> = {
  collection: 'brews',
  idParam: 'brew_id',
  operations: { list: 'listBrews', create: 'createBrew', get: 'getBrew', replace: 'replaceBrew', delete: 'deleteBrew' },
  inputSchema: BrewInputSchema,
  inputSchemaName: 'BrewInput',
  accepts: methodRulesHold,
  list: (store, user, options) => store.listBrews(user, options),
  create: (store, user, input) => store.createBrew(user, input),
  get: (store, user, id) => store.getBrew(user, id),
  replace: (store, user, id, input) => store.replaceBrew(user, id, input),
  remove: (store, user, id) => store.deleteBrew(user, id),
};

export const recipeResource: Resource<RecipeInput, Recipe> = {
  collection: 'recipes',
  idParam: 'recipe_id',
  operations: { list: 'listRecipes', create: 'createRecipe', get: 'getRecipe', replace: 'replaceRecipe', delete: 'deleteRecipe' },
  inputSchema: RecipeInputSchema,
  inputSchemaName: 'RecipeInput',
  accepts: methodRulesHold,
  list: (store, user, options) => store.listRecipes(user, options),
  create: (store, user, input) => store.createRecipe(user, input),
  get: (store, user, id) => store.getRecipe(user, id),
  replace: (store, user, id, input) => store.replaceRecipe(user, id, input),
  remove: (store, user, id) => store.deleteRecipe(user, id),
};
