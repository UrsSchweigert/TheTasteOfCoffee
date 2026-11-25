// The outbound Open Food Facts client (M1-T4b), with a stubbed fetch only:
// no test reaches Open Food Facts. The URL and host, the User-Agent, a missing
// contact (no call), the timeout, redirects and foreign hosts, the size
// limit, and every kind of answer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CUPMARK_VERSION,
  OPEN_FOOD_FACTS_ORIGIN,
  createOpenFoodFactsClient,
  isValidContact,
  productUrl,
  userAgent,
} from '../../src/openfoodfacts/client.ts';
import type { Fetch, FetchOutcome } from '../../src/openfoodfacts/client.ts';
import { InvalidKeyError } from '../../src/repository/index.ts';

const CONTACT = 'operator@example.org';
const EAN13 = '4006381333931';
const UPC_A = '036000291452';
const EXPECTED_URL = `https://world.openfoodfacts.org/api/v2/product/${EAN13}.json?fields=product_name,brands,image_front_url`;

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

const product = (fields: Record<string, unknown>): Response => jsonResponse({ code: EAN13, status: 1, status_verbose: 'product found', product: fields });

async function lookup(respond: Parameters<typeof stub>[0], options: { contact?: string; timeoutMs?: number; maxResponseBytes?: number } = {}): Promise<{ outcome: FetchOutcome; calls: Recorded[] }> {
  const { fetch, calls } = stub(respond);
  const client = createOpenFoodFactsClient({ contact: CONTACT, fetch, ...options });
  return { outcome: await client.lookup(EAN13), calls };
}

describe('request', () => {
  it('asks exactly the v2 product URL on the Open Food Facts host, for the canonical EAN-13, with a minimal field list', async () => {
    const { calls } = await lookup(() => product({ product_name: 'x' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPECTED_URL);
    expect(new URL(calls[0]?.url ?? '').origin).toBe(OPEN_FOOD_FACTS_ORIGIN);
    expect(calls[0]?.init.method).toBe('GET');
    expect(productUrl(UPC_A)).toBe(`https://world.openfoodfacts.org/api/v2/product/0${UPC_A}.json?fields=product_name,brands,image_front_url`);
  });

  it('sends User-Agent Cupmark/<version> (<contact>) and no other identifying header', async () => {
    const { calls } = await lookup(() => product({ product_name: 'x' }));
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('user-agent')).toBe(`Cupmark/${CUPMARK_VERSION} (${CONTACT})`);
    expect(userAgent(CONTACT)).toBe(`Cupmark/${CUPMARK_VERSION} (operator@example.org)`);
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
  });

  it('the version in the User-Agent is the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CUPMARK_VERSION).toBe(pkg.version);
  });

  it('never follows redirects and always sets a deadline', async () => {
    const { calls } = await lookup(() => product({ product_name: 'x' }));
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['letters', '40063813339A1'],
    ['a path', '../../x'],
    ['another host', 'evil.example/4006381333931'],
    ['a bad check digit', '4006381333932'],
  ])('a bad barcode (%s) throws before any call', async (_name, bad) => {
    const { fetch, calls } = stub(() => product({}));
    const client = createOpenFoodFactsClient({ contact: CONTACT, fetch });
    await expect(client.lookup(bad)).rejects.toBeInstanceOf(InvalidKeyError);
    expect(calls).toEqual([]);
  });
});

describe('the contact (OFF_CONTACT)', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not an address', 'operator'],
    ['with a space', 'op erator@example.org'],
    ['with a parenthesis (would break the User-Agent)', 'op)@example.org'],
    ['with a line break (header injection)', 'op@example.org\r\nX-Evil: 1'],
    ['without a domain dot', 'op@localhost'],
    ['too long', `${'a'.repeat(250)}@example.org`],
  ])('%s: not configured, and lookup answers not_configured with no call', async (_name, contact) => {
    expect(isValidContact(contact)).toBe(false);
    const { fetch, calls } = stub(() => product({ product_name: 'x' }));
    const client = createOpenFoodFactsClient({ contact, fetch });
    expect(client.configured).toBe(false);
    expect(await client.lookup(EAN13)).toEqual({ kind: 'unavailable', reason: 'not_configured' });
    expect(calls).toEqual([]);
  });

  it('a plain address is accepted', () => {
    expect(isValidContact('cupmark-ops+off@mail.example.co.uk')).toBe(true);
    expect(createOpenFoodFactsClient({ contact: CONTACT }).configured).toBe(true);
  });
});

describe('answers', () => {
  it('a product with name and brands is a hit with the cleaned name and the first brand', async () => {
    const { outcome } = await lookup(() => product({ product_name: '  Ethiopia\nGuji\u0000 ', brands: 'Rösterei Beispiel, Big Group' }));
    expect(outcome).toEqual({ kind: 'hit', product: { name: 'Ethiopia Guji', brand: 'Rösterei Beispiel' } });
  });

  it('a name alone or a brand alone is a hit with only that field', async () => {
    expect((await lookup(() => product({ product_name: 'Guji' }))).outcome).toEqual({ kind: 'hit', product: { name: 'Guji' } });
    expect((await lookup(() => product({ product_name: '   ', brands: 'Acme' }))).outcome).toEqual({ kind: 'hit', product: { brand: 'Acme' } });
  });

  it('long text is cut to the contract limits in code points', async () => {
    const { outcome } = await lookup(() => product({ product_name: '\u{1F375}'.repeat(200), brands: 'b'.repeat(300) }));
    expect(outcome.kind).toBe('hit');
    if (outcome.kind !== 'hit') return;
    expect(Array.from(outcome.product.name ?? '')).toHaveLength(150);
    expect(outcome.product.brand).toBe('b'.repeat(100));
  });

  it('only the asked fields are read; anything else in the product is ignored', async () => {
    const { outcome } = await lookup(() => product({ product_name: 'Guji', image_front_url: 'https://evil.example/x.jpg', ingredients_text: 'x', __proto__: { brand: 'y' } }));
    expect(outcome).toEqual({ kind: 'hit', product: { name: 'Guji' } });
  });

  it.each([
    ['HTTP 404 with status 0', () => jsonResponse({ code: EAN13, status: 0, status_verbose: 'product not found' }, 404)],
    ['HTTP 200 with status 0', () => jsonResponse({ code: EAN13, status: 0, status_verbose: 'product not found' })],
    ['a product without name or brand', () => product({ product_name: '', brands: ' , ' })],
    ['a product with null fields', () => product({ product_name: null, brands: null })],
    ['an empty product', () => product({})],
  ])('%s is a miss', async (_name, respond) => {
    expect((await lookup(respond)).outcome).toEqual({ kind: 'miss' });
  });

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['HTTP 404 without the not-found body (a moved API)', () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }), 'content_type'],
    ['HTTP 404 with JSON but no status 0', () => jsonResponse({ error: 'no route' }, 404), 'status'],
    ['HTTP 429 (rate limited)', () => jsonResponse({}, 429), 'status'],
    ['HTTP 500', () => new Response('oops', { status: 500 }), 'status'],
    ['HTTP 503', () => jsonResponse({}, 503), 'status'],
    ['HTTP 204', () => new Response(null, { status: 204 }), 'status'],
    ['HTML with HTTP 200', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'content_type'],
    ['no content type', () => new Response('{}', { status: 200 }), 'content_type'],
    ['invalid JSON', () => new Response('{"status":1,', { status: 200, headers: { 'content-type': 'application/json' } }), 'malformed'],
    ['invalid UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { 'content-type': 'application/json' } }), 'malformed'],
    ['a JSON array', () => jsonResponse([1, 2]), 'malformed'],
    ['status 1 without a product', () => jsonResponse({ status: 1 }), 'malformed'],
    ['an unknown status', () => jsonResponse({ status: 2, product: { product_name: 'x' } }), 'malformed'],
    ['a name that is not a string', () => product({ product_name: ['x'] }), 'malformed'],
    ['a number as name', () => product({ product_name: 42, brands: 'Acme' }), 'malformed'],
    ['brands as an array', () => product({ product_name: 'Guji', brands: ['Acme'] }), 'malformed'],
    ['a network error', () => Promise.reject(new TypeError('fetch failed')), 'network'],
  ])('%s is unavailable (%s)', async (_name, respond, reason) => {
    expect((await lookup(respond)).outcome).toEqual({ kind: 'unavailable', reason });
  });
});

describe('redirects and foreign hosts', () => {
  it.each([301, 302, 303, 307, 308])('a %i is unavailable and its target is never asked', async (status) => {
    const { outcome, calls } = await lookup(() => new Response(null, { status, headers: { location: 'https://evil.example/steal' } }));
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'redirect' });
    expect(calls.map((c) => c.url)).toEqual([EXPECTED_URL]);
  });

  it('a response that says it was redirected is unavailable', async () => {
    const { outcome } = await lookup(() => {
      const response = product({ product_name: 'x' });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'redirect' });
  });

  it('a response from another URL or host is unavailable', async () => {
    for (const url of ['https://evil.example/api/v2/product/4006381333931.json', 'https://world.openfoodfacts.org/api/v2/product/0000000000000.json']) {
      const { outcome } = await lookup(() => {
        const response = product({ product_name: 'x' });
        Object.defineProperty(response, 'url', { value: url });
        return response;
      });
      expect(outcome).toEqual({ kind: 'unavailable', reason: 'redirect' });
    }
  });

  it('a response that names the asked URL is fine', async () => {
    const { outcome } = await lookup(() => {
      const response = product({ product_name: 'x' });
      Object.defineProperty(response, 'url', { value: EXPECTED_URL });
      return response;
    });
    expect(outcome.kind).toBe('hit');
  });
});

describe('limits', () => {
  it('a fetch that does not answer in time is a timeout, and the signal is aborted', async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const { outcome } = await lookup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
          });
        }),
      { timeoutMs: 30 },
    );
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a fetch that ignores the signal still ends at the deadline', async () => {
    const { outcome } = await lookup(() => new Promise<Response>(() => undefined), { timeoutMs: 30 });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('a body that never ends is a timeout', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":1,'));
      },
    });
    const { outcome } = await lookup(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), { timeoutMs: 30 });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('the default deadline is about 3 seconds', async () => {
    const { DEFAULT_TIMEOUT_MS } = await import('../../src/openfoodfacts/client.ts');
    expect(DEFAULT_TIMEOUT_MS).toBe(3000);
  });

  it('a declared length over the limit is too_large, before the body is read', async () => {
    const { outcome } = await lookup(() => product({ product_name: 'x' }), { maxResponseBytes: 10 });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'too_large' });
    const declared = await lookup(() => jsonResponse({ status: 1, product: {} }, 200, { 'content-length': String(10 ** 9) }));
    expect(declared.outcome).toEqual({ kind: 'unavailable', reason: 'too_large' });
  });

  it('a streamed body over the limit is too_large, without a declared length', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const { outcome } = await lookup(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), { maxResponseBytes: 4096 });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'too_large' });
    expect(pulled).toBeLessThan(10);
  });
});
