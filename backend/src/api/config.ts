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
// cursor; every other route keeps working.
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

/**
 * A loader for the cursor signer from Parameter Store. It caches the signer
 * after the first success; after a failure it resolves undefined and tries
 * again on the next call. It never throws and never exposes the key.
 */
export function cursorSignerFromParameterStore(
  parameterName: string | undefined,
  client: Pick<SSMClient, 'send'>,
): () => Promise<CursorSigner | undefined> {
  let signer: CursorSigner | undefined;
  return async () => {
    if (signer !== undefined) return signer;
    if (!isCursorKeyParameterName(parameterName)) return undefined;
    try {
      const result = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
      const parameter = result.Parameter;
      if (parameter?.Type !== 'SecureString' || parameter.Value === undefined) return undefined;
      const key = decodeCursorKey(parameter.Value);
      if (key === undefined) return undefined;
      signer = new CursorSigner(key);
      return signer;
    } catch {
      return undefined;
    }
  };
}
