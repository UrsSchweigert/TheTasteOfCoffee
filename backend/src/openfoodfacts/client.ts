// The outbound Open Food Facts client (task M1-T4b; docs/05-system-design.md,
// Barcode lookup; ADR 0005). The only code in the backend that calls a host
// outside AWS.
//
// - One URL shape, built here from a constant origin and a canonical EAN-13:
//   `https://world.openfoodfacts.org/api/v2/product/<ean>.json?fields=product_name,brands`.
//   That is the read API v2 ("Get a product by barcode"). The shape used is
//   `{ status: 1, product: { product_name, brands } }` for a product and HTTP
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
// - Everything that comes back is untrusted: only `status`, `product_name` and
//   `brands` are read, and the text is cleaned (text.ts). Nothing from the
//   response is logged or put in an error; outcomes carry fixed reason codes.
import { canonicalBarcode } from '../repository/keys.ts';
import { NAME_MAX_CODE_POINTS, cleanText, firstBrand } from './text.ts';

/** The only origin the client talks to. */
export const OPEN_FOOD_FACTS_ORIGIN = 'https://world.openfoodfacts.org';
/** The fields asked for: just what the contract's OpenFoodFactsProduct holds (the image comes with M1-T4c). */
export const OPEN_FOOD_FACTS_FIELDS = 'product_name,brands';
/** Sent in the User-Agent. Kept equal to package.json by a test. */
export const CUPMARK_VERSION = '0.0.0';
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

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

export type FetchOutcome =
  | { readonly kind: 'hit'; readonly product: OpenFoodFactsText }
  | { readonly kind: 'miss' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenFoodFactsClientOptions {
  /** The operator contact for the User-Agent (`OFF_CONTACT`). Missing or not an e-mail address: not configured. */
  readonly contact: string | undefined;
  /** The HTTP client; tests pass a stub. Default: Node's global fetch. */
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface OpenFoodFactsClient {
  /** False without a valid contact: `lookup` then answers `not_configured` without a call. */
  readonly configured: boolean;
  lookup(barcode: string): Promise<FetchOutcome>;
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

class BodyTooLarge extends Error {
  public override readonly name = 'BodyTooLarge';
}

class BodyNotUtf8 extends Error {
  public override readonly name = 'BodyNotUtf8';
}

/** Drops a body that is not read, without waiting on it. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** The body as text, or BodyTooLarge past `limit` bytes. Aborts with the request's signal. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    discard(response);
    throw new BodyTooLarge('declared length over the limit');
  }
  if (response.body === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = response.body;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new BodyNotUtf8('body is not bytes');
    size += chunk.byteLength;
    // Leaving the loop early cancels the stream.
    if (size > limit) throw new BodyTooLarge('body over the limit');
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BodyNotUtf8('body is not UTF-8');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the v2 answer. No product (`status: 0`, with HTTP 404 or 200) is a
 * miss; a 404 without that body is not trusted to be one (a moved API must not
 * cache misses for a month) and is 503. A product is a hit if it has a name or
 * a brand after cleaning, else a miss (the contract's 404: none with a name,
 * brand or front image).
 */
function outcomeOf(status: number, payload: unknown): FetchOutcome {
  if (!isRecord(payload)) return unavailable('malformed');
  if (payload.status === 0) return { kind: 'miss' };
  if (status === 404) return unavailable('status');
  if (payload.status !== 1 || !isRecord(payload.product)) return unavailable('malformed');
  const name = cleanText(payload.product.product_name, NAME_MAX_CODE_POINTS);
  const brand = firstBrand(payload.product.brands);
  if (name === undefined && brand === undefined) return { kind: 'miss' };
  return {
    kind: 'hit',
    product: { ...(name === undefined ? {} : { name }), ...(brand === undefined ? {} : { brand }) },
  };
}

/** One request and its answer; throws on network errors, BodyTooLarge and BodyNotUtf8. */
async function exchange(fetchImpl: Fetch, url: string, contact: string, signal: AbortSignal, maxBytes: number): Promise<FetchOutcome> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { 'user-agent': userAgent(contact), accept: 'application/json' },
    redirect: 'manual',
    signal,
  });
  if (response.redirected || (response.url !== '' && response.url !== url) || (response.status >= 300 && response.status < 400)) {
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
  const text = await readLimited(response, maxBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return unavailable('malformed');
  }
  return outcomeOf(response.status, payload);
}

export function createOpenFoodFactsClient(options: OpenFoodFactsClientOptions): OpenFoodFactsClient {
  const contact = isValidContact(options.contact) ? options.contact : undefined;
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    configured: contact !== undefined,
    async lookup(barcode) {
      if (contact === undefined) return unavailable('not_configured');
      const url = productUrl(barcode);
      // Defence in depth: the URL is built from constants and 13 digits, but never send it anywhere else.
      if (new URL(url).origin !== OPEN_FOOD_FACTS_ORIGIN) return unavailable('redirect');
      const signal = AbortSignal.timeout(timeoutMs);
      // The deadline covers the whole exchange, even a fetch or a body that ignores the signal.
      const deadline = new Promise<FetchOutcome>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve(unavailable('timeout'));
          },
          { once: true },
        );
      });
      try {
        return await Promise.race([exchange(fetchImpl, url, contact, signal, maxBytes), deadline]);
      } catch (error) {
        if (signal.aborted) return unavailable('timeout');
        if (error instanceof BodyTooLarge) return unavailable('too_large');
        if (error instanceof BodyNotUtf8) return unavailable('malformed');
        return unavailable('network');
      }
    },
  };
}
