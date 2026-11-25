// Fetch plumbing shared by the two Open Food Facts calls, the read API and the
// image (client.ts): a deadline over the whole exchange, a streamed byte limit,
// and dropping bodies that are not read. No dependency; Node's fetch.

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class BodyTooLarge extends Error {
  public override readonly name = 'BodyTooLarge';
}

export class BodyNotBytes extends Error {
  public override readonly name = 'BodyNotBytes';
}

/** Drops a body that is not read, without waiting on it. */
export function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/**
 * The body as bytes, or BodyTooLarge past `limit` bytes. Fetch decodes any
 * content encoding before the stream, so the count is of decompressed bytes
 * and a small gzip bomb stops at the limit. Aborts with the request's signal.
 */
export async function readLimitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    discard(response);
    throw new BodyTooLarge('declared length over the limit');
  }
  if (response.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = response.body;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new BodyNotBytes('body is not bytes');
    size += chunk.byteLength;
    // Leaving the loop early cancels the stream.
    if (size > limit) throw new BodyTooLarge('body over the limit');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** True if the response is, or says it is, something other than the answer to `url`: a 3xx, a followed redirect, another URL. */
export function isRedirect(response: Response, url: string): boolean {
  return response.redirected || (response.url !== '' && response.url !== url) || (response.status >= 300 && response.status < 400);
}

/**
 * Runs `exchange` with an abort signal that fires after `timeoutMs`, and
 * answers `onTimeout` at the deadline even if the exchange ignores the signal.
 * `onError` maps anything the exchange throws.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  exchange: (signal: AbortSignal) => Promise<T>,
  onTimeout: T,
  onError: (error: unknown) => T,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = new Promise<T>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(onTimeout);
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([exchange(signal), deadline]);
  } catch (error) {
    if (signal.aborted) return onTimeout;
    return onError(error);
  }
}
