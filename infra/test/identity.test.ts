// M1-T2: the Cognito user pool, its domain and the iOS app client of each stage.
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/config.ts';
import type { StageName } from '../src/config.ts';
import {
  APPLE_PROVIDER_COGNITO_ACTIONS,
  APPLE_PROVIDER_RESOURCE_TYPE,
  APPLE_SIGN_IN,
  APP_CALLBACK_URL,
  APP_SIGN_OUT_URL,
  appleKeyRotationContextKey,
  appleReturnUrl,
  applePrivateKeyParameter,
  cognitoDomainPrefix,
} from '../src/identity.ts';
import { readCdkJson, testApp } from './helpers.ts';

type Resource = { Type: string; Properties: Record<string, unknown> } & Record<string, unknown>;

function templateOf(stage: StageName): Template {
  const { stages } = testApp({ context: { stage } });
  const s = stages[0];
  if (s === undefined) throw new Error(`stage ${stage} missing`);
  return Template.fromStack(s.core);
}

function only(template: Template, type: string): [string, Resource] {
  const found = Object.entries(template.findResources(type)) as [string, Resource][];
  expect(found, type).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error(`no ${type}`);
  return first;
}

describe('Sign in with Apple configuration (M0-T7)', () => {
  it('pins the Services ID, Team ID and key id registered with Apple', () => {
    expect(APPLE_SIGN_IN.servicesId).toBe('app.cupmark.signin');
    expect(APPLE_SIGN_IN.teamId).toBe('2F695PTZC6');
    expect(APPLE_SIGN_IN.keyId).toBe('3WKKAZFM6M');
  });

  it('requests no name and no email from Apple: authorize_scopes is empty, not openid', () => {
    expect(APPLE_SIGN_IN.scopes).toEqual([]);
  });

  it.each(STAGES)('keeps the %s key rotation value in cdk.json', (stage) => {
    expect(readCdkJson().context[appleKeyRotationContextKey(stage)]).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it('rejects a malformed key rotation value', () => {
    expect(() => testApp({ context: { stage: 'dev', 'cupmark:dev:appleKeyRotation': 'two words' } })).toThrow(
      /appleKeyRotation must match/,
    );
  });

  it.each(STAGES)('keeps the %s private key only in a Parameter Store SecureString name', (stage) => {
    expect(applePrivateKeyParameter(stage)).toBe(`/cupmark/${stage}/apple-sign-in-key`);
  });

  it('pins the domain prefixes and the return URLs registered with Apple', () => {
    expect(STAGES.map(cognitoDomainPrefix)).toEqual(['cupmark-dev', 'cupmark-prod']);
    expect(STAGES.map(appleReturnUrl)).toEqual([
      'https://cupmark-dev.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse',
      'https://cupmark-prod.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse',
    ]);
  });

});

describe.each(STAGES)('stage %s', (stage) => {
  const template = templateOf(stage);

  describe('the user pool', () => {
    const [, pool] = only(template, 'AWS::Cognito::UserPool');
    const props = pool.Properties;

    it(`is named cupmark-${stage}-users, on the Lite plan, and tagged`, () => {
      expect(props.UserPoolName).toBe(`cupmark-${stage}-users`);
      expect(props.UserPoolTier).toBe('LITE');
      expect(props.UserPoolTags).toEqual({ project: 'cupmark', stage });
    });

    it('is RETAIN on delete and on replacement, with deletion protection ACTIVE', () => {
      expect(pool.DeletionPolicy).toBe('Retain');
      expect(pool.UpdateReplacePolicy).toBe('Retain');
      expect(props.DeletionProtection).toBe('ACTIVE');
    });

    it('has no self sign-up, no verified attributes, no recovery and no MFA', () => {
      expect(props.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
      expect(props.AutoVerifiedAttributes).toEqual([]);
      expect(props.AccountRecoverySetting).toEqual({ RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] });
      expect(props.MfaConfiguration).toBe('OFF');
    });

    it('stores no email, phone or name attribute and sends no SMS', () => {
      expect(props.Schema).toBeUndefined();
      expect(props.AliasAttributes).toBeUndefined();
      expect(props.UsernameAttributes).toBeUndefined();
      expect(props.SmsConfiguration).toBeUndefined();
      expect(props.EmailConfiguration).toBeUndefined();
      expect(props.LambdaConfig).toBeUndefined();
    });
  });

  it(`has the hosted domain prefix exactly cupmark-${stage}`, () => {
    const [, domain] = only(template, 'AWS::Cognito::UserPoolDomain');
    expect(domain.Properties.Domain).toBe(`cupmark-${stage}`);
    expect(domain.Properties.CustomDomainConfig).toBeUndefined();
  });

  describe('the app client', () => {
    const [, client] = only(template, 'AWS::Cognito::UserPoolClient');
    const props = client.Properties;

    it('is a public client with no secret', () => {
      expect(props.ClientName).toBe(`cupmark-${stage}-ios`);
      expect(props.GenerateSecret).toBe(false);
    });

    it('allows no password, SRP or custom sign-in: only refresh tokens', () => {
      expect(props.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']);
    });

    it('uses the authorization code flow, scope openid, and the app URL scheme', () => {
      expect(props.AllowedOAuthFlowsUserPoolClient).toBe(true);
      expect(props.AllowedOAuthFlows).toEqual(['code']);
      expect(props.AllowedOAuthScopes).toEqual(['openid']);
      expect(props.CallbackURLs).toEqual([APP_CALLBACK_URL]);
      expect(props.LogoutURLs).toEqual([APP_SIGN_OUT_URL]);
      expect(APP_CALLBACK_URL).toBe('cupmark://auth');
    });

    it('accepts only Sign in with Apple, never the Cognito username and password provider', () => {
      expect(props.SupportedIdentityProviders).toEqual(['SignInWithApple']);
    });

    it('depends on the Apple provider, which must exist first', () => {
      const [providerId] = only(template, APPLE_PROVIDER_RESOURCE_TYPE);
      expect(client.DependsOn).toEqual([providerId]);
    });

    it('issues 60-minute access and id tokens and 30-day refresh tokens', () => {
      expect(props.AccessTokenValidity).toBe(60);
      expect(props.IdTokenValidity).toBe(60);
      expect(props.RefreshTokenValidity).toBe(30 * 24 * 60);
      expect(props.TokenValidityUnits).toEqual({ AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' });
    });

    it('hides whether a user exists and supports token revocation', () => {
      expect(props.PreventUserExistenceErrors).toBe('ENABLED');
      expect(props.EnableTokenRevocation).toBe(true);
    });
  });

  it('has no CloudFormation identity provider: the Apple one is the custom resource', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  describe('the Sign in with Apple provider (ADR 0015)', () => {
    const [poolId] = only(template, 'AWS::Cognito::UserPool');
    const [, provider] = only(template, APPLE_PROVIDER_RESOURCE_TYPE);
    const fns = Object.entries(template.findResources('AWS::Lambda::Function')) as [string, Resource][];
    const fnHit = fns.find(([, r]) => r.Properties.FunctionName === `cupmark-${stage}-apple-idp`);
    if (fnHit === undefined) throw new Error('no apple-idp function');
    const [fnId, fn] = fnHit;
    const roles = Object.entries(template.findResources('AWS::IAM::Role')) as [string, Resource][];
    const roleHit = roles.find(([, r]) => r.Properties.RoleName === `cupmark-${stage}-apple-idp`);
    if (roleHit === undefined) throw new Error('no apple-idp role');
    const [roleId, role] = roleHit;

    it('passes the pinned ids, no scopes, the key parameter name and the rotation value, but no key', () => {
      expect(provider.Properties).toEqual({
        ServiceToken: { 'Fn::GetAtt': [fnId, 'Arn'] },
        UserPoolId: { Ref: poolId },
        ServicesId: 'app.cupmark.signin',
        TeamId: '2F695PTZC6',
        KeyId: '3WKKAZFM6M',
        KeyParameter: `/cupmark/${stage}/apple-sign-in-key`,
        Scopes: '',
        KeyRotation: readCdkJson().context[appleKeyRotationContextKey(stage)],
      });
    });

    it('is deleted with the stack (the pool stays)', () => {
      expect(provider.DeletionPolicy).toBe('Delete');
    });

    it('runs on a guarded function: Node 22, arm64, its own role, a cap of 1, 14-day logs', () => {
      expect(fn.Properties).toMatchObject({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        ReservedConcurrentExecutions: 1,
        Timeout: 30,
        Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
      });
      expect(fn.Properties.VpcConfig).toBeUndefined();
      expect(fn.Properties.Environment).toEqual({ Variables: { NODE_OPTIONS: '--enable-source-maps' } });
      const logs = Object.values(template.findResources('AWS::Logs::LogGroup')) as Resource[];
      const own = logs.filter((l) => l.Properties.LogGroupName === `/aws/lambda/cupmark-${stage}-apple-idp`);
      expect(own.map((l) => l.Properties.RetentionInDays)).toEqual([14]);
    });

    it('may read only its key and manage only this pool\'s identity providers', () => {
      const statements = (role.Properties.Policies as { PolicyDocument: { Statement: Record<string, unknown>[] } }[])[0]
        ?.PolicyDocument.Statement;
      expect(statements?.slice(1)).toEqual([
        {
          Sid: 'AppleKey',
          Effect: 'Allow',
          Action: 'ssm:GetParameter',
          Resource: {
            'Fn::Join': ['', ['arn:aws:ssm:eu-central-1:', { Ref: 'AWS::AccountId' }, `:parameter/cupmark/${stage}/apple-sign-in-key`]],
          },
        },
        {
          Sid: 'IdentityProvider',
          Effect: 'Allow',
          Action: [...APPLE_PROVIDER_COGNITO_ACTIONS],
          Resource: { 'Fn::GetAtt': [poolId, 'Arn'] },
        },
      ]);
      expect(statements?.[0]?.Sid).toBe('Logs');
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    });
  });

  it('never puts an Apple private key in the template', () => {
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toMatch(/BEGIN PRIVATE KEY|private_key|PrivateKey/);
  });
});
