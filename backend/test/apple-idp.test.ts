// ADR 0015: the deploy-time custom resource that manages the Sign in with Apple
// provider. Cognito and Parameter Store are fakes; the key is generated per run.
import { generateKeyPairSync } from 'node:crypto';
import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  UpdateIdentityProviderCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLE_PROVIDER_NAME, NO_PROVIDER_ID, handleAppleProvider, physicalId, userPoolOfPhysicalId } from '../src/apple-idp/provider.ts';
import type { AppleProviderDeps, CustomResourceEvent, CustomResourceResponse } from '../src/apple-idp/provider.ts';
import { run, sendResponse } from '../src/handlers/apple-idp.ts';

const POOL = 'eu-central-1_AbC123xyz';
const KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const PROPS = {
  ServiceToken: 'arn:aws:lambda:eu-central-1:123456789012:function:cupmark-dev-apple-idp',
  UserPoolId: POOL,
  ServicesId: 'app.cupmark.signin',
  TeamId: '2F695PTZC6',
  KeyId: '3WKKAZFM6M',
  KeyParameter: '/cupmark/dev/apple-sign-in-key',
  Scopes: '',
  KeyRotation: '1',
};

const BASE = {
  ResponseURL: 'https://cloudformation-custom-resource-response-eucentral1.s3.eu-central-1.amazonaws.com/x?sig=y',
  StackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/cupmark-dev-core/guid',
  RequestId: 'request-1',
  LogicalResourceId: 'IdentityAppleProvider',
  ResourceType: 'Custom::CupmarkAppleIdentityProvider',
};

function create(props: Record<string, unknown> = PROPS): CustomResourceEvent {
  return { RequestType: 'Create', ...BASE, ResourceProperties: props };
}
function update(props: Record<string, unknown> = PROPS, id = physicalId(POOL)): CustomResourceEvent {
  return { RequestType: 'Update', PhysicalResourceId: id, ...BASE, ResourceProperties: props };
}
function remove(id = physicalId(POOL)): CustomResourceEvent {
  return { RequestType: 'Delete', PhysicalResourceId: id, ...BASE, ResourceProperties: PROPS };
}

function awsError(name: string, message = 'failed'): Error {
  return Object.assign(new Error(message), { name });
}

interface FakeOptions {
  readonly exists?: boolean;
  readonly parameter?: { Type?: string; Value?: string } | Error;
  readonly cognitoError?: Partial<Record<'create' | 'update' | 'delete' | 'describe', Error>>;
}

function fakes(options: FakeOptions = {}) {
  const calls: { command: string; input: unknown }[] = [];
  const parameter = options.parameter ?? { Type: 'SecureString', Value: KEY };
  const errors = options.cognitoError ?? {};
  const deps: AppleProviderDeps = {
    ssm: {
      send: vi.fn((command: unknown) => {
        if (!(command instanceof GetParameterCommand)) throw new Error('unexpected SSM command');
        calls.push({ command: 'GetParameter', input: command.input });
        if (parameter instanceof Error) return Promise.reject(parameter);
        return Promise.resolve({ Parameter: parameter });
      }),
    },
    cognito: {
      send: vi.fn((command: unknown) => {
        const record = (name: string, input: unknown, error: Error | undefined) => {
          calls.push({ command: name, input });
          return error === undefined ? Promise.resolve({}) : Promise.reject(error);
        };
        if (command instanceof DescribeIdentityProviderCommand) {
          return record(
            'Describe',
            command.input,
            errors.describe ?? (options.exists === true ? undefined : awsError('ResourceNotFoundException')),
          );
        }
        if (command instanceof CreateIdentityProviderCommand) return record('Create', command.input, errors.create);
        if (command instanceof UpdateIdentityProviderCommand) return record('Update', command.input, errors.update);
        if (command instanceof DeleteIdentityProviderCommand) return record('Delete', command.input, errors.delete);
        throw new Error('unexpected Cognito command');
      }),
    },
  };
  return { deps, calls, names: () => calls.map((c) => c.command) };
}

function expectNoKey(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toContain(KEY.split('\n')[1]);
}

const DETAILS = { client_id: 'app.cupmark.signin', team_id: '2F695PTZC6', key_id: '3WKKAZFM6M', private_key: KEY.trim(), authorize_scopes: '' };

describe('physical ids', () => {
  it('are <pool>/SignInWithApple and parse back', () => {
    expect(physicalId(POOL)).toBe(`${POOL}/SignInWithApple`);
    expect(userPoolOfPhysicalId(physicalId(POOL))).toBe(POOL);
    for (const other of [NO_PROVIDER_ID, `${POOL}/Google`, `us-east-1_abc/SignInWithApple`, `${POOL}/SignInWithApple/x`, '']) {
      expect(userPoolOfPhysicalId(other), other).toBeUndefined();
    }
  });
});

describe('Create and Update', () => {
  it('creates the provider from the SecureString when none exists', async () => {
    const f = fakes();
    const response = await handleAppleProvider(create(), f.deps);
    expect(response).toMatchObject({ Status: 'SUCCESS', PhysicalResourceId: `${POOL}/SignInWithApple`, NoEcho: true });
    expect(response.Data).toEqual({ ProviderName: APPLE_PROVIDER_NAME });
    expect(f.names()).toEqual(['GetParameter', 'Describe', 'Create']);
    expect(f.calls[0]?.input).toEqual({ Name: '/cupmark/dev/apple-sign-in-key', WithDecryption: true });
    expect(f.calls[2]?.input).toEqual({
      UserPoolId: POOL,
      ProviderName: 'SignInWithApple',
      ProviderType: 'SignInWithApple',
      ProviderDetails: DETAILS,
    });
    expectNoKey(response);
  });

  it('updates the provider when it already exists', async () => {
    const f = fakes({ exists: true });
    const response = await handleAppleProvider(create(), f.deps);
    expect(response.Status).toBe('SUCCESS');
    expect(f.names()).toEqual(['GetParameter', 'Describe', 'Update']);
    expect(f.calls[2]?.input).toEqual({ UserPoolId: POOL, ProviderName: 'SignInWithApple', ProviderDetails: DETAILS });
  });

  it('re-reads the key on Update (rotation)', async () => {
    const f = fakes({ exists: true });
    const response = await handleAppleProvider(update({ ...PROPS, KeyRotation: '2' }), f.deps);
    expect(response).toMatchObject({ Status: 'SUCCESS', PhysicalResourceId: physicalId(POOL) });
    expect(f.names()).toEqual(['GetParameter', 'Describe', 'Update']);
  });

  it('passes the scopes through', async () => {
    const f = fakes();
    await handleAppleProvider(create({ ...PROPS, Scopes: 'name email' }), f.deps);
    expect(f.calls[2]?.input).toMatchObject({ ProviderDetails: { authorize_scopes: 'name email' } });
  });

  it.each([
    ['a plain String parameter', { Type: 'String', Value: KEY }],
    ['an empty SecureString', { Type: 'SecureString' }],
    ['a SecureString that is not a PEM key', { Type: 'SecureString', Value: 'not a key' }],
  ])('fails without touching Cognito on %s', async (_label, parameter) => {
    const f = fakes({ parameter });
    const response = await handleAppleProvider(create(), f.deps);
    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'KeyUnavailableError' });
    expect(f.names()).toEqual(['GetParameter']);
  });

  it('fails with only the error class name when the parameter is missing', async () => {
    const f = fakes({ parameter: awsError('ParameterNotFound', 'Parameter /cupmark/dev/apple-sign-in-key not found') });
    const response = await handleAppleProvider(create(), f.deps);
    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'ParameterNotFound' });
  });

  it.each([
    ['a pool in another region', { UserPoolId: 'us-east-1_abc' }],
    ['a key parameter outside the stage', { KeyParameter: '/derschweigert/key' }],
    ['an unknown scope', { Scopes: 'openid profile' }],
    ['a missing rotation value', { KeyRotation: undefined }],
  ])('rejects %s without any call', async (_label, override) => {
    const f = fakes();
    const response = await handleAppleProvider(create({ ...PROPS, ...override }), f.deps);
    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'InvalidProperties', PhysicalResourceId: NO_PROVIDER_ID });
    expect(f.calls).toEqual([]);
  });

  it('never puts the key in the reason, even when Cognito echoes it', async () => {
    const f = fakes({ cognitoError: { create: awsError('InvalidParameterException', `bad private_key ${KEY}`) } });
    const response = await handleAppleProvider(create(), f.deps);
    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'InvalidParameterException', PhysicalResourceId: physicalId(POOL) });
    expectNoKey(response);
  });

  it('keeps the old physical id when an Update fails, so nothing gets deleted', async () => {
    const old = physicalId('eu-central-1_Old');
    const f = fakes({ cognitoError: { describe: awsError('TooManyRequestsException') } });
    const response = await handleAppleProvider(update(PROPS, old), f.deps);
    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'TooManyRequestsException', PhysicalResourceId: old });
  });
});

describe('Delete', () => {
  it('deletes the provider from the pool named in the physical id', async () => {
    const f = fakes();
    const response = await handleAppleProvider(remove(), f.deps);
    expect(response).toMatchObject({ Status: 'SUCCESS', PhysicalResourceId: physicalId(POOL), Data: {} });
    expect(f.calls).toEqual([{ command: 'Delete', input: { UserPoolId: POOL, ProviderName: 'SignInWithApple' } }]);
  });

  it('succeeds when the provider or the pool is already gone', async () => {
    const f = fakes({ cognitoError: { delete: awsError('ResourceNotFoundException') } });
    expect((await handleAppleProvider(remove(), f.deps)).Status).toBe('SUCCESS');
  });

  it('succeeds without a call for a resource that was never created', async () => {
    const f = fakes();
    expect((await handleAppleProvider(remove(NO_PROVIDER_ID), f.deps)).Status).toBe('SUCCESS');
    expect(f.calls).toEqual([]);
  });

  it('fails on any other error', async () => {
    const f = fakes({ cognitoError: { delete: awsError('AccessDeniedException') } });
    expect(await handleAppleProvider(remove(), f.deps)).toMatchObject({ Status: 'FAILED', Reason: 'AccessDeniedException' });
  });

  it('never reads the key', async () => {
    const f = fakes();
    await handleAppleProvider(remove(), f.deps);
    expect(f.names()).not.toContain('GetParameter');
  });
});

describe('the Lambda entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the response to the ResponseURL and logs one line without the key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent: { url: string; response: CustomResourceResponse }[] = [];
    const f = fakes({ cognitoError: { create: awsError('InvalidParameterException', KEY) } });
    await run(create(), f.deps, (url, response) => {
      sent.push({ url, response });
      return Promise.resolve();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(BASE.ResponseURL);
    expect(log).toHaveBeenCalledTimes(1);
    expectNoKey(log.mock.calls);
    expect(JSON.stringify(log.mock.calls)).not.toContain('sig=');
  });

  it('ignores an event that is not a custom resource event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn(() => Promise.resolve());
    await run({ hello: 'world' }, fakes().deps, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw when the response upload fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(remove(), fakes().deps, () => Promise.reject(new Error('network')));
    expect(JSON.stringify(log.mock.calls)).toContain('ResponseUploadFailed');
  });

  it('uploads with PUT and an empty content type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const response = await handleAppleProvider(remove(), fakes().deps);
    await sendResponse(BASE.ResponseURL, response);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(BASE.ResponseURL);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'content-type': '' });
    expect(JSON.parse(init?.body as string)).toEqual(response);
  });

  it('rejects when the upload is refused', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    const response = await handleAppleProvider(remove(), fakes().deps);
    await expect(sendResponse(BASE.ResponseURL, response)).rejects.toThrow(/HTTP 403/);
  });
});
