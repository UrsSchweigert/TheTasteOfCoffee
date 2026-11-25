// Copying an Open Food Facts front image into the catalogue (task M1-T4c;
// ADR 0011; D12; docs/05-system-design.md, Barcode lookup, Image copy).
//
// Download (client.fetchImage: the image host, the same EAN-13, no redirects,
// a deadline, image/jpeg, a size limit), then validate and strip the JPEG
// (images/jpeg.ts), then store it under a new ULID as
// `catalogue/<imageId>.jpg` (images/catalogue-store.ts). Any failure is a
// fixed reason code and no image; it never throws, so a failed copy can never
// turn a hit into an error. Nothing here logs; the reason goes into the
// router's one log line.
import type { CatalogueImageStore } from '../images/catalogue-store.ts';
import { stripJpeg } from '../images/jpeg.ts';
import { MAX_CATALOGUE_IMAGE_BYTES } from '../images/limits.ts';
import { newUlid } from '../ids/ulid.ts';
import type { ImageFailureReason, OpenFoodFactsClient } from './client.ts';

export type ImageCopyFailure = ImageFailureReason | 'no_store' | 'not_jpeg' | 'store_failed';

/**
 * True if a failed copy may succeed when tried again: a slow or broken
 * network or host, an S3 failure, or a server without its bucket. These must
 * never be cached as a miss for 30 days. The rest (a refused URL, a redirect,
 * a 4xx, another content type, too large, not a valid JPEG) describe the
 * image itself and stay the same on a retry.
 */
export function isTransientCopyFailure(reason: ImageCopyFailure): boolean {
  switch (reason) {
    case 'timeout':
    case 'network':
    case 'server_status':
    case 'store_failed':
    case 'no_store':
    case 'not_configured':
      return true;
    case 'invalid_url':
    case 'redirect':
    case 'client_status':
    case 'content_type':
    case 'too_large':
    case 'not_jpeg':
      return false;
  }
}

export type ImageCopyOutcome =
  | { readonly kind: 'stored'; readonly imageId: string }
  | { readonly kind: 'failed'; readonly reason: ImageCopyFailure };

export interface ImageCopyDependencies {
  readonly client: Pick<OpenFoodFactsClient, 'fetchImage'>;
  /** Undefined without a usable PHOTO_BUCKET: nothing is downloaded. */
  readonly store: CatalogueImageStore | undefined;
  /** New image ids; for tests. Default: a ULID. */
  readonly newId?: () => string;
}

export async function copyFrontImage(deps: ImageCopyDependencies, url: string, ean: string): Promise<ImageCopyOutcome> {
  // Without somewhere to put it, the image is not even downloaded.
  if (deps.store === undefined) return { kind: 'failed', reason: 'no_store' };
  let fetched;
  try {
    fetched = await deps.client.fetchImage(url, ean);
  } catch {
    return { kind: 'failed', reason: 'network' };
  }
  if (fetched.kind === 'failed') return fetched;
  const jpeg = stripJpeg(fetched.bytes);
  if (jpeg === undefined || jpeg.byteLength > MAX_CATALOGUE_IMAGE_BYTES) return { kind: 'failed', reason: 'not_jpeg' };
  const imageId = (deps.newId ?? newUlid)();
  try {
    await deps.store.put(imageId, jpeg);
  } catch {
    return { kind: 'failed', reason: 'store_failed' };
  }
  return { kind: 'stored', imageId };
}
