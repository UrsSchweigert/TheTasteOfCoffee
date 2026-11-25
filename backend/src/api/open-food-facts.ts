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
// 6. The fetch: a hit is cached and 200; no product (or one without a name,
//    brand or front image) is cached as a miss and 404; a timeout, a network
//    error or anything unexpected is 503 and caches nothing. The fetch stays
//    counted.
// 7. The image copy (M1-T4c, ADR 0011), only for a fetched hit with a
//    front-image URL the client accepted, and before the hit is cached: the
//    image is downloaded, checked, stripped of all metadata and stored as
//    `catalogue/<imageId>.jpg` (image-copy.ts), and the cached hit carries
//    `image_id`. A failed copy (no PHOTO_BUCKET, fetch, validation or S3) is
//    a hit without an image. A product whose only content is the image is
//    different, because without the image there is nothing to show: a
//    transient failure (timeout, network, HTTP 429 or 5xx, S3, no bucket;
//    isTransientCopyFailure) is 503 and caches nothing, so a later lookup
//    tries again; a permanent one (a refused URL, a redirect, a 4xx, another
//    content type, too large, not a valid JPEG) is cached as a miss (404).
//    Either way the fetch stays counted against the cap: Open Food Facts did
//    the work, and a retry loop must not be free. So every image is copied at
//    most once per new hit, and a cached hit is never fetched again.
//
// The answer of step 6 is what the cache holds after the write, so two racing
// fetches of one barcode give the same answer (Repository.cacheOpenFoodFactsResult).
// If two fetches race, both may copy an image; the hit stored first wins, and
// the loser's object stays in the bucket unreferenced. That is rare, costs a
// few KiB, and is accepted rather than a second conditional step.
// Nothing here logs; the router logs the operation, the status, a fixed
// error name and a fixed image outcome code, never the barcode, the image
// URL, the user or any Open Food Facts text.
import type { UserId } from '../auth/user-id.ts';
import type { OpenFoodFactsProduct } from '../generated/contract.ts';
import type { CatalogueImageStore } from '../images/catalogue-store.ts';
import type { OpenFoodFactsClient, UnavailableReason } from '../openfoodfacts/client.ts';
import { copyFrontImage, isTransientCopyFailure } from '../openfoodfacts/image-copy.ts';
import type { ImageCopyFailure } from '../openfoodfacts/image-copy.ts';
import { canonicalBarcode } from '../repository/index.ts';
import type { OpenFoodFactsCacheEntry, Repository } from '../repository/index.ts';

/** The part of the repository the lookup uses. */
export type OpenFoodFactsStore = Pick<Repository, 'getBeanByBarcode' | 'getOpenFoodFactsCache' | 'cacheOpenFoodFactsResult' | 'countLookup'>;

export interface OpenFoodFactsLookupConfig {
  readonly client: OpenFoodFactsClient;
  /** Fetches per user and UTC day (`OFF_LOOKUP_CAP`, default 50); undefined if the setting is invalid (503). */
  readonly dailyCap: number | undefined;
  /** New catalogue image ids; for tests. Default: a ULID. */
  readonly newImageId?: () => string;
}

/** What happened to the front image of a fetched hit, for the log: a fixed code, never the URL. */
export type ImageLogCode = 'stored' | 'none' | ImageCopyFailure;

export type LookupResult =
  | { readonly status: 200; readonly product: OpenFoodFactsProduct; readonly image?: ImageLogCode }
  | { readonly status: 404; readonly image?: ImageLogCode }
  | { readonly status: 409; readonly error: 'BarcodeInCatalogue' }
  | { readonly status: 429; readonly error: 'LookupCapReached' }
  | {
      readonly status: 503;
      readonly error: 'OpenFoodFactsUnavailable';
      readonly reason: UnavailableReason | 'invalid_cap' | 'image_unavailable';
      readonly image?: ImageLogCode;
    };

function answer(entry: OpenFoodFactsCacheEntry, image?: ImageLogCode): LookupResult {
  const logged = image === undefined ? {} : { image };
  return entry.kind === 'hit' ? { status: 200, product: entry.product, ...logged } : { status: 404, ...logged };
}

/**
 * `images` is the catalogue image store, undefined without a usable
 * PHOTO_BUCKET (hits are then cached without an image).
 */
export async function lookupOpenFoodFacts(
  store: OpenFoodFactsStore,
  config: OpenFoodFactsLookupConfig | undefined,
  images: CatalogueImageStore | undefined,
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
  if (fetched.kind === 'miss') return answer(await store.cacheOpenFoodFactsResult(ean, fetched));

  let imageId: string | undefined;
  let image: ImageLogCode = 'none';
  let transient = false;
  if (fetched.imageUrl !== undefined) {
    const copied = await copyFrontImage(
      { client: config.client, store: images, ...(config.newImageId === undefined ? {} : { newId: config.newImageId }) },
      fetched.imageUrl,
      ean,
    );
    if (copied.kind === 'stored') {
      imageId = copied.imageId;
      image = 'stored';
    } else {
      image = copied.reason;
      transient = isTransientCopyFailure(copied.reason);
    }
  }
  const { name, brand } = fetched.product;
  if (name === undefined && brand === undefined && imageId === undefined) {
    // Only an image, and it could not be copied: a retry may work, so nothing is cached for a transient failure.
    if (transient) return { status: 503, error: 'OpenFoodFactsUnavailable', reason: 'image_unavailable', image };
    return answer(await store.cacheOpenFoodFactsResult(ean, { kind: 'miss' }), image);
  }
  const product: OpenFoodFactsProduct = {
    ...(name === undefined ? {} : { name }),
    ...(brand === undefined ? {} : { brand }),
    ...(imageId === undefined ? {} : { image_id: imageId }),
  };
  return answer(await store.cacheOpenFoodFactsResult(ean, { kind: 'hit', product }), image);
}
