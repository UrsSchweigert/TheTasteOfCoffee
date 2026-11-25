// The catalogue image store (M1-T4c) with a stubbed S3 client: the key, the
// bucket check, what is written, the size limit on reads, missing objects,
// and the copy step (fetch, strip, store) with every failure ending in "no
// image" rather than an error. No test calls AWS.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  CatalogueImageTooLargeError,
  InvalidImageIdError,
  MAX_CATALOGUE_IMAGE_BYTES,
  catalogueImageKey,
  isOwnBucketName,
  s3CatalogueImageStore,
} from '../../src/images/catalogue-store.ts';
import type { CatalogueImageStore } from '../../src/images/catalogue-store.ts';
import type { ImageFetchOutcome, OpenFoodFactsClient } from '../../src/openfoodfacts/client.ts';
import { copyFrontImage, isTransientCopyFailure } from '../../src/openfoodfacts/image-copy.ts';
import type { ImageCopyFailure } from '../../src/openfoodfacts/image-copy.ts';
import { contains, jpegWithMetadata, minimalJpeg } from './jpeg-fixtures.ts';

const ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
const BUCKET = 'cupmark-dev-photos-123456789012';
const IMAGE = 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg';
const EAN13 = '4006381333931';

type Send = (command: unknown, options?: unknown) => Promise<unknown>;

function s3Stub(respond: Send = () => Promise.resolve({})): { client: Pick<S3Client, 'send'>; sent: { command: unknown; options: unknown }[] } {
  const sent: { command: unknown; options: unknown }[] = [];
  const send: Send = async (command, options) => {
    sent.push({ command, options });
    return respond(command, options);
  };
  return { client: { send }, sent };
}

const s3Error = (name: string): Error => Object.assign(new Error('s3 said no'), { name });
const body = (bytes: Uint8Array): { transformToByteArray: () => Promise<Uint8Array> } => ({ transformToByteArray: () => Promise.resolve(bytes) });

function store(client: Pick<S3Client, 'send'>): CatalogueImageStore {
  const built = s3CatalogueImageStore(client, BUCKET);
  if (built === undefined) throw new Error('store not built');
  return built;
}

describe('keys and bucket', () => {
  it('the key is catalogue/<ULID>.jpg', () => {
    expect(catalogueImageKey(ID)).toBe(`catalogue/${ID}.jpg`);
  });

  it.each(['', 'x', ID.toLowerCase(), `${ID}/../x`, '../secret', `${ID}.jpg`, 'I'.repeat(26), `${ID}A`])('refuses the id %j', (id) => {
    expect(() => catalogueImageKey(id)).toThrow(InvalidImageIdError);
  });

  it.each([
    ['missing', undefined, false],
    ['empty', '', false],
    ['another project', 'derschweigert-photos', false],
    ['upper case', 'cupmark-DEV-photos', false],
    ['a slash', 'cupmark-dev/x', false],
    ['a double hyphen', 'cupmark--x', false],
    ['the photo bucket', BUCKET, true],
  ])('a bucket name that is %s: %s', (_name, name, ok) => {
    expect(isOwnBucketName(name)).toBe(ok);
    expect(s3CatalogueImageStore(s3Stub().client, name) !== undefined).toBe(ok);
  });
});

describe('put', () => {
  it('writes the bytes as image/jpeg under the key, with no metadata, and a deadline', async () => {
    const { client, sent } = s3Stub();
    const jpeg = minimalJpeg();
    await store(client).put(ID, jpeg);
    expect(sent).toHaveLength(1);
    const command = sent[0]?.command;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toEqual({ Bucket: BUCKET, Key: `catalogue/${ID}.jpg`, Body: jpeg, ContentType: 'image/jpeg', ContentLength: jpeg.byteLength });
    expect((sent[0]?.options as { abortSignal?: unknown }).abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a bad id or an image over the limit without a call', async () => {
    const { client, sent } = s3Stub();
    await expect(store(client).put('nope', minimalJpeg())).rejects.toBeInstanceOf(InvalidImageIdError);
    await expect(store(client).put(ID, new Uint8Array(MAX_CATALOGUE_IMAGE_BYTES + 1))).rejects.toBeInstanceOf(CatalogueImageTooLargeError);
    expect(sent).toEqual([]);
  });

  it('passes S3 errors on', async () => {
    const { client } = s3Stub(() => Promise.reject(s3Error('InternalError')));
    await expect(store(client).put(ID, minimalJpeg())).rejects.toThrow('s3 said no');
  });
});

describe('get', () => {
  it('reads the key and returns the bytes', async () => {
    const jpeg = minimalJpeg();
    const { client, sent } = s3Stub(() => Promise.resolve({ ContentLength: jpeg.byteLength, Body: body(jpeg) }));
    expect(await store(client).get(ID)).toEqual({ kind: 'found', bytes: jpeg });
    expect((sent[0]?.command as GetObjectCommand).input).toEqual({ Bucket: BUCKET, Key: `catalogue/${ID}.jpg` });
    expect(sent[0]?.command).toBeInstanceOf(GetObjectCommand);
  });

  it.each([
    ['NoSuchKey', 'NoSuchKey'],
    ['NotFound', 'NoSuchKey'],
    ['AccessDenied', 'AccessDenied'],
  ])('%s is missing', async (name, reason) => {
    const { client } = s3Stub(() => Promise.reject(s3Error(name)));
    expect(await store(client).get(ID)).toEqual({ kind: 'missing', reason });
  });

  it('other errors are passed on', async () => {
    const { client } = s3Stub(() => Promise.reject(s3Error('SlowDown')));
    await expect(store(client).get(ID)).rejects.toThrow('s3 said no');
  });

  it('refuses an object over the limit, of unknown size, or larger than it said', async () => {
    let destroyed = false;
    const big = { ...body(new Uint8Array(1)), destroy: () => (destroyed = true) };
    for (const response of [
      { ContentLength: MAX_CATALOGUE_IMAGE_BYTES + 1, Body: big },
      { Body: body(minimalJpeg()) },
      {},
      { ContentLength: 10, Body: body(new Uint8Array(MAX_CATALOGUE_IMAGE_BYTES + 1)) },
    ]) {
      const { client } = s3Stub(() => Promise.resolve(response));
      await expect(store(client).get(ID)).rejects.toBeInstanceOf(CatalogueImageTooLargeError);
    }
    expect(destroyed).toBe(true);
  });

  it('a bad id never reaches S3', async () => {
    const { client, sent } = s3Stub();
    await expect(store(client).get('../x')).rejects.toBeInstanceOf(InvalidImageIdError);
    expect(sent).toEqual([]);
  });
});

describe('isTransientCopyFailure', () => {
  it.each<[ImageCopyFailure, boolean]>([
    ['timeout', true],
    ['network', true],
    ['server_status', true],
    ['store_failed', true],
    ['no_store', true],
    ['not_configured', true],
    ['invalid_url', false],
    ['redirect', false],
    ['client_status', false],
    ['content_type', false],
    ['too_large', false],
    ['not_jpeg', false],
  ])('%s: %s', (reason, transient) => {
    expect(isTransientCopyFailure(reason)).toBe(transient);
  });
});

describe('copyFrontImage', () => {
  function memoryStore(fail = false): CatalogueImageStore & { objects: Map<string, Uint8Array> } {
    const objects = new Map<string, Uint8Array>();
    return {
      objects,
      put(imageId, jpeg) {
        if (fail) return Promise.reject(s3Error('InternalError'));
        objects.set(imageId, jpeg);
        return Promise.resolve();
      },
      get() {
        return Promise.reject(new Error('not used'));
      },
    };
  }
  const client = (outcome: ImageFetchOutcome | Error, seen: string[] = []): Pick<OpenFoodFactsClient, 'fetchImage'> => ({
    fetchImage: (url) => {
      seen.push(url);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  });

  it('fetches, strips all metadata and stores under a new id', async () => {
    const images = memoryStore();
    const seen: string[] = [];
    const outcome = await copyFrontImage({ client: client({ kind: 'image', bytes: jpegWithMetadata() }, seen), store: images, newId: () => ID }, IMAGE, EAN13);
    expect(outcome).toEqual({ kind: 'stored', imageId: ID });
    expect(seen).toEqual([IMAGE]);
    const stored = images.objects.get(ID);
    expect(stored).toBeDefined();
    for (const secret of ['Exif', 'GPSLatitude', 'XMP-AUTHOR', 'ICC_PROFILE', 'COMMENT-SECRET', 'TRAILING-SECRET']) expect(contains(stored ?? new Uint8Array(), secret)).toBe(false);
  });

  it('a default id is a ULID', async () => {
    const outcome = await copyFrontImage({ client: client({ kind: 'image', bytes: minimalJpeg() }), store: memoryStore() }, IMAGE, EAN13);
    expect(outcome.kind === 'stored' ? outcome.imageId : '').toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('without a store nothing is fetched', async () => {
    const seen: string[] = [];
    expect(await copyFrontImage({ client: client({ kind: 'image', bytes: minimalJpeg() }, seen), store: undefined }, IMAGE, EAN13)).toEqual({ kind: 'failed', reason: 'no_store' });
    expect(seen).toEqual([]);
  });

  it.each<[string, ImageFetchOutcome | Error, boolean, string]>([
    ['a failed fetch', { kind: 'failed', reason: 'redirect' }, false, 'redirect'],
    ['a thrown fetch', new TypeError('boom'), false, 'network'],
    ['bytes that are not a JPEG', { kind: 'image', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) }, false, 'not_jpeg'],
    ['a truncated JPEG', { kind: 'image', bytes: minimalJpeg().subarray(0, 40) }, false, 'not_jpeg'],
    ['an S3 failure', { kind: 'image', bytes: minimalJpeg() }, true, 'store_failed'],
  ])('%s is no image, never an error', async (_name, fetched, failStore, reason) => {
    const images = memoryStore(failStore);
    expect(await copyFrontImage({ client: client(fetched), store: images, newId: () => ID }, IMAGE, EAN13)).toEqual({ kind: 'failed', reason });
    expect(images.objects.size).toBe(0);
  });
});
