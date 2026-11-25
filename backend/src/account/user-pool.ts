// Deletes the caller's Cognito user, the last step of account deletion (task
// M1-T6; ADR 0017; from the M1-T2 review). After it, no new token can be
// issued for the account; tokens issued before stay valid for up to 60
// minutes, which the tombstone covers (ADR 0017, Addendum).
//
// - The pool id comes from USER_POOL_ID and must be a pool in eu-central-1
//   (CLAUDE.md, invariant 6). The username is the `username` claim of the
//   caller's access token, never request input (src/auth/user-id.ts).
// - AdminDeleteUser of a user that is already gone answers
//   UserNotFoundException, which counts as success, so the step is safe to
//   repeat.
// - infra grants the API function cognito-idp:AdminDeleteUser on its stage's
//   own pool, nothing else.
// - Errors carry no pool id or username; the caller logs class names only.
import { AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoUsername } from '../auth/user-id.ts';

/** A Cognito user pool id in eu-central-1. */
const USER_POOL_ID = /^eu-central-1_[A-Za-z0-9]{1,55}$/;
/** Deadline of the one Cognito call. */
export const DEFAULT_USER_DELETE_TIMEOUT_MS = 3000;

export function isUserPoolId(value: string | undefined): value is string {
  return value !== undefined && USER_POOL_ID.test(value);
}

export interface UserDirectory {
  /** Deletes the user; an already missing user is success. Throws on any other failure. */
  deleteUser(username: CognitoUsername): Promise<void>;
}

export interface CognitoUserDirectoryOptions {
  readonly timeoutMs?: number;
}

/** The directory for `userPoolId`, or undefined if the id is missing or not a pool in eu-central-1. */
export function cognitoUserDirectory(
  client: Pick<CognitoIdentityProviderClient, 'send'>,
  userPoolId: string | undefined,
  options: CognitoUserDirectoryOptions = {},
): UserDirectory | undefined {
  if (!isUserPoolId(userPoolId)) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_USER_DELETE_TIMEOUT_MS;
  return {
    async deleteUser(username) {
      try {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username.value }), {
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'UserNotFoundException') return;
        throw error;
      }
    },
  };
}
