// Identity of a stage (docs/05-system-design.md, Components and Security): one
// Cognito user pool on the Lite feature plan, its hosted domain and the iOS app
// client. Sign in with Apple is the only way in: no self sign-up, no passwords, no
// email or name requested. The pool is RETAIN with deletion protection, because
// every `USER#<sub>` partition in the table is keyed by its users' ids.

import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { NAME_PREFIX, REGION } from './config.ts';
import type { StageName } from './config.ts';

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
   * Apple scopes requested through Cognito: none. docs/05 and the iOS brief: request
   * no name and no email. Only Apple's opaque user id (the token subject) is used.
   */
  scopes: [] as readonly string[],
} as const;

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

    // The Sign in with Apple provider is not created yet: CloudFormation cannot read a
    // SecureString into its private key (see infra/README.md, "Apple private key").
    // Until it exists the client accepts no provider at all, so nobody can sign in.
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
      supportedIdentityProviders: [],
      accessTokenValidity: ACCESS_TOKEN_VALIDITY,
      idTokenValidity: ID_TOKEN_VALIDITY,
      refreshTokenValidity: REFRESH_TOKEN_VALIDITY,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, description: 'Cognito user pool id' });
    new CfnOutput(this, 'AppClientId', { value: this.appClient.userPoolClientId, description: 'Cognito client id of the iOS app' });
    new CfnOutput(this, 'HostedDomain', {
      value: `https://${cognitoDomainPrefix(stage)}.auth.${REGION}.amazoncognito.com`,
      description: 'Cognito hosted sign-in domain',
    });
  }
}
