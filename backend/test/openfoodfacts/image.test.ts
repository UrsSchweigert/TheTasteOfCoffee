// The front image (M1-T4c, ADR 0011): which URL may be followed, how the read
// API's `image_front_url` is taken (fail safe), and the image download with a
// stubbed fetch: no redirects, image/jpeg only, a size limit, a deadline. No
// test reaches Open Food Facts.
import { describe, expect, it } from 'vitest';
import { MAX_CATALOGUE_IMAGE_BYTES } from '../../src/images/limits.ts';
import { DEFAULT_IMAGE_TIMEOUT_MS, OPEN_FOOD_FACTS_FIELDS, createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import type { Fetch, FetchOutcome, ImageFetchOutcome } from '../../src/openfoodfacts/client.ts';
import { frontImageUrl } from '../../src/openfoodfacts/image-url.ts';
import { minimalJpeg } from '../images/jpeg-fixtures.ts';

const CONTACT = 'operator@example.org';
const EAN13 = '4006381333931';
const UPC_A = '036000291452';
const IMAGE = `https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg`;
const UPC_IMAGE = 'https://images.openfoodfacts.org/images/products/003/600/029/1452/front_en.12.400.jpg';

describe('frontImageUrl', () => {
  it.each([
    ['the 400 display image', IMAGE],
    ['another language and revision', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_fr.123456.400.jpg'],
    ['a three-letter language', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_fil.3.400.jpg'],
    ['no language', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front.3.400.jpg'],
    ['size 100', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.100.jpg'],
    ['size 200', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.200.jpg'],
    ['full size', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.full.jpg'],
  ])('follows %s', (_name, url) => {
    expect(frontImageUrl(url, EAN13)).toBe(url);
  });

  it('a UPC-A product is matched by its 13-digit form', () => {
    expect(frontImageUrl(UPC_IMAGE, `0${UPC_A}`)).toBe(UPC_IMAGE);
  });

  it.each([
    ['http', IMAGE.replace('https:', 'http:')],
    ['another host', IMAGE.replace('images.openfoodfacts.org', 'evil.example')],
    ['the read API host', IMAGE.replace('images.', 'world.')],
    ['static host', IMAGE.replace('images.', 'static.')],
    ['a look-alike host', IMAGE.replace('images.openfoodfacts.org', 'images.openfoodfacts.org.evil.example')],
    ['a subdomain', IMAGE.replace('images.', 'x.images.')],
    ['an upper-case host', IMAGE.replace('images.openfoodfacts.org', 'IMAGES.openfoodfacts.org')],
    ['a trailing dot on the host', IMAGE.replace('openfoodfacts.org', 'openfoodfacts.org.')],
    ['userinfo', IMAGE.replace('https://', 'https://user:pass@')],
    ['a user without password', IMAGE.replace('https://', 'https://user@')],
    ['a port', IMAGE.replace('.org/', '.org:8443/')],
    ['the default port spelled out', IMAGE.replace('.org/', '.org:443/')],
    ['a query', `${IMAGE}?x=1`],
    ['an empty query', `${IMAGE}?`],
    ['a fragment', `${IMAGE}#x`],
    ['another EAN', IMAGE.replace('3931', '3932')],
    ['the EAN split differently', 'https://images.openfoodfacts.org/images/products/4006/381/333/931/front_de.3.400.jpg'],
    ['an unsplit EAN', 'https://images.openfoodfacts.org/images/products/4006381333931/front_de.3.400.jpg'],
    ['a dot segment', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/../3931/front_de.3.400.jpg'],
    ['a percent-encoded slash', 'https://images.openfoodfacts.org/images/products/400/638/133/3931%2Ffront_de.3.400.jpg'],
    ['a backslash', 'https://images.openfoodfacts.org\\images/products/400/638/133/3931/front_de.3.400.jpg'],
    ['another image kind', IMAGE.replace('front_de', 'ingredients_de')],
    ['a raw upload', 'https://images.openfoodfacts.org/images/products/400/638/133/3931/1.jpg'],
    ['a PNG', IMAGE.replace('.jpg', '.png')],
    ['an unknown size', IMAGE.replace('.400.', '.800.')],
    ['white space', ` ${IMAGE}`],
    ['a line break', `${IMAGE}\n`],
    ['a protocol-relative URL', IMAGE.replace('https:', '')],
    ['a data URL', 'data:image/jpeg;base64,/9j/'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(frontImageUrl(url, EAN13)).toBeUndefined();
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['an array', [IMAGE]],
    ['an object', { url: IMAGE }],
    ['undefined', undefined],
    ['a very long string', `${IMAGE}${'a'.repeat(300)}`],
  ])('refuses %s', (_name, value) => {
    expect(frontImageUrl(value, EAN13)).toBeUndefined();
  });

  it('refuses a barcode that is not 13 digits', () => {
    expect(frontImageUrl(UPC_IMAGE, UPC_A)).toBeUndefined();
  });
});

const product = (fields: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ status: 1, product: fields }), { status: 200, headers: { 'content-type': 'application/json' } });

async function lookup(fields: Record<string, unknown>, barcode = EAN13): Promise<FetchOutcome> {
  const client = createOpenFoodFactsClient({ contact: CONTACT, fetch: () => Promise.resolve(product(fields)) });
  return client.lookup(barcode);
}

describe('image_front_url in the lookup', () => {
  it('is asked for', () => {
    expect(OPEN_FOOD_FACTS_FIELDS).toBe('product_name,brands,image_front_url');
  });

  it('a valid URL for the same EAN comes with the hit', async () => {
    expect(await lookup({ product_name: 'Guji', image_front_url: IMAGE })).toEqual({ kind: 'hit', product: { name: 'Guji' }, imageUrl: IMAGE });
    expect(await lookup({ brands: 'Acme', image_front_url: UPC_IMAGE }, UPC_A)).toEqual({ kind: 'hit', product: { brand: 'Acme' }, imageUrl: UPC_IMAGE });
  });

  it.each([
    ['missing', {}],
    ['null', { image_front_url: null }],
    ['a number', { image_front_url: 7 }],
    ['an object', { image_front_url: { en: IMAGE } }],
    ['another host', { image_front_url: IMAGE.replace('images.openfoodfacts.org', 'evil.example') }],
    ['another EAN', { image_front_url: IMAGE.replace('3931', '3932') }],
    ['http', { image_front_url: IMAGE.replace('https:', 'http:') }],
  ])('an image field that is %s is no image, and the hit stays a hit', async (_name, fields) => {
    expect(await lookup({ product_name: 'Guji', ...fields })).toEqual({ kind: 'hit', product: { name: 'Guji' } });
  });

  it('a product with only a valid image is a hit with an empty product and the URL', async () => {
    expect(await lookup({ product_name: '', image_front_url: IMAGE })).toEqual({ kind: 'hit', product: {}, imageUrl: IMAGE });
  });

  it('a product with only an invalid image is a miss', async () => {
    expect(await lookup({ image_front_url: 'https://evil.example/x.jpg' })).toEqual({ kind: 'miss' });
  });
});

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

async function fetchImage(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: { url?: string; barcode?: string; contact?: string; imageTimeoutMs?: number; maxImageBytes?: number } = {},
): Promise<{ outcome: ImageFetchOutcome; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  const client = createOpenFoodFactsClient({
    contact: options.contact ?? CONTACT,
    fetch,
    ...(options.imageTimeoutMs === undefined ? {} : { imageTimeoutMs: options.imageTimeoutMs }),
    ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
  });
  return { outcome: await client.fetchImage(options.url ?? IMAGE, options.barcode ?? EAN13), calls };
}

const jpegResponse = (body: Uint8Array | ReadableStream<Uint8Array> | null = minimalJpeg(), headers: Record<string, string> = {}, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'image/jpeg', ...headers } });

describe('fetchImage', () => {
  it('asks exactly the URL, with the User-Agent, accept image/jpeg, no redirects and a deadline', async () => {
    const { outcome, calls } = await fetchImage(() => jpegResponse());
    expect(outcome).toEqual({ kind: 'image', bytes: minimalJpeg() });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(IMAGE);
    const headers = new Headers(calls[0]?.init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
    expect(headers.get('accept')).toBe('image/jpeg');
    expect(headers.get('user-agent')).toMatch(/^Cupmark\/\S+ \(operator@example\.org\)$/);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts image/jpeg with parameters and in another case', async () => {
    expect((await fetchImage(() => jpegResponse(minimalJpeg(), { 'content-type': 'Image/JPEG; foo=bar' }))).outcome.kind).toBe('image');
  });

  it.each([
    ['another host', IMAGE.replace('images.openfoodfacts.org', 'evil.example')],
    ['another EAN', IMAGE.replace('3931', '3932')],
    ['http', IMAGE.replace('https:', 'http:')],
    ['userinfo', IMAGE.replace('https://', 'https://u:p@')],
    ['a port', IMAGE.replace('.org/', '.org:8443/')],
    ['a query', `${IMAGE}?a=b`],
  ])('never fetches %s', async (_name, url) => {
    const { outcome, calls } = await fetchImage(() => jpegResponse(), { url });
    expect(outcome).toEqual({ kind: 'failed', reason: 'invalid_url' });
    expect(calls).toEqual([]);
  });

  it('without a contact nothing is fetched', async () => {
    const { outcome, calls } = await fetchImage(() => jpegResponse(), { contact: 'nope' });
    expect(outcome).toEqual({ kind: 'failed', reason: 'not_configured' });
    expect(calls).toEqual([]);
  });

  it.each([301, 302, 303, 307, 308])('a %i is a failure and its target is never asked', async (status) => {
    const { outcome, calls } = await fetchImage(() => new Response(null, { status, headers: { location: 'https://evil.example/x.jpg' } }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'redirect' });
    expect(calls.map((c) => c.url)).toEqual([IMAGE]);
  });

  it('a response marked redirected or from another URL is a failure', async () => {
    for (const [property, value] of [
      ['redirected', true],
      ['url', 'https://evil.example/x.jpg'],
    ] as const) {
      const { outcome } = await fetchImage(() => {
        const response = jpegResponse();
        Object.defineProperty(response, property, { value });
        return response;
      });
      expect(outcome).toEqual({ kind: 'failed', reason: 'redirect' });
    }
  });

  it.each<[number, string]>([
    [404, 'client_status'],
    [403, 'client_status'],
    [410, 'client_status'],
    [204, 'client_status'],
    [429, 'server_status'],
    [500, 'server_status'],
    [502, 'server_status'],
    [503, 'server_status'],
  ])('HTTP %i is a failure (%s)', async (status, reason) => {
    const { outcome } = await fetchImage(() => new Response(status === 204 ? null : 'x', { status, headers: { 'content-type': 'image/jpeg' } }));
    expect(outcome).toEqual({ kind: 'failed', reason });
  });

  it.each([
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['text/html', 'text/html'],
    ['image/jpg', 'image/jpg'],
    ['image/pjpeg', 'image/pjpeg'],
    ['image/jpeg-x', 'image/jpeg-x'],
    ['application/octet-stream', 'application/octet-stream'],
  ])('content type %s is a failure', async (_name, type) => {
    const { outcome } = await fetchImage(() => jpegResponse(minimalJpeg(), { 'content-type': type }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'content_type' });
  });

  it('no content type is a failure', async () => {
    const { outcome } = await fetchImage(() => new Response(minimalJpeg(), { status: 200 }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'content_type' });
  });

  it('the default limit is 1 MiB and the default deadline 2.5 s', () => {
    expect(MAX_CATALOGUE_IMAGE_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_IMAGE_TIMEOUT_MS).toBe(2500);
  });

  it('a body of exactly the limit is fine; one byte more is too_large', async () => {
    const limit = 64;
    expect((await fetchImage(() => jpegResponse(new Uint8Array(limit)), { maxImageBytes: limit })).outcome.kind).toBe('image');
    expect((await fetchImage(() => jpegResponse(new Uint8Array(limit + 1)), { maxImageBytes: limit })).outcome).toEqual({ kind: 'failed', reason: 'too_large' });
  });

  it('a declared length over the limit is too_large before the body is read', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { outcome } = await fetchImage(() => jpegResponse(body, { 'content-length': String(MAX_CATALOGUE_IMAGE_BYTES + 1) }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'too_large' });
    expect(pulled).toBe(false);
  });

  it('a streamed body over the default limit is too_large and stops being read', async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const { outcome } = await fetchImage(() => jpegResponse(body));
    expect(outcome).toEqual({ kind: 'failed', reason: 'too_large' });
    expect(chunks).toBeLessThan(40);
  });

  it('a fetch or body that never ends is a timeout', async () => {
    expect((await fetchImage(() => new Promise<Response>(() => undefined), { imageTimeoutMs: 30 })).outcome).toEqual({ kind: 'failed', reason: 'timeout' });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xff, 0xd8));
      },
    });
    expect((await fetchImage(() => jpegResponse(body), { imageTimeoutMs: 30 })).outcome).toEqual({ kind: 'failed', reason: 'timeout' });
  });

  it('a network error is a failure', async () => {
    expect((await fetchImage(() => Promise.reject(new TypeError('fetch failed')))).outcome).toEqual({ kind: 'failed', reason: 'network' });
  });
});
