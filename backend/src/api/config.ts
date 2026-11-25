// Run-time configuration of the API Lambda, injected by infra (task M1-T2).
// Nothing here has a default that could work by accident: a missing or bad
// value fails closed.
//
// Environment:
// - TABLE_NAME: the table `cupmark-<stage>-main`.
// - CURSOR_KEY_PARAMETER: the name of a Parameter Store SecureString under
//   `/cupmark/`, holding the cursor HMAC key as standard base64 of at least 32
//   random bytes. The function reads it once per cold start with
//   ssm:GetParameter (WithDecryption, the AWS-managed key `alias/aws/ssm`) and
//   keeps it in memory only. The key itself is never in the repo, the template
//   or the environment (CLAUDE.md, invariant 8).
//
// Without a usable key the list routes answer 500 and issue or accept no
// cursor; every other route keeps working. A failed read is retried after
// 60 seconds at the earliest.
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { CursorSigner, MIN_CURSOR_KEY_BYTES } from './cursor.ts';

export const ENV = {
  tableName: 'TABLE_NAME',
  cursorKeyParameter: 'CURSOR_KEY_PARAMETER',
} as const;

/** Only parameters this project owns (CLAUDE.md, invariant 9). */
const PARAMETER_NAME = /^\/cupmark\/[A-Za-z0-9_./-]{1,200}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The key bytes in a parameter value, or undefined if it is not strict base64 of at least 32 bytes. */
export function decodeCursorKey(value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (!BASE64.test(trimmed)) return undefined;
  const bytes = Buffer.from(trimmed, 'base64');
  return bytes.length >= MIN_CURSOR_KEY_BYTES ? bytes : undefined;
}

export function isCursorKeyParameterName(name: string | undefined): name is string {
  return name !== undefined && PARAMETER_NAME.test(name) && !name.includes('//') && !name.endsWith('/');
}

/** How long a failed key read is remembered before Parameter Store is asked again. */
export const CURSOR_KEY_FAILURE_TTL_MS = 60_000;

export interface CursorKeyLoaderOptions {
  /** Clock in milliseconds, for tests. */
  readonly now?: () => number;
}

/**
 * A loader for the cursor signer from Parameter Store. It caches the signer
 * after the first success. After a failure (no such parameter, no access, not
 * a SecureString, a bad key) it resolves undefined, and keeps resolving
 * undefined without calling Parameter Store for CURSOR_KEY_FAILURE_TTL_MS, so
 * a missing key costs one call a minute, not one per list request. Concurrent
 * calls share one read. It never throws and never exposes the key.
 */
export function cursorSignerFromParameterStore(
  parameterName: string | undefined,
  client: Pick<SSMClient, 'send'>,
  options: CursorKeyLoaderOptions = {},
): () => Promise<CursorSigner | undefined> {
  const now = options.now ?? Date.now;
  let signer: CursorSigner | undefined;
  let failedAt: number | undefined;
  let pending: Promise<CursorSigner | undefined> | undefined;

  const read = async (name: string): Promise<CursorSigner | undefined> => {
    try {
      const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const parameter = result.Parameter;
      if (parameter?.Type !== 'SecureString' || parameter.Value === undefined) return undefined;
      const key = decodeCursorKey(parameter.Value);
      return key === undefined ? undefined : new CursorSigner(key);
    } catch {
      return undefined;
    }
  };

  return async () => {
    if (signer !== undefined) return signer;
    if (!isCursorKeyParameterName(parameterName)) return undefined;
    if (failedAt !== undefined && now() - failedAt < CURSOR_KEY_FAILURE_TTL_MS) return undefined;
    pending ??= read(parameterName).then((loaded) => {
      pending = undefined;
      if (loaded === undefined) failedAt = now();
      else signer = loaded;
      return loaded;
    });
    return pending;
  };
}
