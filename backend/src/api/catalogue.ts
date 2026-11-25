// The bean catalogue routes (task M1-T4a; docs/04-specification.md F1,
// docs/05-system-design.md Barcode lookup): GET /barcodes/{barcode},
// POST /beans and GET /beans/{bean_id}. The Open Food Facts lookup is in
// open-food-facts.ts (M1-T4b).
//
// The catalogue is shared: any signed-in user may read any bean that is not
// rejected, verified or not (F1 step 3: unverified entries are shown right
// away, ADR 0005). A rejected bean is answered 404 as if it did not exist; its
// barcode pointer is gone (Repository.rejectBean), so a scan can submit a fresh
// entry. The caller's user id is never stored on a bean, so the response
// cannot carry another user's id because the bean holds none. POST /beans
// passes it to the repository only for the tombstone check of a deleted
// account (ADR 0017, Addendum).
import { z } from 'zod';
import type { UserId } from '../auth/user-id.ts';
import { BeanCreateSchema } from '../generated/contract.ts';
import type { Bean, BeanCreate, OpenFoodFactsProduct } from '../generated/contract.ts';
import { InvalidKeyError, OpenFoodFactsHitMissingError, canonicalBarcode } from '../repository/index.ts';
import type { BeanRecord, Repository } from '../repository/index.ts';
import { parseBody } from './http.ts';
import type { ApiEvent } from './http.ts';

/** The part of the repository the catalogue routes use. */
export type CatalogueStore = Pick<Repository, 'createBean' | 'getBean' | 'getBeanByBarcode' | 'getOpenFoodFactsCache'>;

function hasValidCheckDigit(value: string): boolean {
  try {
    canonicalBarcode(value);
    return true;
  } catch (error) {
    if (error instanceof InvalidKeyError) return false;
    throw error;
  }
}

/**
 * The `{barcode}` path parameter: the contract's `Barcode` (12 or 13 digits)
 * with a correct GS1 check digit. Anything else is 400 before the store is
 * asked.
 */
export const BarcodeParameterSchema: z.ZodType<string> = z.string().refine(hasValidCheckDigit);

/** Parses and validates a POST /beans body: schema, vocabulary version, then the check digit. Undefined is 400. */
export function parseBeanCreate(event: ApiEvent): BeanCreate | undefined {
  return parseBody(event, BeanCreateSchema, 'BeanCreate', acceptsBeanCreate);
}

/** Checks beyond the schema and the vocabulary: a barcode in the body must have a correct check digit. */
export function acceptsBeanCreate(input: BeanCreate): boolean {
  return input.barcode === undefined || hasValidCheckDigit(input.barcode);
}

/** The bean as users see it, or undefined for a rejected one (404). */
function visible(record: BeanRecord | undefined): Bean | undefined {
  return record === undefined || record.status === 'rejected' ? undefined : record.bean;
}

/** GET /barcodes/{barcode}: the bean the canonical EAN-13 points to; undefined is 404. */
export async function lookupBarcode(store: CatalogueStore, barcode: string): Promise<Bean | undefined> {
  return visible(await store.getBeanByBarcode(canonicalBarcode(barcode)));
}

/** GET /beans/{bean_id}: the bean; undefined (404) if there is none or it was rejected. */
export async function getBean(store: CatalogueStore, beanId: string): Promise<Bean | undefined> {
  return visible(await store.getBean(beanId));
}

/**
 * POST /beans: a new unverified bean. Every picked attribute goes into
 * `picked_attributes` (source "user"); `operator_attributes` starts empty.
 *
 * With `open_food_facts_confirmed: true` (the schema makes it need a barcode)
 * the server reads its own Open Food Facts cache for the barcode (M1-T4b) and
 * copies the hit's name and brand into the `open_food_facts` group, whose name
 * is the source tag of each field in it (D5, ODbL), with
 * `open_food_facts_match: true`. No cached entry, or a cached miss, is
 * OpenFoodFactsHitMissingError (409): the app must call GET
 * /barcodes/{barcode}/open_food_facts first. Hits never expire and are never
 * overwritten, so the copy cannot go stale between the read and the write.
 * `false` is the same as leaving it out. A barcode that already points to a
 * bean is BarcodeTakenError (409), from the repository's transaction.
 */
export async function createBean(store: CatalogueStore, input: BeanCreate, caller: UserId): Promise<Bean> {
  const barcode = input.barcode === undefined ? undefined : canonicalBarcode(input.barcode);
  let openFoodFacts: OpenFoodFactsProduct | undefined;
  if (input.open_food_facts_confirmed === true) {
    const cached = barcode === undefined ? undefined : await store.getOpenFoodFactsCache(barcode);
    if (cached?.kind !== 'hit') throw new OpenFoodFactsHitMissingError('no cached Open Food Facts hit');
    openFoodFacts = cached.product;
  }
  const record = await store.createBean({
    vocabularyVersion: input.vocabulary_version,
    ...(barcode === undefined ? {} : { barcode }),
    openFoodFactsMatch: openFoodFacts !== undefined,
    ...(openFoodFacts === undefined ? {} : { openFoodFacts }),
    pickedAttributes: input.attributes,
  }, caller);
  return record.bean;
}
