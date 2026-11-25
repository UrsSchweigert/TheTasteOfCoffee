// GET /barcodes/{barcode}/open_food_facts (task M1-T4b; docs/05-system-design.md,
// Barcode lookup; ADR 0005; contracts/openapi.yaml, lookupOpenFoodFacts).
//
// In this order, each step only if the one before did not answer:
// 1. 400: a malformed barcode or a bad check digit (the router, before
//    anything is read), a query or a body.
// 2. 409: the barcode already points to a bean that is not rejected (the same
//    test as GET /barcodes/{barcode} answering 200).
// 3. The cache (`BARCODE#<ean>` / `OFF`): a hit is 200 with the stored
//    OpenFoodFactsProduct, an unexpired miss is 404.
// 4. 503 if the outbound client is not configured (no valid `OFF_CONTACT`) or
//    the cap setting is invalid: no call, nothing counted.
// 5. 429 if the caller's cap for the UTC day is used up: one atomic
//    conditional `ADD` (Repository.countLookup). Only this step writes to the
//    caller's partition, so only real fetches count (decision in docs/05).
// 6. The fetch: a hit is cached and 200; no product (or one without a name or
//    brand) is cached as a miss and 404; a timeout, a network error or
//    anything unexpected is 503 and caches nothing. The fetch stays counted.
//
// The answer of step 6 is what the cache holds after the write, so two racing
// fetches of one barcode give the same answer (Repository.cacheOpenFoodFactsResult).
// Nothing here logs; the router logs the operation, the status and a fixed
// error name, never the barcode, the user or any Open Food Facts text.
import type { UserId } from '../auth/user-id.ts';
import type { OpenFoodFactsProduct } from '../generated/contract.ts';
import type { OpenFoodFactsClient, UnavailableReason } from '../openfoodfacts/client.ts';
import { canonicalBarcode } from '../repository/index.ts';
import type { OpenFoodFactsCacheEntry, Repository } from '../repository/index.ts';

/** The part of the repository the lookup uses. */
export type OpenFoodFactsStore = Pick<Repository, 'getBeanByBarcode' | 'getOpenFoodFactsCache' | 'cacheOpenFoodFactsResult' | 'countLookup'>;

export interface OpenFoodFactsLookupConfig {
  readonly client: OpenFoodFactsClient;
  /** Fetches per user and UTC day (`OFF_LOOKUP_CAP`, default 50); undefined if the setting is invalid (503). */
  readonly dailyCap: number | undefined;
}

export type LookupResult =
  | { readonly status: 200; readonly product: OpenFoodFactsProduct }
  | { readonly status: 404 }
  | { readonly status: 409; readonly error: 'BarcodeInCatalogue' }
  | { readonly status: 429; readonly error: 'LookupCapReached' }
  | { readonly status: 503; readonly error: 'OpenFoodFactsUnavailable'; readonly reason: UnavailableReason | 'invalid_cap' };

function answer(entry: OpenFoodFactsCacheEntry): LookupResult {
  return entry.kind === 'hit' ? { status: 200, product: entry.product } : { status: 404 };
}

export async function lookupOpenFoodFacts(
  store: OpenFoodFactsStore,
  config: OpenFoodFactsLookupConfig | undefined,
  user: UserId,
  barcode: string,
): Promise<LookupResult> {
  const ean = canonicalBarcode(barcode);
  const bean = await store.getBeanByBarcode(ean);
  if (bean !== undefined && bean.status !== 'rejected') return { status: 409, error: 'BarcodeInCatalogue' };

  const cached = await store.getOpenFoodFactsCache(ean);
  if (cached !== undefined) return answer(cached);

  if (config?.client.configured !== true) return { status: 503, error: 'OpenFoodFactsUnavailable', reason: 'not_configured' };
  if (config.dailyCap === undefined) return { status: 503, error: 'OpenFoodFactsUnavailable', reason: 'invalid_cap' };
  if (!(await store.countLookup(user, config.dailyCap))) return { status: 429, error: 'LookupCapReached' };

  const fetched = await config.client.lookup(ean);
  if (fetched.kind === 'unavailable') return { status: 503, error: 'OpenFoodFactsUnavailable', reason: fetched.reason };
  return answer(await store.cacheOpenFoodFactsResult(ean, fetched));
}
