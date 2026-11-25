// The outbound Open Food Facts client (task M1-T4b; docs/05-system-design.md,
// Barcode lookup; ADR 0005). The only code in the backend that calls a host
// outside AWS.
//
// - One URL shape, built here from a constant origin and a canonical EAN-13:
//   `https://world.openfoodfacts.org/api/v2/product/<ean>.json?fields=product_name,brands,image_front_url`.
//   That is the read API v2 ("Get a product by barcode"). The shape used is
//   `{ status: 1, product: { product_name, brands, image_front_url } }` for a product and HTTP
//   404 (or `status: 0`) for none, with `brands` a comma-separated string. The
//   official docs could not be fetched from the build environment, so this is
//   the known v2 shape; it is parsed defensively and anything else is 503.
// - User-Agent `Cupmark/<version> (<contact>)`, as Open Food Facts asks of
//   apps. The contact is an operator mailbox from the Lambda environment
//   (`OFF_CONTACT`), never from Secrets Manager or the repo. Without a valid
//   contact the client is not configured and makes no call.
// - Node's built-in fetch (no dependency). Redirects are not followed
//   (`redirect: 'manual'`), so no other host is ever reached; a 3xx, a response
//   that claims another URL, or one marked redirected is 503.
// - A timeout (default 3 s) covers the whole exchange, headers and body; the
//   body is read with a byte limit (default 64 KiB, the filtered answer is a
//   few hundred bytes) and must be JSON.
// - Everything that comes back is untrusted: only `status`, `product_name`,
//   `brands` and `image_front_url` are read, and the text is cleaned
//   (text.ts). Nothing from the response is logged or put in an error;
//   outcomes carry fixed reason codes.
// - The front image (M1-T4c, ADR 0011): `image_front_url` is kept only if it
//   is an image-host URL for the same EAN-13 (image-url.ts); missing, of
//   another type or anything else is no image, and the hit stays a hit.
//   `fetchImage` downloads it with the same rules: that URL only, no
//   redirects, its own deadline (default 2.5 s), `image/jpeg` only, at most
//   MAX_CATALOGUE_IMAGE_BYTES. It returns raw bytes; image-copy.ts checks and
//   strips them before anything is stored.
import { MAX_CATALOGUE_IMAGE_BYTES } from '../images/limits.ts';
import { canonicalBarcode } from '../repository/keys.ts';
import { BodyNotBytes, BodyTooLarge, discard, isRedirect, readLimitedBytes, withDeadline } from './fetching.ts';
import type { Fetch } from './fetching.ts';
import { frontImageUrl } from './image-url.ts';
import { NAME_MAX_CODE_POINTS, cleanText, firstBrand } from './text.ts';

export type { Fetch } from './fetching.ts';

/** The only origin the client talks to. */
export const OPEN_FOOD_FACTS_ORIGIN = 'https://world.openfoodfacts.org';
/** The fields asked for: just what the contract's OpenFoodFactsProduct is made from. */
export const OPEN_FOOD_FACTS_FIELDS = 'product_name,brands,image_front_url';
/** Sent in the User-Agent. Kept equal to package.json by a test. */
export const CUPMARK_VERSION = '0.0.0';
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
/** Deadline of the image download. With the 3 s lookup and a 2 s S3 put, the lookup stays well inside the 10 s Lambda timeout. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 2500;

/** An e-mail address: no white space, parentheses, quotes or control characters can reach the header. */
const CONTACT = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;

export interface OpenFoodFactsText {
  readonly name?: string;
  readonly brand?: string;
}

export type UnavailableReason =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'status'
  | 'content_type'
  | 'too_large'
  | 'malformed';

/**
 * A hit has a name, a brand or a usable front-image URL (contract: 404 is "none
 * with a name, brand or front image"). `product` may be empty only when
 * `imageUrl` is set; whether that is a hit then depends on the copy.
 */
export type FetchOutcome =
  | { readonly kind: 'hit'; readonly product: OpenFoodFactsText; readonly imageUrl?: string }
  | { readonly kind: 'miss' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/**
 * Why an image download failed. `server_status` is HTTP 429 or 5xx (the host
 * is busy or broken, worth a retry); `client_status` is any other non-200,
 * non-3xx answer (the image is not there).
 */
export type ImageFailureReason =
  | 'not_configured'
  | 'invalid_url'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'server_status'
  | 'client_status'
  | 'content_type'
  | 'too_large';

export type ImageFetchOutcome =
  | { readonly kind: 'image'; readonly bytes: Uint8Array }
  | { readonly kind: 'failed'; readonly reason: ImageFailureReason };

export interface OpenFoodFactsClientOptions {
  /** The operator contact for the User-Agent (`OFF_CONTACT`). Missing or not an e-mail address: not configured. */
  readonly contact: string | undefined;
  /** The HTTP client; tests pass a stub. Default: Node's global fetch. */
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly imageTimeoutMs?: number;
  readonly maxImageBytes?: number;
}

export interface OpenFoodFactsClient {
  /** False without a valid contact: `lookup` then answers `not_configured` without a call. */
  readonly configured: boolean;
  lookup(barcode: string): Promise<FetchOutcome>;
  /** Downloads a front image; `url` must pass frontImageUrl for `barcode` again, else nothing is fetched. */
  fetchImage(url: string, barcode: string): Promise<ImageFetchOutcome>;
}

export function isValidContact(value: string | undefined): value is string {
  return value !== undefined && value.length <= 254 && CONTACT.test(value);
}

/** `Cupmark/<version> (<contact>)`. */
export function userAgent(contact: string): string {
  return `Cupmark/${CUPMARK_VERSION} (${contact})`;
}

/** The product URL for a barcode (canonicalised to EAN-13; throws InvalidKeyError for a bad one). */
export function productUrl(barcode: string): string {
  // 13 digits and constants only; new URL() normalises it, so it equals a response's `url`.
  return new URL(`${OPEN_FOOD_FACTS_ORIGIN}/api/v2/product/${canonicalBarcode(barcode)}.json?fields=${OPEN_FOOD_FACTS_FIELDS}`).toString();
}

const unavailable = (reason: UnavailableReason): FetchOutcome => ({ kind: 'unavailable', reason });

class BodyNotUtf8 extends Error {
  public override readonly name = 'BodyNotUtf8';
}

/** The body as UTF-8 text, or BodyTooLarge past `limit` bytes. */
async function readLimitedText(response: Response, limit: number): Promise<string> {
  const bytes = await readLimitedBytes(response, limit);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BodyNotUtf8('body is not UTF-8');
  }
}

function isTextOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the v2 answer. No product (`status: 0`, with HTTP 404 or 200) is a
 * miss; a 404 without that body is not trusted to be one (a moved API must not
 * cache misses for a month) and is 503. A product is a hit if it has a name or
 * a brand after cleaning or a front-image URL that may be followed, else a
 * miss (the contract's 404: none with a name, brand or front image). A name or
 * brand that is neither a string nor absent is malformed, not a miss; an image
 * field of the wrong type is only no image.
 */
function outcomeOf(status: number, payload: unknown, ean: string): FetchOutcome {
  if (!isRecord(payload)) return unavailable('malformed');
  if (payload.status === 0) return { kind: 'miss' };
  if (status === 404) return unavailable('status');
  if (payload.status !== 1 || !isRecord(payload.product)) return unavailable('malformed');
  // A field of the wrong type means the shape is not the one assumed: 503, so no miss is cached for 30 days.
  if (!isTextOrAbsent(payload.product.product_name) || !isTextOrAbsent(payload.product.brands)) return unavailable('malformed');
  const name = cleanText(payload.product.product_name, NAME_MAX_CODE_POINTS);
  const brand = firstBrand(payload.product.brands);
  // Fail safe: an image URL that is missing, of another type or not on the image host for this EAN is no image.
  const imageUrl = frontImageUrl(payload.product.image_front_url, ean);
  if (name === undefined && brand === undefined && imageUrl === undefined) return { kind: 'miss' };
  return {
    kind: 'hit',
    product: { ...(name === undefined ? {} : { name }), ...(brand === undefined ? {} : { brand }) },
    ...(imageUrl === undefined ? {} : { imageUrl }),
  };
}

/** One request and its answer; throws on network errors, BodyTooLarge and BodyNotUtf8. */
async function exchange(fetchImpl: Fetch, url: string, ean: string, contact: string, signal: AbortSignal, maxBytes: number): Promise<FetchOutcome> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { 'user-agent': userAgent(contact), accept: 'application/json' },
    redirect: 'manual',
    signal,
  });
  if (isRedirect(response, url)) {
    discard(response);
    return unavailable('redirect');
  }
  if (response.status !== 200 && response.status !== 404) {
    discard(response);
    return unavailable('status');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType.trim())) {
    discard(response);
    return unavailable('content_type');
  }
  const text = await readLimitedText(response, maxBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return unavailable('malformed');
  }
  return outcomeOf(response.status, payload, ean);
}

const imageFailed = (reason: ImageFailureReason): ImageFetchOutcome => ({ kind: 'failed', reason });

/** One image request and its answer; throws on network errors, BodyTooLarge and BodyNotBytes. */
async function imageExchange(fetchImpl: Fetch, url: string, contact: string, signal: AbortSignal, maxBytes: number): Promise<ImageFetchOutcome> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { 'user-agent': userAgent(contact), accept: 'image/jpeg' },
    redirect: 'manual',
    signal,
  });
  if (isRedirect(response, url)) {
    discard(response);
    return imageFailed('redirect');
  }
  if (response.status !== 200) {
    discard(response);
    return imageFailed(response.status === 429 || response.status >= 500 ? 'server_status' : 'client_status');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^image\/jpeg(?:\s*;.*)?$/i.test(contentType.trim())) {
    discard(response);
    return imageFailed('content_type');
  }
  return { kind: 'image', bytes: await readLimitedBytes(response, maxBytes) };
}

export function createOpenFoodFactsClient(options: OpenFoodFactsClientOptions): OpenFoodFactsClient {
  const contact = isValidContact(options.contact) ? options.contact : undefined;
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const maxImageBytes = options.maxImageBytes ?? MAX_CATALOGUE_IMAGE_BYTES;

  return {
    configured: contact !== undefined,
    async lookup(barcode) {
      if (contact === undefined) return unavailable('not_configured');
      const ean = canonicalBarcode(barcode);
      const url = productUrl(ean);
      // Defence in depth: the URL is built from constants and 13 digits, but never send it anywhere else.
      if (new URL(url).origin !== OPEN_FOOD_FACTS_ORIGIN) return unavailable('redirect');
      // The deadline covers the whole exchange, even a fetch or a body that ignores the signal.
      return withDeadline(
        timeoutMs,
        (signal) => exchange(fetchImpl, url, ean, contact, signal, maxBytes),
        unavailable('timeout'),
        (error) => {
          if (error instanceof BodyTooLarge) return unavailable('too_large');
          if (error instanceof BodyNotUtf8 || error instanceof BodyNotBytes) return unavailable('malformed');
          return unavailable('network');
        },
      );
    },
    async fetchImage(url, barcode) {
      if (contact === undefined) return imageFailed('not_configured');
      // Checked again here, so no caller can make the server fetch another host or another product's image.
      const allowed = frontImageUrl(url, canonicalBarcode(barcode));
      if (allowed === undefined) return imageFailed('invalid_url');
      return withDeadline(
        imageTimeoutMs,
        (signal) => imageExchange(fetchImpl, allowed, contact, signal, maxImageBytes),
        imageFailed('timeout'),
        (error) => (error instanceof BodyTooLarge ? imageFailed('too_large') : imageFailed('network')),
      );
    },
  };
}
