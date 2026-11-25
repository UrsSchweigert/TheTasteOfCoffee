// M1-T2: the Cognito user pool, its domain and the iOS app client of each stage.
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/config.ts';
import type { StageName } from '../src/config.ts';
import {
  APPLE_SIGN_IN,
  APP_CALLBACK_URL,
  APP_SIGN_OUT_URL,
  appleReturnUrl,
  applePrivateKeyParameter,
  cognitoDomainPrefix,
} from '../src/identity.ts';
import { testApp } from './helpers.ts';

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

  it('requests no name and no email from Apple', () => {
    expect(APPLE_SIGN_IN.scopes).toEqual([]);
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

  // Open: CloudFormation cannot read a SecureString into the provider's private key
  // (infra/README.md, "Apple private key"). The lead decides the mechanism.
  it.todo('creates the SignInWithApple provider with the pinned ids and no scopes, and the client accepts only it');
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

    it('never offers the Cognito username and password provider', () => {
      const providers = (props.SupportedIdentityProviders as string[] | undefined) ?? [];
      expect(providers).not.toContain('COGNITO');
      expect(providers.every((p) => p === 'SignInWithApple')).toBe(true);
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

  it('has no identity provider other than Sign in with Apple', () => {
    const idps = Object.values(template.findResources('AWS::Cognito::UserPoolIdentityProvider')) as Resource[];
    for (const idp of idps) expect(idp.Properties.ProviderType).toBe('SignInWithApple');
  });

  it('never puts an Apple private key in the template', () => {
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toMatch(/BEGIN PRIVATE KEY|private_key/);
  });
});
