// Label photo upload (task M1-T4d; docs/04 F1 step 4; ADR 0016; D10, D12;
// contracts/openapi.yaml, createLabelPhotoUpload and completeLabelPhoto).
//
// POST /beans/{bean_id}/label_photos, in this order:
// 1. 400: a malformed bean id (the router), a query or a body.
// 2. 500 without a usable PHOTO_BUCKET (`PhotoBucketNotConfigured`).
// 3. 404: no such bean, or a rejected one. 409: a verified bean.
// 4. 409: the caller already has LABEL_PHOTOS_PER_BEAN completed photos for
//    the bean (`BEANPHOTOS#<beanId>`). Pending uploads do not count here; the
//    cap is enforced atomically at completion.
// 5. 429: the caller's daily cap of new uploads (LABEL_PHOTO_DAILY_CAP per UTC
//    day, `PHOTO_UPLOADS#<day>`, one atomic conditional ADD) is used up. Only
//    a request that passed 1 to 4 counts.
// 6. A new photo id and the caller's pending item (`PHOTO_PENDING#<photoId>`,
//    the bean id, TTL 1 day), then the presigned POST for
//    `uploads/<photoId>.jpg` (label-photo-store.ts). Its fields are mapped to
//    the contract's snake_case names and the whole answer is checked against
//    the generated `LabelPhotoUpload` schema; any mismatch (an unknown or
//    missing field, another bucket or key, another region) is 500
//    `LabelPhotoUploadInvalid`. 201.
//
// POST /label_photos/{photo_id}/complete, in this order:
// 1. 400: a malformed photo id (the router), a query or a body.
// 2. 500 without a usable PHOTO_BUCKET.
// 3. The caller's pending item. None (unknown, another caller's, expired, or
//    rejected before): 409 if the caller has a completed photo with this id,
//    else 404. Another caller's id is never read, so it looks unknown.
// 4. 409 if the bean is no longer unverified or the caller already has 3
//    photos for it: cheap reads before any S3 work, so the common case leaves
//    no orphan. The transaction checks both again.
// 5. Read `uploads/<photoId>.jpg`: missing (NoSuchKey, or AccessDenied without
//    s3:ListBucket) is 404 and the pending item stays, so the app may still
//    upload and call again while the POST is valid.
// 6. Over 8 MiB (ContentLength before the body is read, the byte count after)
//    or not an acceptable JPEG (jpeg.ts, up to 4096 px a side): 400. The
//    pending item is deleted, so later calls answer 404.
// 7. The stripped bytes go to `labels/<photoId>.jpg`; then the repository
//    records the photo in one transaction (Repository.completeLabelPhoto).
//    A failed condition is 409 (completed meanwhile, bean no longer
//    unverified, cap reached) or 404 (pending item gone). The labels/ object
//    of a failed transaction is left unreferenced (an orphan, logged with
//    reason `label_orphaned`); no route ever serves label photos, and the
//    operator's tooling only follows `BEAN#` / `PHOTO#` items. 204.
//
// Nothing here logs. The router logs operation, status, request id and a
// fixed error and reason code; never the user, photo or bean id, a key, the
// URL, the policy, the signature or a credential.
import type { UserId } from '../auth/user-id.ts';
import { LabelPhotoUploadSchema } from '../generated/contract.ts';
import type { LabelPhotoUpload } from '../generated/contract.ts';
import { stripJpeg } from '../images/jpeg.ts';
import type { LabelPhotoStore, PresignedUpload } from '../images/label-photo-store.ts';
import { MAX_LABEL_PHOTO_BYTES, UPLOAD_EXPIRES_SECONDS, uploadKey } from '../images/label-photo-store.ts';
import {
  BeanNotUnverifiedError,
  ItemNotFoundError,
  LABEL_PHOTOS_PER_BEAN,
  LabelPhotoCapReachedError,
  LabelPhotoCompletedError,
} from '../repository/index.ts';
import type { Repository } from '../repository/index.ts';
import type { ApiResult } from './http.ts';
import { empty, json } from './http.ts';

/** New label photo uploads per user and UTC day (ADR 0016, Consequences). F1 needs at most 3 per bean. */
export const LABEL_PHOTO_DAILY_CAP = 20;

/** The S3 region of the photo bucket (CLAUDE.md invariant 6); the contract's `url` pattern names it. */
const PHOTO_REGION = 'eu-central-1';

/** The part of the repository the label photo routes use. */
export type LabelPhotoRepository = Pick<
  Repository,
  | 'getBean'
  | 'labelPhotoCount'
  | 'countLabelPhotoUpload'
  | 'createPendingLabelPhoto'
  | 'getPendingLabelPhoto'
  | 'discardPendingLabelPhoto'
  | 'hasLabelPhoto'
  | 'completeLabelPhoto'
>;

export interface LabelPhotoConfig {
  readonly store: LabelPhotoStore;
  /** New uploads per user and UTC day; default LABEL_PHOTO_DAILY_CAP. */
  readonly dailyCap?: number;
  /** Clock for `expires_at`; for tests. */
  readonly now?: () => Date;
}

export interface LabelPhotoOutcome {
  readonly result: ApiResult;
  /** A fixed code: an error class name or one of the names below. */
  readonly error?: string;
  /** A fixed code: the S3 answer for a missing upload, or `label_orphaned`. */
  readonly reason?: string;
}

/** Runs a repository write again if it raced (the router's `attempt`). */
export type Retry = <T>(call: () => Promise<T>) => Promise<T>;

const NOT_CONFIGURED: LabelPhotoOutcome = { result: empty(500), error: 'PhotoBucketNotConfigured' };

/** S3 form field name to the contract's property name (LabelPhotoUploadFields). Nothing else may appear. */
const FIELD_NAMES: ReadonlyMap<string, keyof LabelPhotoUpload['upload']['fields']> = new Map([
  ['key', 'key'],
  ['bucket', 'bucket'],
  ['Content-Type', 'content_type'],
  ['Policy', 'policy'],
  ['X-Amz-Algorithm', 'x_amz_algorithm'],
  ['X-Amz-Credential', 'x_amz_credential'],
  ['X-Amz-Date', 'x_amz_date'],
  ['X-Amz-Security-Token', 'x_amz_security_token'],
  ['X-Amz-Signature', 'x_amz_signature'],
]);

/**
 * The contract's `LabelPhotoUpload` for a presigned POST, or undefined if the
 * POST is not exactly what this server signs: an unknown or missing field, a
 * value outside the contract, another key or bucket, or a URL that is not
 * the bucket's virtual-hosted endpoint in eu-central-1.
 */
export function toLabelPhotoUpload(photoId: string, presigned: PresignedUpload, bucket: string, issuedAt: Date): LabelPhotoUpload | undefined {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(presigned.fields)) {
    const mapped = FIELD_NAMES.get(name);
    if (mapped === undefined || Object.hasOwn(fields, mapped)) return undefined;
    fields[mapped] = value;
  }
  const parsed = LabelPhotoUploadSchema.safeParse({
    photo_id: photoId,
    upload: { url: presigned.url, fields },
    expires_at: new Date(issuedAt.getTime() + UPLOAD_EXPIRES_SECONDS * 1000).toISOString(),
    max_bytes: MAX_LABEL_PHOTO_BYTES,
  });
  if (!parsed.success) return undefined;
  const upload = parsed.data.upload;
  if (upload.fields.key !== uploadKey(photoId) || upload.fields.bucket !== bucket) return undefined;
  if (upload.url !== `https://${bucket}.s3.${PHOTO_REGION}.amazonaws.com/`) return undefined;
  return parsed.data;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export async function createLabelPhotoUpload(
  store: LabelPhotoRepository,
  config: LabelPhotoConfig | undefined,
  user: UserId,
  beanId: string,
): Promise<LabelPhotoOutcome> {
  if (config === undefined) return NOT_CONFIGURED;
  const bean = await store.getBean(beanId);
  if (bean === undefined || bean.status === 'rejected') return { result: empty(404), error: 'BeanNotFoundError' };
  if (bean.status !== 'unverified') return { result: empty(409), error: 'BeanNotUnverifiedError' };
  if ((await store.labelPhotoCount(user, beanId)) >= LABEL_PHOTOS_PER_BEAN) return { result: empty(409), error: 'LabelPhotoCapReachedError' };
  if (!(await store.countLabelPhotoUpload(user, config.dailyCap ?? LABEL_PHOTO_DAILY_CAP))) {
    return { result: empty(429), error: 'LabelPhotoUploadCapReached' };
  }
  const photoId = await store.createPendingLabelPhoto(user, beanId);
  const issuedAt = (config.now ?? (() => new Date()))();
  let presigned: PresignedUpload;
  try {
    presigned = await config.store.presignUpload(photoId);
  } catch (error) {
    return { result: empty(500), error: errorName(error) };
  }
  const body = toLabelPhotoUpload(photoId, presigned, config.store.bucket, issuedAt);
  if (body === undefined) return { result: empty(500), error: 'LabelPhotoUploadInvalid' };
  return { result: json(201, body) };
}

export async function completeLabelPhoto(
  store: LabelPhotoRepository,
  config: LabelPhotoConfig | undefined,
  user: UserId,
  photoId: string,
  retry: Retry,
): Promise<LabelPhotoOutcome> {
  if (config === undefined) return NOT_CONFIGURED;
  const pending = await store.getPendingLabelPhoto(user, photoId);
  if (pending === undefined) {
    return (await store.hasLabelPhoto(user, photoId))
      ? { result: empty(409), error: 'LabelPhotoCompletedError' }
      : { result: empty(404), error: 'LabelPhotoNotPending' };
  }
  const { beanId } = pending;
  if ((await store.getBean(beanId))?.status !== 'unverified') return { result: empty(409), error: 'BeanNotUnverifiedError' };
  if ((await store.labelPhotoCount(user, beanId)) >= LABEL_PHOTOS_PER_BEAN) return { result: empty(409), error: 'LabelPhotoCapReachedError' };

  const reject = async (error: string): Promise<LabelPhotoOutcome> => {
    await store.discardPendingLabelPhoto(user, photoId);
    return { result: empty(400), error };
  };

  let read;
  try {
    read = await config.store.getUpload(photoId);
  } catch (error) {
    return { result: empty(500), error: errorName(error) };
  }
  if (read.kind === 'missing') return { result: empty(404), error: 'LabelPhotoUploadMissing', reason: read.reason };
  if (read.kind === 'too_large') return reject('LabelPhotoTooLarge');
  const stripped = stripJpeg(read.bytes);
  if (stripped === undefined) return reject('LabelPhotoNotJpeg');

  try {
    await config.store.putLabel(photoId, stripped);
  } catch (error) {
    return { result: empty(500), error: errorName(error) };
  }

  try {
    await retry(() => store.completeLabelPhoto(user, photoId, beanId));
  } catch (error) {
    const orphaned = { reason: 'label_orphaned' };
    if (error instanceof LabelPhotoCompletedError || error instanceof LabelPhotoCapReachedError || error instanceof BeanNotUnverifiedError) {
      return { result: empty(409), error: error.name, ...orphaned };
    }
    if (error instanceof ItemNotFoundError) return { result: empty(404), error: 'LabelPhotoNotPending', ...orphaned };
    return { result: empty(500), error: errorName(error), ...orphaned };
  }
  return { result: empty(204) };
}
