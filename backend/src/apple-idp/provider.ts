// The Sign in with Apple identity provider of a stage's user pool, managed by a
// deploy-time CloudFormation custom resource (ADR 0015). CloudFormation cannot put a
// SecureString into the provider's private key, so this function reads the key from
// Parameter Store itself and calls Cognito.
//
// - Create and Update: read the SecureString, then create the provider, or update it
//   if it exists.
// - Delete: delete the provider; a provider or pool that is already gone is success.
// - The private key is never logged, never put in the response and never in an
//   error reason: reasons carry only an error class name.
import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  UpdateIdentityProviderCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

/** Cognito's fixed provider name for Sign in with Apple. */
export const APPLE_PROVIDER_NAME = 'SignInWithApple';

const USER_POOL_ID = /^eu-central-1_[0-9A-Za-z]{1,55}$/;
const KEY_PARAMETER = /^\/cupmark\/(?:dev|prod)\/apple-sign-in-key$/;

/** The custom resource's properties, as the stack sets them (all strings in CloudFormation). */
export const ApplePropertiesSchema = z.object({
  ServiceToken: z.string(),
  UserPoolId: z.string().regex(USER_POOL_ID),
  /** The Services ID, Apple's client id. */
  ServicesId: z.string().regex(/^[A-Za-z0-9.-]{1,128}$/),
  TeamId: z.string().regex(/^[A-Z0-9]{10}$/),
  KeyId: z.string().regex(/^[A-Z0-9]{10}$/),
  KeyParameter: z.string().regex(KEY_PARAMETER),
  /** Space-separated Apple scopes: empty, or `name` and/or `email`. */
  Scopes: z.string().regex(/^(?:(?:name|email)(?: (?:name|email))?)?$/),
  /** Bumped to make CloudFormation run Update again after the key was rotated. */
  KeyRotation: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
});
export type AppleProperties = z.infer<typeof ApplePropertiesSchema>;

const EventBase = {
  // CloudFormation's presigned S3 URL; only HTTPS is accepted.
  ResponseURL: z.url({ protocol: /^https$/ }),
  StackId: z.string(),
  RequestId: z.string(),
  LogicalResourceId: z.string(),
  ResourceType: z.string(),
  ResourceProperties: z.record(z.string(), z.unknown()),
};

export const CustomResourceEventSchema = z.discriminatedUnion('RequestType', [
  z.object({ RequestType: z.literal('Create'), ...EventBase }),
  z.object({ RequestType: z.literal('Update'), PhysicalResourceId: z.string(), ...EventBase }),
  z.object({ RequestType: z.literal('Delete'), PhysicalResourceId: z.string(), ...EventBase }),
]);
export type CustomResourceEvent = z.infer<typeof CustomResourceEventSchema>;

export interface CustomResourceResponse {
  readonly Status: 'SUCCESS' | 'FAILED';
  readonly Reason: string;
  readonly PhysicalResourceId: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  /** Masks the output in CloudFormation; there is nothing secret in it anyway. */
  readonly NoEcho: true;
  readonly Data: { readonly ProviderName: string } | Record<string, never>;
}

export interface AppleProviderDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  readonly ssm: Pick<SSMClient, 'send'>;
}

/** `<userPoolId>/SignInWithApple`: the provider's id, and the pool to delete it from. */
export function physicalId(userPoolId: string): string {
  return `${userPoolId}/${APPLE_PROVIDER_NAME}`;
}

/** The pool of a physical id written by `physicalId`, or undefined for anything else. */
export function userPoolOfPhysicalId(id: string): string | undefined {
  const [pool, name, ...rest] = id.split('/');
  if (rest.length > 0 || name !== APPLE_PROVIDER_NAME || pool === undefined || !USER_POOL_ID.test(pool)) return undefined;
  return pool;
}

/** Physical id used when a Create fails before a pool is known; Delete ignores it. */
export const NO_PROVIDER_ID = 'none';

class KeyUnavailableError extends Error {
  public override readonly name = 'KeyUnavailableError';
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9]{1,64}$/.test(error.name) ? error.name : 'Error';
}

async function readPrivateKey(ssm: AppleProviderDeps['ssm'], name: string): Promise<string> {
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const parameter = result.Parameter;
  // Only a SecureString is accepted: a plain String would mean the key sat unencrypted.
  if (parameter?.Type !== 'SecureString' || parameter.Value === undefined) throw new KeyUnavailableError();
  const value = parameter.Value.trim();
  if (!value.includes('-----BEGIN PRIVATE KEY-----') || !value.includes('-----END PRIVATE KEY-----')) {
    throw new KeyUnavailableError();
  }
  return value;
}

async function providerExists(cognito: AppleProviderDeps['cognito'], userPoolId: string): Promise<boolean> {
  try {
    await cognito.send(new DescribeIdentityProviderCommand({ UserPoolId: userPoolId, ProviderName: APPLE_PROVIDER_NAME }));
    return true;
  } catch (error) {
    if (errorName(error) === 'ResourceNotFoundException') return false;
    throw error;
  }
}

async function upsert(deps: AppleProviderDeps, props: AppleProperties): Promise<void> {
  const privateKey = await readPrivateKey(deps.ssm, props.KeyParameter);
  const providerDetails = {
    client_id: props.ServicesId,
    team_id: props.TeamId,
    key_id: props.KeyId,
    private_key: privateKey,
    authorize_scopes: props.Scopes,
  };
  if (await providerExists(deps.cognito, props.UserPoolId)) {
    await deps.cognito.send(
      new UpdateIdentityProviderCommand({
        UserPoolId: props.UserPoolId,
        ProviderName: APPLE_PROVIDER_NAME,
        ProviderDetails: providerDetails,
      }),
    );
  } else {
    await deps.cognito.send(
      new CreateIdentityProviderCommand({
        UserPoolId: props.UserPoolId,
        ProviderName: APPLE_PROVIDER_NAME,
        ProviderType: APPLE_PROVIDER_NAME,
        ProviderDetails: providerDetails,
      }),
    );
  }
}

async function remove(deps: AppleProviderDeps, id: string): Promise<void> {
  const userPoolId = userPoolOfPhysicalId(id);
  if (userPoolId === undefined) return; // never created (a failed Create): nothing to delete
  try {
    await deps.cognito.send(new DeleteIdentityProviderCommand({ UserPoolId: userPoolId, ProviderName: APPLE_PROVIDER_NAME }));
  } catch (error) {
    // The provider, or the whole pool, is already gone.
    if (errorName(error) !== 'ResourceNotFoundException') throw error;
  }
}

/**
 * Handles one custom resource event and returns the response for CloudFormation.
 * Never throws: every failure becomes a FAILED response whose reason is an error
 * class name only.
 */
export async function handleAppleProvider(event: CustomResourceEvent, deps: AppleProviderDeps): Promise<CustomResourceResponse> {
  const base = { StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId, NoEcho: true } as const;
  const priorId = event.RequestType === 'Create' ? NO_PROVIDER_ID : event.PhysicalResourceId;
  try {
    if (event.RequestType === 'Delete') {
      await remove(deps, event.PhysicalResourceId);
      return { ...base, Status: 'SUCCESS', Reason: 'deleted', PhysicalResourceId: event.PhysicalResourceId, Data: {} };
    }
    const parsed = ApplePropertiesSchema.safeParse(event.ResourceProperties);
    if (!parsed.success) {
      return { ...base, Status: 'FAILED', Reason: 'InvalidProperties', PhysicalResourceId: priorId, Data: {} };
    }
    const props = parsed.data;
    const id = physicalId(props.UserPoolId);
    try {
      await upsert(deps, props);
    } catch (error) {
      // On a failed Create, report the id anyway: the rollback's Delete then removes
      // anything half made. On a failed Update, keep the old id so nothing is deleted.
      return {
        ...base,
        Status: 'FAILED',
        Reason: errorName(error),
        PhysicalResourceId: event.RequestType === 'Create' ? id : priorId,
        Data: {},
      };
    }
    // A new pool means a new id; CloudFormation then deletes the provider in the old pool.
    return { ...base, Status: 'SUCCESS', Reason: 'configured', PhysicalResourceId: id, Data: { ProviderName: APPLE_PROVIDER_NAME } };
  } catch (error) {
    return { ...base, Status: 'FAILED', Reason: errorName(error), PhysicalResourceId: priorId, Data: {} };
  }
}
