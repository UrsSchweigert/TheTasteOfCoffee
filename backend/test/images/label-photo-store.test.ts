// The label photo store (M1-T4d, ADR 0016): keys built from a ULID only, the
// presigned POST and its policy, the read of an upload with its size checks,
// and the write of the stripped copy. The presign runs the real
// @aws-sdk/s3-presigned-post on an S3Client with made-up credentials whose
// request handler refuses to send anything: signing is local, so no test
// reaches AWS. Reads and writes go to a stubbed client.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { toLabelPhotoUpload } from '../../src/api/label-photos.ts';
import { LabelPhotoUploadSchema } from '../../src/generated/contract.ts';
import {
  InvalidPhotoIdError,
  MAX_LABEL_PHOTO_BYTES,
  UPLOAD_EXPIRES_SECONDS,
  labelKey,
  presignedPostOptions,
  s3LabelPhotoStore,
  uploadKey,
} from '../../src/images/label-photo-store.ts';
import type { Presigner } from '../../src/images/label-photo-store.ts';

const BUCKET = 'cupmark-dev-photos-000000000000';
const PHOTO = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';
// Made up, not a real key: the shapes match the contract's patterns, nothing more.
const FAKE_CREDENTIALS = { accessKeyId: 'TESTACCESSKEYID00000', secretAccessKey: 'not-a-real-secret', sessionToken: 'bm90LWEtcmVhbC10b2tlbg==' };

/** An S3Client that signs locally but refuses to send a request. */
function signingOnlyClient(credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = FAKE_CREDENTIALS): S3Client {
  return new S3Client({
    region: 'eu-central-1',
    credentials,
    requestHandler: { handle: () => Promise.reject(new Error('no request may be sent')) },
  });
}

interface Sent {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** A stubbed client: records commands and answers with `answer`. */
function stubClient(answer: (command: unknown) => Promise<unknown>): { client: S3Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: (command: unknown) => {
      const input = (command as { input: Record<string, unknown> }).input;
      sent.push({ name: command instanceof GetObjectCommand ? 'GetObject' : command instanceof PutObjectCommand ? 'PutObject' : 'other', input });
      return answer(command);
    },
  } as unknown as S3Client;
  return { client, sent };
}

function s3Error(name: string): Error {
  return Object.assign(new Error('s3 said no'), { name });
}

function body(bytes: Uint8Array, length: number | null = bytes.byteLength): { Body: unknown; ContentLength: number | undefined; destroyed: () => boolean } {
  let destroyed = false;
  let read = false;
  return {
    Body: {
      transformToByteArray: () => {
        read = true;
        return Promise.resolve(bytes);
      },
      destroy: () => {
        destroyed = true;
      },
    },
    ContentLength: length ?? undefined,
    destroyed: () => destroyed && !read,
  };
}

function decodePolicy(policy: string): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(policy, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
}

describe('keys', () => {
  it('uploads/<id>.jpg and labels/<id>.jpg, from a ULID only', () => {
    expect(uploadKey(PHOTO)).toBe(`uploads/${PHOTO}.jpg`);
    expect(labelKey(PHOTO)).toBe(`labels/${PHOTO}.jpg`);
    for (const bad of ['', PHOTO.toLowerCase(), `${PHOTO}/../x`, '../catalogue/x', PHOTO.slice(1), `${PHOTO}.jpg`]) {
      expect(() => uploadKey(bad)).toThrow(InvalidPhotoIdError);
      expect(() => labelKey(bad)).toThrow(InvalidPhotoIdError);
    }
  });

  it('no store without a cupmark- bucket name', () => {
    for (const bucket of [undefined, '', 'other-photos', 'cupmark-', 'cupmark--x', 'Cupmark-dev']) {
      expect(s3LabelPhotoStore(signingOnlyClient(), bucket)).toBeUndefined();
    }
    expect(s3LabelPhotoStore(signingOnlyClient(), BUCKET)?.bucket).toBe(BUCKET);
  });
});

describe('the presigned POST', () => {
  it('passes only server-chosen options to the presigner', async () => {
    const seen: unknown[] = [];
    const presign: Presigner = (_client, options) => {
      seen.push(options);
      return Promise.resolve({ url: '', fields: {} });
    };
    await s3LabelPhotoStore(signingOnlyClient(), BUCKET, { presign })?.presignUpload(PHOTO);
    expect(seen).toEqual([
      {
        Bucket: BUCKET,
        Key: `uploads/${PHOTO}.jpg`,
        Fields: { 'Content-Type': 'image/jpeg' },
        Conditions: [
          ['eq', '$key', `uploads/${PHOTO}.jpg`],
          ['content-length-range', 1, MAX_LABEL_PHOTO_BYTES],
          ['eq', '$Content-Type', 'image/jpeg'],
          ['eq', '$bucket', BUCKET],
        ],
        Expires: 600,
      },
    ]);
    expect(presignedPostOptions(BUCKET, PHOTO)).toEqual(seen[0]);
    expect(() => presignedPostOptions(BUCKET, 'x')).toThrow(InvalidPhotoIdError);
  });

  it('the real presigner: virtual-hosted eu-central-1 URL, the fields, and a policy with key, size range, content type, bucket and 10 minutes', async () => {
    const store = s3LabelPhotoStore(signingOnlyClient(), BUCKET);
    const before = Date.now();
    const presigned = await store?.presignUpload(PHOTO);
    const after = Date.now();
    expect(presigned?.url).toBe(`https://${BUCKET}.s3.eu-central-1.amazonaws.com/`);
    const fields = presigned?.fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(
      ['Content-Type', 'Policy', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Signature', 'bucket', 'key'].sort(),
    );
    expect(fields.key).toBe(`uploads/${PHOTO}.jpg`);
    expect(fields.bucket).toBe(BUCKET);
    expect(fields['Content-Type']).toBe('image/jpeg');
    expect(fields['X-Amz-Algorithm']).toBe('AWS4-HMAC-SHA256');
    expect(fields['X-Amz-Credential']).toMatch(/^TESTACCESSKEYID00000\/\d{8}\/eu-central-1\/s3\/aws4_request$/);
    expect(fields['X-Amz-Signature']).toMatch(/^[0-9a-f]{64}$/);

    const policy = decodePolicy(fields.Policy ?? '');
    const conditions = policy.conditions;
    expect(conditions).toContainEqual(['eq', '$key', `uploads/${PHOTO}.jpg`]);
    expect(conditions).toContainEqual({ key: `uploads/${PHOTO}.jpg` });
    expect(conditions).toContainEqual(['content-length-range', 1, 8 * 1024 * 1024]);
    expect(conditions).toContainEqual(['eq', '$Content-Type', 'image/jpeg']);
    expect(conditions).toContainEqual({ 'Content-Type': 'image/jpeg' });
    expect(conditions).toContainEqual(['eq', '$bucket', BUCKET]);
    expect(conditions).toContainEqual({ bucket: BUCKET });
    // No condition lets another key, a prefix or another type through.
    expect(JSON.stringify(conditions)).not.toContain('starts-with');
    const expiration = Date.parse(policy.expiration);
    expect(expiration).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + UPLOAD_EXPIRES_SECONDS * 1000);
    expect(expiration).toBeLessThanOrEqual(after + UPLOAD_EXPIRES_SECONDS * 1000);
  });

  it('maps onto the contract, with and without a session token', async () => {
    for (const credentials of [FAKE_CREDENTIALS, { accessKeyId: FAKE_CREDENTIALS.accessKeyId, secretAccessKey: FAKE_CREDENTIALS.secretAccessKey }]) {
      const presigned = await s3LabelPhotoStore(signingOnlyClient(credentials), BUCKET)?.presignUpload(PHOTO);
      if (presigned === undefined) throw new Error('no store');
      const issued = new Date();
      const mapped = toLabelPhotoUpload(PHOTO, presigned, BUCKET, issued);
      expect(mapped).toBeDefined();
      expect(LabelPhotoUploadSchema.parse(mapped)).toEqual(mapped);
      expect(mapped?.upload.fields).toEqual({
        key: presigned.fields.key,
        bucket: presigned.fields.bucket,
        content_type: presigned.fields['Content-Type'],
        policy: presigned.fields.Policy,
        x_amz_algorithm: presigned.fields['X-Amz-Algorithm'],
        x_amz_credential: presigned.fields['X-Amz-Credential'],
        x_amz_date: presigned.fields['X-Amz-Date'],
        x_amz_signature: presigned.fields['X-Amz-Signature'],
        ...('sessionToken' in credentials ? { x_amz_security_token: credentials.sessionToken } : {}),
      });
      expect(mapped?.max_bytes).toBe(8388608);
      expect(mapped?.expires_at).toBe(new Date(issued.getTime() + 600_000).toISOString());
    }
  });
});

describe('getUpload', () => {
  it('reads uploads/<id>.jpg from the bucket', async () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const { client, sent } = stubClient(() => Promise.resolve(body(bytes)));
    const read = await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO);
    expect(read).toEqual({ kind: 'found', bytes });
    expect(sent).toEqual([{ name: 'GetObject', input: { Bucket: BUCKET, Key: `uploads/${PHOTO}.jpg` } }]);
  });

  it.each([
    ['NoSuchKey', 'NoSuchKey'],
    ['NotFound', 'NoSuchKey'],
    ['AccessDenied', 'AccessDenied'],
  ])('%s is a missing upload', async (name, reason) => {
    const { client } = stubClient(() => Promise.reject(s3Error(name)));
    expect(await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO)).toEqual({ kind: 'missing', reason });
  });

  it('other S3 errors are thrown', async () => {
    const { client } = stubClient(() => Promise.reject(s3Error('SlowDown')));
    await expect(s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO)).rejects.toThrow('s3 said no');
  });

  it('over 8 MiB by ContentLength is too large and the body is never read', async () => {
    const response = body(new Uint8Array(4), MAX_LABEL_PHOTO_BYTES + 1);
    const { client } = stubClient(() => Promise.resolve(response));
    expect(await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO)).toEqual({ kind: 'too_large' });
    expect(response.destroyed()).toBe(true);
  });

  it('an unknown size is refused the same way', async () => {
    const response = body(new Uint8Array(4), null);
    const { client } = stubClient(() => Promise.resolve(response));
    expect(await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO)).toEqual({ kind: 'too_large' });
  });

  it('more bytes than ContentLength promised, over the limit, is too large', async () => {
    const { client } = stubClient(() => Promise.resolve(body(new Uint8Array(MAX_LABEL_PHOTO_BYTES + 1), 10)));
    expect(await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO)).toEqual({ kind: 'too_large' });
  });

  it('exactly 8 MiB is read', async () => {
    const { client } = stubClient(() => Promise.resolve(body(new Uint8Array(MAX_LABEL_PHOTO_BYTES))));
    expect((await s3LabelPhotoStore(client, BUCKET)?.getUpload(PHOTO))?.kind).toBe('found');
  });
});

describe('putLabel', () => {
  it('writes labels/<id>.jpg as image/jpeg with no metadata', async () => {
    const { client, sent } = stubClient(() => Promise.resolve({}));
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    await s3LabelPhotoStore(client, BUCKET)?.putLabel(PHOTO, jpeg);
    expect(sent).toEqual([
      { name: 'PutObject', input: { Bucket: BUCKET, Key: `labels/${PHOTO}.jpg`, Body: jpeg, ContentType: 'image/jpeg', ContentLength: 4 } },
    ]);
  });

  it('throws on an S3 error and for a bad id, before sending', async () => {
    const { client, sent } = stubClient(() => Promise.reject(s3Error('InternalError')));
    const store = s3LabelPhotoStore(client, BUCKET);
    await expect(store?.putLabel(PHOTO, new Uint8Array(1))).rejects.toThrow('s3 said no');
    await expect(store?.putLabel('../x', new Uint8Array(1))).rejects.toThrow(InvalidPhotoIdError);
    expect(sent).toHaveLength(1);
  });
});
