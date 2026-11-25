// GET /catalogue_images/{image_id} (task M1-T4c; ADR 0011; contracts/openapi.yaml,
// getCatalogueImage). The server's stored copy of an Open Food Facts front
// image, so the app never contacts Open Food Facts.
//
// - Behind the token like every route; the image id is checked against the
//   contract's `Id` (a ULID) by the router before this runs. A query or a body
//   is 400.
// - Reads `catalogue/<image_id>.jpg` from the photo bucket. No such object is
//   404, and so is a server without a usable PHOTO_BUCKET (the contract
//   declares no 503 here; the log names the cause).
// - 200 carries the bytes base64-encoded, as the HTTP API proxy integration
//   needs for binary bodies, with `Content-Type: image/jpeg`,
//   `X-Content-Type-Options: nosniff` and `Cache-Control: private,
//   max-age=31536000, immutable`:
//   - immutable for a year, because an id names one copy forever: a new copy
//     gets a new ULID and an object is never overwritten;
//   - private, not public, because the response answers a request with an
//     Authorization header: only the app's own cache may keep it, never a
//     shared cache or CDN. The image is shared catalogue data, but serving it
//     only to signed-in users is the contract's choice, and a shared cache
//     would undo it.
// - Anything stored over MAX_CATALOGUE_IMAGE_BYTES, or that does not start
//   like a JPEG, is refused with 500: the API only ever stores stripped JPEGs
//   within the limit, so such an object is not one of ours.
import type { CatalogueImageStore } from '../images/catalogue-store.ts';
import { MAX_CATALOGUE_IMAGE_BYTES } from '../images/limits.ts';
import type { ApiResult } from './http.ts';
import { empty } from './http.ts';

export const CATALOGUE_IMAGE_HEADERS = {
  'content-type': 'image/jpeg',
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, max-age=31536000, immutable',
} as const;

export interface CatalogueImageOutcome {
  readonly result: ApiResult;
  readonly error?: string;
  readonly reason?: string;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function getCatalogueImage(images: CatalogueImageStore | undefined, imageId: string): Promise<CatalogueImageOutcome> {
  if (images === undefined) return { result: empty(404), error: 'PhotoBucketNotConfigured' };
  let read;
  try {
    read = await images.get(imageId);
  } catch (error) {
    return { result: empty(500), error: error instanceof Error ? error.name : 'unknown' };
  }
  if (read.kind === 'missing') return { result: empty(404), error: 'CatalogueImageNotFound', reason: read.reason };
  if (read.bytes.byteLength > MAX_CATALOGUE_IMAGE_BYTES) return { result: empty(500), error: 'CatalogueImageTooLargeError' };
  if (!looksLikeJpeg(read.bytes)) return { result: empty(500), error: 'CatalogueImageNotJpeg' };
  return {
    result: {
      statusCode: 200,
      headers: { ...CATALOGUE_IMAGE_HEADERS },
      body: Buffer.from(read.bytes).toString('base64'),
      isBase64Encoded: true,
    },
  };
}
