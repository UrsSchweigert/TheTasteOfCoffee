// The Open Food Facts image copy and GET /catalogue_images/{image_id}
// (M1-T4c), through the router with the in-memory store, a stubbed fetch and
// an in-memory image store: no test reaches Open Food Facts or AWS. A hit
// carries the id of its stored copy into the cache, the answer and a
// confirmed bean; every failure of the copy still caches the hit without an
// image; the image is copied once; the GET route's answers and headers; logs
// without a barcode, an image URL or an image id.
import { describe, expect, it } from 'vitest';
import { CATALOGUE_IMAGE_HEADERS } from '../../src/api/catalogue-images.ts';
import type { ApiResult } from '../../src/api/http.ts';
import { createApi } from '../../src/api/router.ts';
import { BeanSchema, OpenFoodFactsProductSchema } from '../../src/generated/contract.ts';
import type { CatalogueImageRead, CatalogueImageStore } from '../../src/images/catalogue-store.ts';
import { MAX_CATALOGUE_IMAGE_BYTES } from '../../src/images/limits.ts';
import { createOpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import type { Fetch } from '../../src/openfoodfacts/client.ts';
import { contains, jpegWithMetadata, minimalJpeg } from '../images/jpeg-fixtures.ts';
import { ALICE_SUB, BOB_SUB, apiEvent, beanBody, harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

const CONTACT = 'operator@example.org';
const EAN13 = '4006381333931';
const NAME = 'Ethiopia Guji Natural';
const IMAGE = 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg';
const IMAGE_ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
const OTHER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

class MemoryImages implements CatalogueImageStore {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly calls: string[] = [];
  public failPut = false;
  public getResult: ((id: string) => Promise<CatalogueImageRead>) | undefined;

  public put(imageId: string, jpeg: Uint8Array): Promise<void> {
    this.calls.push('put');
    if (this.failPut) return Promise.reject(Object.assign(new Error('s3 down'), { name: 'InternalError' }));
    this.objects.set(imageId, jpeg);
    return Promise.resolve();
  }

  public get(imageId: string): Promise<CatalogueImageRead> {
    this.calls.push('get');
    if (this.getResult !== undefined) return this.getResult(imageId);
    const bytes = this.objects.get(imageId);
    return Promise.resolve(bytes === undefined ? { kind: 'missing', reason: 'NoSuchKey' } : { kind: 'found', bytes });
  }
}

const productResponse = (fields: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ status: 1, product: fields }), { status: 200, headers: { 'content-type': 'application/json' } });
const jpegResponse = (bytes: Uint8Array = jpegWithMetadata()): Response => new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });

interface Setup extends Harness {
  readonly images: MemoryImages;
  readonly fetched: string[];
}

function setup(
  options: { product?: Record<string, unknown>; image?: () => Response | Promise<Response>; images?: MemoryImages | null; ids?: string[] } = {},
): Setup {
  const fetched: string[] = [];
  const fetch: Fetch = async (url) => {
    fetched.push(url);
    if (url.startsWith('https://world.openfoodfacts.org/')) return productResponse(options.product ?? { product_name: NAME, image_front_url: IMAGE });
    return (options.image ?? (() => jpegResponse()))();
  };
  const images = options.images === null ? new MemoryImages() : (options.images ?? new MemoryImages());
  const ids = [...(options.ids ?? [IMAGE_ID])];
  const h = harness({
    openFoodFacts: {
      client: createOpenFoodFactsClient({ contact: CONTACT, fetch, timeoutMs: 200, imageTimeoutMs: 50 }),
      dailyCap: 50,
      newImageId: () => ids.shift() ?? OTHER_ID,
    },
    ...(options.images === null ? {} : { catalogueImages: images }),
  });
  return Object.assign(h, { images, fetched });
}

const lookup = (h: Harness, sub = ALICE_SUB): ReturnType<Harness['call']> => h.call('GET', `/barcodes/${EAN13}/open_food_facts`, { sub });

describe('the image copy in GET /barcodes/{barcode}/open_food_facts', () => {
  it('a hit with a front image stores a stripped copy and answers its image_id; the cache holds it', async () => {
    const h = setup();
    const response = await lookup(h);
    expect(response.status).toBe(200);
    expect(OpenFoodFactsProductSchema.parse(response.body)).toEqual({ name: NAME, image_id: IMAGE_ID });
    expect(h.fetched).toEqual([`https://world.openfoodfacts.org/api/v2/product/${EAN13}.json?fields=product_name,brands,image_front_url`, IMAGE]);
    const stored = h.images.objects.get(IMAGE_ID);
    expect(stored?.[0]).toBe(0xff);
    for (const secret of ['Exif', 'GPSLatitude', 'XMP-AUTHOR', 'ICC_PROFILE', 'COMMENT-SECRET']) expect(contains(stored ?? new Uint8Array(), secret)).toBe(false);
    expect(h.store.openFoodFactsCache.get(EAN13)?.entry).toEqual({ kind: 'hit', product: { name: NAME, image_id: IMAGE_ID } });
    expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 200, request_id: 'request-1', image: 'stored' });
  });

  it('copies once: the cached hit answers later lookups with the same image_id and no fetch', async () => {
    const h = setup();
    await lookup(h);
    const again = await lookup(h, BOB_SUB);
    expect(again.body).toEqual({ name: NAME, image_id: IMAGE_ID });
    expect(h.fetched).toHaveLength(2);
    expect(h.images.calls).toEqual(['put']);
    expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 200, request_id: 'request-1' });
  });

  it('a confirmed bean carries the image_id from the cache', async () => {
    const h = setup();
    await lookup(h);
    const created = await h.call('POST', '/beans', { json: beanBody({ barcode: EAN13, open_food_facts_confirmed: true }) });
    expect(created.status).toBe(201);
    expect(BeanSchema.parse(created.body).open_food_facts).toEqual({ name: NAME, image_id: IMAGE_ID });
  });

  it.each<[string, Parameters<typeof setup>[0], string]>([
    ['a redirect', { image: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } }) }, 'redirect'],
    ['a 404', { image: () => new Response('no', { status: 404 }) }, 'client_status'],
    ['a 503', { image: () => new Response('busy', { status: 503 }) }, 'server_status'],
    ['a PNG content type', { image: () => new Response(minimalJpeg(), { status: 200, headers: { 'content-type': 'image/png' } }) }, 'content_type'],
    ['an oversize body', { image: () => jpegResponse(new Uint8Array(MAX_CATALOGUE_IMAGE_BYTES + 1)) }, 'too_large'],
    ['a malformed JPEG', { image: () => jpegResponse(minimalJpeg().subarray(0, 30)) }, 'not_jpeg'],
    ['a network error', { image: () => Promise.reject(new TypeError('fetch failed')) }, 'network'],
    ['a timeout', { image: () => new Promise<Response>(() => undefined) }, 'timeout'],
    ['an S3 failure', { images: Object.assign(new MemoryImages(), { failPut: true }) }, 'store_failed'],
    ['no photo bucket', { images: null }, 'no_store'],
  ])('%s still caches the hit, without an image', async (_name, options, code) => {
    const h = setup(options);
    const response = await lookup(h);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: NAME });
    expect(h.store.openFoodFactsCache.get(EAN13)?.entry).toEqual({ kind: 'hit', product: { name: NAME } });
    expect(h.images.objects.size).toBe(0);
    expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 200, request_id: 'request-1', image: code });
    // The hit is not retried for its image: the next lookup is a cache answer.
    await lookup(h);
    expect(h.fetched.filter((url) => url.startsWith('https://world.'))).toHaveLength(1);
  });

  it('without a photo bucket the image is not even downloaded', async () => {
    const h = setup({ images: null });
    await lookup(h);
    expect(h.fetched).toHaveLength(1);
  });

  it.each([
    ['another host', 'https://evil.example/images/products/400/638/133/3931/front_de.3.400.jpg'],
    ['another EAN', IMAGE.replace('3931', '3932')],
    ['http', IMAGE.replace('https:', 'http:')],
    ['userinfo', IMAGE.replace('https://', 'https://a:b@')],
    ['a port', IMAGE.replace('.org/', '.org:444/')],
    ['a number', 12],
  ])('an image URL with %s is never fetched; the hit has no image', async (_name, url) => {
    const h = setup({ product: { product_name: NAME, image_front_url: url } });
    const response = await lookup(h);
    expect(response.body).toEqual({ name: NAME });
    expect(h.fetched).toHaveLength(1);
    expect(h.logs.at(-1)?.image).toBe('none');
  });

  it('a product with only a front image is a hit with only image_id', async () => {
    const h = setup({ product: { image_front_url: IMAGE } });
    const response = await lookup(h);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ image_id: IMAGE_ID });
  });

  describe('a product with only a front image whose copy fails', () => {
    const imageOnly = { image_front_url: IMAGE };

    it.each<[string, Parameters<typeof setup>[0], string]>([
      ['a timeout', { image: () => new Promise<Response>(() => undefined) }, 'timeout'],
      ['a network error', { image: () => Promise.reject(new TypeError('fetch failed')) }, 'network'],
      ['HTTP 500', { image: () => new Response('no', { status: 500 }) }, 'server_status'],
      ['HTTP 503', { image: () => new Response('no', { status: 503 }) }, 'server_status'],
      ['HTTP 429', { image: () => new Response('slow down', { status: 429 }) }, 'server_status'],
      ['an S3 failure', { images: Object.assign(new MemoryImages(), { failPut: true }) }, 'store_failed'],
      ['no photo bucket', { images: null }, 'no_store'],
    ])('transiently (%s): 503, nothing cached, the fetch counted, and a later lookup tries again', async (_name, options, code) => {
      const h = setup({ product: imageOnly, ...options });
      const response = await lookup(h);
      expect(response.status).toBe(503);
      expect(response.result.body).toBeUndefined();
      expect(h.store.openFoodFactsCache.has(EAN13)).toBe(false);
      expect([...h.store.lookupCounters.values()]).toEqual([1]);
      expect(h.logs.at(-1)).toEqual({
        operation: 'lookupOpenFoodFacts',
        status: 503,
        request_id: 'request-1',
        error: 'OpenFoodFactsUnavailable',
        reason: 'image_unavailable',
        image: code,
      });
      await lookup(h);
      expect(h.fetched.filter((url) => url.startsWith('https://world.'))).toHaveLength(2);
      expect([...h.store.lookupCounters.values()]).toEqual([2]);
    });

    it.each<[string, Parameters<typeof setup>[0], string]>([
      ['HTTP 404', { image: () => new Response('no', { status: 404 }) }, 'client_status'],
      ['HTTP 403', { image: () => new Response('no', { status: 403 }) }, 'client_status'],
      ['a redirect', { image: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } }) }, 'redirect'],
      ['a PNG content type', { image: () => new Response(minimalJpeg(), { status: 200, headers: { 'content-type': 'image/png' } }) }, 'content_type'],
      ['an oversize body', { image: () => jpegResponse(new Uint8Array(MAX_CATALOGUE_IMAGE_BYTES + 1)) }, 'too_large'],
      ['a malformed JPEG', { image: () => jpegResponse(minimalJpeg().subarray(0, 30)) }, 'not_jpeg'],
    ])('permanently (%s): a cached miss (404), the fetch counted', async (_name, options, code) => {
      const h = setup({ product: imageOnly, ...options });
      const response = await lookup(h);
      expect(response.status).toBe(404);
      expect(h.store.openFoodFactsCache.get(EAN13)?.entry).toEqual({ kind: 'miss' });
      expect([...h.store.lookupCounters.values()]).toEqual([1]);
      expect(h.logs.at(-1)).toEqual({ operation: 'lookupOpenFoodFacts', status: 404, request_id: 'request-1', image: code });
      // The miss answers from the cache: no second fetch.
      await lookup(h);
      expect(h.fetched.filter((url) => url.startsWith('https://world.'))).toHaveLength(1);
    });

    it('an image URL that is refused is no image, so the product is a plain miss with no download', async () => {
      const h = setup({ product: { image_front_url: 'https://evil.example/x.jpg' } });
      expect((await lookup(h)).status).toBe(404);
      expect(h.fetched).toHaveLength(1);
      expect(h.store.openFoodFactsCache.get(EAN13)?.entry).toEqual({ kind: 'miss' });
    });
  });

  it('a race lost to another fetch answers the stored hit; its own copy is left unreferenced', async () => {
    const h = setup();
    // Another fetch cached its hit while this one was copying the image.
    const original = h.store.cacheOpenFoodFactsResult.bind(h.store);
    h.store.cacheOpenFoodFactsResult = async (barcode, result) => {
      h.store.openFoodFactsCache.set(EAN13, { entry: { kind: 'hit', product: { name: 'First', image_id: OTHER_ID } } });
      return original(barcode, result);
    };
    const response = await lookup(h);
    expect(response.body).toEqual({ name: 'First', image_id: OTHER_ID });
    expect([...h.images.objects.keys()]).toEqual([IMAGE_ID]);
  });

  it('no log line carries the barcode, the image URL, an image id, the name or a user id', async () => {
    const h = setup();
    await lookup(h);
    await h.call('GET', `/catalogue_images/${IMAGE_ID}`);
    await h.call('GET', `/catalogue_images/${OTHER_ID}`);
    const text = JSON.stringify(h.logs);
    for (const leaked of [EAN13, IMAGE, 'openfoodfacts', IMAGE_ID, OTHER_ID, NAME, CONTACT, ALICE_SUB]) expect(text).not.toContain(leaked);
  });
});

describe('GET /catalogue_images/{image_id}', () => {
  const get = (h: Harness, id: string, options: Parameters<Harness['call']>[2] = {}): ReturnType<Harness['call']> =>
    h.call('GET', `/catalogue_images/${id}`, options);

  /** The router's raw result: a 200 body is base64, not JSON, so Harness.call cannot parse it. */
  const serve = (h: Setup, id: string, sub = BOB_SUB): Promise<ApiResult> =>
    createApi({ store: h.store, cursorSigner: () => Promise.resolve(h.signer), catalogueImages: h.images, log: () => undefined })(
      apiEvent('GET', `/catalogue_images/${id}`, { sub }),
    );

  it('200: the stored bytes, base64, as image/jpeg with nosniff and a private, immutable year of caching', async () => {
    const h = setup();
    const jpeg = minimalJpeg();
    h.images.objects.set(IMAGE_ID, jpeg);
    const result = await serve(h, IMAGE_ID);
    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body ?? '', 'base64')).toEqual(Buffer.from(jpeg));
    expect(result.headers).toEqual({ 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' });
    expect(CATALOGUE_IMAGE_HEADERS['cache-control']).not.toContain('public');
    expect(h.store.calls).toEqual([]);
  });

  it('serves an image copied by a lookup to any signed-in user', async () => {
    const h = setup();
    await lookup(h);
    const result = await serve(h, IMAGE_ID);
    expect(result.statusCode).toBe(200);
    expect(new Uint8Array(Buffer.from(result.body ?? '', 'base64'))).toEqual(h.images.objects.get(IMAGE_ID));
  });

  it('404 for an id with no stored image, with no body', async () => {
    const h = setup();
    const response = await get(h, OTHER_ID);
    expect(response.status).toBe(404);
    expect(response.result.body).toBeUndefined();
    expect(h.logs.at(-1)).toEqual({ operation: 'getCatalogueImage', status: 404, request_id: 'request-1', error: 'CatalogueImageNotFound', reason: 'NoSuchKey' });
  });

  it('404 when S3 answers AccessDenied (a missing key without s3:ListBucket)', async () => {
    const h = setup();
    h.images.getResult = () => Promise.resolve({ kind: 'missing', reason: 'AccessDenied' });
    expect((await get(h, OTHER_ID)).status).toBe(404);
    expect(h.logs.at(-1)?.reason).toBe('AccessDenied');
  });

  it('404 without a photo bucket', async () => {
    const h = setup({ images: null });
    const response = await get(h, IMAGE_ID);
    expect(response.status).toBe(404);
    expect(h.logs.at(-1)?.error).toBe('PhotoBucketNotConfigured');
  });

  it.each([
    ['lower case', IMAGE_ID.toLowerCase()],
    ['too short', IMAGE_ID.slice(1)],
    ['with .jpg', `${IMAGE_ID}.jpg`],
    ['a path', '..%2F..%2Fsecret'],
    ['a letter outside Crockford base32', `${IMAGE_ID.slice(0, 25)}U`],
  ])('400 for an id that is %s, before S3 is asked', async (_name, id) => {
    const h = setup();
    const response = await get(h, id);
    expect(response.status).toBe(400);
    expect(response.result.body).toBeUndefined();
    expect(h.images.calls).toEqual([]);
  });

  it('400 for a query or a body', async () => {
    const h = setup();
    h.images.objects.set(IMAGE_ID, minimalJpeg());
    expect((await get(h, IMAGE_ID, { query: 'size=full' })).status).toBe(400);
    expect((await get(h, IMAGE_ID, { json: {} })).status).toBe(400);
    expect(h.images.calls).toEqual([]);
  });

  it('401 without a token, before S3 is asked', async () => {
    const h = setup();
    h.images.objects.set(IMAGE_ID, minimalJpeg());
    const response = await get(h, IMAGE_ID, { sub: null });
    expect(response.status).toBe(401);
    expect(response.result.body).toBeUndefined();
    expect(h.images.calls).toEqual([]);
  });

  it('500 for a stored object over the limit, one that is not a JPEG, or an S3 error', async () => {
    const h = setup();
    h.images.objects.set(IMAGE_ID, new Uint8Array(MAX_CATALOGUE_IMAGE_BYTES + 1).fill(0xff));
    expect((await get(h, IMAGE_ID)).status).toBe(500);
    h.images.objects.set(IMAGE_ID, Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    expect((await get(h, IMAGE_ID)).status).toBe(500);
    expect(h.logs.at(-1)?.error).toBe('CatalogueImageNotJpeg');
    h.images.getResult = () => Promise.reject(Object.assign(new Error('x'), { name: 'SlowDown' }));
    const response = await get(h, IMAGE_ID);
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(h.logs.at(-1)?.error).toBe('SlowDown');
  });
});
