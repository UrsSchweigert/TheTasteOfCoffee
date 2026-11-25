// Identity of a stage (docs/05-system-design.md, Components and Security): one
// Cognito user pool on the Lite feature plan, its hosted domain and the iOS app
// client. Sign in with Apple is the only way in: no self sign-up, no passwords, no
// email or name requested. The pool is RETAIN with deletion protection, because
// every `USER#<sub>` partition in the table is keyed by its users' ids.

import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NAME_PREFIX, REGION } from './config.ts';
import type { StageName } from './config.ts';
import { cupmarkFunction } from './functions.ts';

/**
 * Sign in with Apple (M0-T7). Configuration, not secrets: the owner registered the
 * Services ID and the key in Apple's portal with the return URL from `appleReturnUrl`.
 * The `.p8` private key lives only in the SecureString `privateKeyParameter`, which
 * the owner creates (infra/README.md).
 */
export const APPLE_SIGN_IN = {
  servicesId: 'app.cupmark.signin',
  teamId: '2F695PTZC6',
  keyId: '3WKKAZFM6M',
  /**
   * Apple scopes requested through Cognito: none (`authorize_scopes` is empty).
   * docs/05 and the iOS brief: request no name and no email. Only Apple's opaque user
   * id (the token subject) is used. Apple documents `name` and `email` as its only
   * scopes and allows requesting neither; `openid` is not an Apple scope, so it is not
   * sent. If Cognito rejected an empty value, the first dev deploy would fail at the
   * custom resource with the error class name, and nothing else would change.
   */
  scopes: [] as readonly string[],
} as const;

/** Cognito's provider name for Sign in with Apple (also its ProviderType). */
export const APPLE_PROVIDER_NAME = 'SignInWithApple';

/** The custom resource type that manages the provider (ADR 0015). */
export const APPLE_PROVIDER_RESOURCE_TYPE = 'Custom::CupmarkAppleIdentityProvider';

/** The only Cognito actions the provider function may call, on the stage pool only. */
export const APPLE_PROVIDER_COGNITO_ACTIONS = [
  'cognito-idp:CreateIdentityProvider',
  'cognito-idp:DeleteIdentityProvider',
  'cognito-idp:DescribeIdentityProvider',
  'cognito-idp:UpdateIdentityProvider',
] as const;

/**
 * Context key of the key rotation value of a stage, in cdk.json. After the owner
 * replaces the SecureString, bumping this value makes CloudFormation run the custom
 * resource again, which re-reads the key (ADR 0015).
 */
export function appleKeyRotationContextKey(stage: StageName): string {
  return `cupmark:${stage}:appleKeyRotation`;
}

const KEY_ROTATION = /^[A-Za-z0-9._-]{1,64}$/;

/** Parameter Store SecureString holding the Apple `.p8` key of a stage. */
export function applePrivateKeyParameter(stage: StageName): string {
  return `/cupmark/${stage}/apple-sign-in-key`;
}

/** Cognito hosted domain prefix of a stage: exactly `cupmark-<stage>`. */
export function cognitoDomainPrefix(stage: StageName): string {
  return `${NAME_PREFIX}${stage}`;
}

/** The return URL registered with Apple for the stage's Services ID. */
export function appleReturnUrl(stage: StageName): string {
  return `https://${cognitoDomainPrefix(stage)}.auth.${REGION}.amazoncognito.com/oauth2/idpresponse`;
}

/**
 * Where the hosted sign-in sends the app back to (M2). A custom URL scheme, opened
 * with ASWebAuthenticationSession; the code is exchanged with PKCE (no client secret).
 */
export const APP_CALLBACK_URL = 'cupmark://auth';
export const APP_SIGN_OUT_URL = 'cupmark://signout';

/** docs/05, Security: access tokens valid for 60 minutes. */
export const ACCESS_TOKEN_VALIDITY = Duration.minutes(60);
export const ID_TOKEN_VALIDITY = Duration.minutes(60);
/** Refresh token kept in the iOS Keychain. Cognito's default, stated explicitly. */
export const REFRESH_TOKEN_VALIDITY = Duration.days(30);

export interface CupmarkIdentityProps {
  readonly stage: StageName;
}

export class CupmarkIdentity extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly domain: cognito.UserPoolDomain;
  public readonly appClient: cognito.UserPoolClient;
  public readonly appleProviderFunction: lambda.Function;
  public readonly appleProvider: CustomResource;

  public constructor(scope: Construct, id: string, props: CupmarkIdentityProps) {
    super(scope, id);
    const { stage } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${NAME_PREFIX}${stage}-users`,
      // Free for the first 10,000 monthly active users (docs/06).
      featurePlan: cognito.FeaturePlan.LITE,
      // No sign-up form: users only come in through Sign in with Apple.
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      // No email, phone or name is stored, so there is nothing to verify or recover.
      autoVerify: { email: false, phone: false },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      signInCaseSensitive: false,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix(stage) },
    });

    // Sign in with Apple, created by a deploy-time custom resource (ADR 0015):
    // CloudFormation cannot read a SecureString into the provider's private key, so the
    // function reads it from Parameter Store and calls Cognito. The key never appears
    // in the template, the repository, CI or CloudFormation events.
    const keyParameterArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: applePrivateKeyParameter(stage).slice(1),
    });
    this.appleProviderFunction = cupmarkFunction(this, {
      stage,
      part: 'apple-idp',
      id: 'AppleProvider',
      description: 'Cupmark Sign in with Apple provider, deploy time only (ADR 0015)',
      memorySize: 128,
      timeout: Duration.seconds(30),
      concurrency: 1,
      environment: {},
      statements: [
        new iam.PolicyStatement({ sid: 'AppleKey', actions: ['ssm:GetParameter'], resources: [keyParameterArn] }),
        new iam.PolicyStatement({
          sid: 'IdentityProvider',
          actions: [...APPLE_PROVIDER_COGNITO_ACTIONS],
          resources: [this.userPool.userPoolArn],
        }),
      ],
    });

    const rotation: unknown = this.node.tryGetContext(appleKeyRotationContextKey(stage)) ?? '1';
    if (typeof rotation !== 'string' || !KEY_ROTATION.test(rotation)) {
      throw new Error(`Context ${appleKeyRotationContextKey(stage)} must match ${String(KEY_ROTATION)}`);
    }
    this.appleProvider = new CustomResource(this, 'AppleProvider', {
      serviceToken: this.appleProviderFunction.functionArn,
      resourceType: APPLE_PROVIDER_RESOURCE_TYPE,
      properties: {
        UserPoolId: this.userPool.userPoolId,
        ServicesId: APPLE_SIGN_IN.servicesId,
        TeamId: APPLE_SIGN_IN.teamId,
        KeyId: APPLE_SIGN_IN.keyId,
        KeyParameter: applePrivateKeyParameter(stage),
        Scopes: APPLE_SIGN_IN.scopes.join(' '),
        KeyRotation: rotation,
      },
      // Deleting the stack removes the provider; the pool itself is retained.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.appClient = this.userPool.addClient('AppClient', {
      userPoolClientName: `${NAME_PREFIX}${stage}-ios`,
      // A public client: an iPhone app cannot keep a secret. PKCE protects the code.
      generateSecret: false,
      // No password or SRP flows; only refresh tokens after the hosted Apple flow.
      authFlows: { userPassword: false, userSrp: false, custom: false, adminUserPassword: false, user: false },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [APP_CALLBACK_URL],
        logoutUrls: [APP_SIGN_OUT_URL],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.APPLE],
      accessTokenValidity: ACCESS_TOKEN_VALIDITY,
      idTokenValidity: ID_TOKEN_VALIDITY,
      refreshTokenValidity: REFRESH_TOKEN_VALIDITY,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    // The client names the provider, which must exist first.
    this.appClient.node.addDependency(this.appleProvider);

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, description: 'Cognito user pool id' });
    new CfnOutput(this, 'AppClientId', { value: this.appClient.userPoolClientId, description: 'Cognito client id of the iOS app' });
    new CfnOutput(this, 'HostedDomain', {
      value: `https://${cognitoDomainPrefix(stage)}.auth.${REGION}.amazoncognito.com`,
      description: 'Cognito hosted sign-in domain',
    });
  }
}
