// The stack `cupmark-github-oidc` (M1-T9, ADR 0009, ADR 0018). The role is pinned exactly:
// the owner imports the hand-made `CupmarkGitHubDeploy` with `cdk import`, and an import
// does not change a resource, so any difference between this template and the real role
// would be silent drift. Nothing here is deployed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Aws, CfnDeletionPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { describe, expect, it } from 'vitest';
import { REGION } from '../src/config.ts';
import { checkApp, formatViolations } from '../src/guards.ts';
import type { GuardName, Violation } from '../src/guards.ts';
import {
  CupmarkGitHubOidcStack,
  DEPLOY_ROLE_LOGICAL_ID,
  GITHUB_DEPLOY_ROLE_NAME,
  GITHUB_DEPLOY_SUBJECTS,
  GITHUB_OIDC_IMPORT_CONTEXT_KEY,
  GITHUB_OIDC_PROVIDER_CONTEXT_KEY,
  GITHUB_OIDC_STACK_NAME,
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  GITHUB_SUBJECT_PREFIX,
  OIDC_PROVIDER_LOGICAL_ID,
} from '../src/github-oidc.ts';
import { githubOidcApp, githubOidcViolationsAfter, readCdkJson, testApp } from './helpers.ts';

type Json = Record<string, unknown>;
interface CfnTemplate {
  readonly Resources: Record<string, { Type: string; Properties: Json; DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
}

function templateOf(stack: CupmarkGitHubOidcStack): CfnTemplate & Json {
  return Template.fromStack(stack).toJSON() as CfnTemplate & Json;
}

function expectViolation(violations: readonly Violation[], guard: GuardName, message: RegExp): void {
  const hit = violations.some((v) => v.guard === guard && message.test(v.message));
  expect(hit, `expected [${guard}] ${String(message)} in:\n${formatViolations(violations)}`).toBe(true);
}

const inAccount = (suffix: string): Json => ({ 'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, suffix]] });
const bootstrapRole = (kind: string): Json => ({
  'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, `:role/cdk-cupmark-${kind}-`, { Ref: 'AWS::AccountId' }, '-eu-central-1']],
});

/** GitHub's immutable subject prefix, written out literally so that any change to it fails a test. */
const PREFIX = 'repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081';

/**
 * The trust the owner sets on the hand-made role before the import (ADR 0018, issue #46),
 * with the provider given as `federated`.
 */
function expectedTrust(federated: unknown): Json {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: federated },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': [
              `${PREFIX}:environment:dev`,
              `${PREFIX}:environment:prod`,
            ],
          },
        },
      },
    ],
  };
}

/** The inline policy scripts/aws/apply-guardrails.sh step 3 wrote before M1-T9. */
const EXPECTED_POLICIES = [
  {
    PolicyName: 'AssumeCdkBootstrapRoles',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Resource: ['deploy-role', 'file-publishing-role', 'image-publishing-role', 'lookup-role'].map(bootstrapRole),
        },
      ],
    },
  },
];

const EXISTING_PROVIDER = inAccount(':oidc-provider/token.actions.githubusercontent.com');
const PROJECT_TAG = [{ Key: 'project', Value: 'cupmark' }];

describe('cupmark-github-oidc in the app', () => {
  it('commits reference as the provider mode, and no import flag', () => {
    const context = readCdkJson().context;
    expect(context[GITHUB_OIDC_PROVIDER_CONTEXT_KEY]).toBe('reference');
    expect(context[GITHUB_OIDC_IMPORT_CONTEXT_KEY]).toBeUndefined();
  });

  it('is built next to the stages, at the top of the app, and passes every guard', () => {
    const { app, githubOidc } = testApp();
    expect(githubOidc).toBeInstanceOf(CupmarkGitHubOidcStack);
    if (githubOidc === undefined) throw new Error('missing');
    expect(githubOidc.stackName).toBe('cupmark-github-oidc');
    expect(githubOidc.node.scope).toBe(app);
    expect(githubOidc.providerMode).toBe('reference');
    expect(githubOidc.importMode).toBe(false);
    expect(formatViolations(checkApp(app))).toBe('');
  });

  it.each(['dev', 'prod'])('is left out with -c stage=%s, so a stage deploy can never select it', (stage) => {
    expect(testApp({ context: { stage } }).githubOidc).toBeUndefined();
  });

  it('deploys with the caller\'s credentials, uploads only its template to the Cupmark bucket, and is termination protected', () => {
    const { app, stack } = githubOidcApp();
    const artifact = app.synth().getStackByName(GITHUB_OIDC_STACK_NAME);
    expect(artifact.assumeRoleArn).toBeUndefined();
    expect(artifact.cloudFormationExecutionRoleArn).toBeUndefined();
    expect(artifact.stackTemplateAssetObjectUrl).toMatch(/^s3:\/\/cdk-cupmark-assets-\$\{AWS::AccountId\}-eu-central-1\//);
    expect(artifact.terminationProtection).toBe(true);
    expect(artifact.environment.region).toBe(REGION);
    expect(artifact.tags).toEqual({ project: 'cupmark' });
    expect(stack.region).toBe(REGION);
    expect(JSON.stringify(artifact.manifest)).not.toContain('hnb659fds');
  });

  it.each([
    ['a missing provider mode (no silent default)', { [GITHUB_OIDC_PROVIDER_CONTEXT_KEY]: undefined }, /must be one of create, reference; got undefined/],
    ['an unknown provider mode', { [GITHUB_OIDC_PROVIDER_CONTEXT_KEY]: 'Reference' }, /must be one of create, reference/],
    ['an import flag that is not a boolean', { [GITHUB_OIDC_IMPORT_CONTEXT_KEY]: 'yes' }, /must be true or false/],
    ['import in create mode', { [GITHUB_OIDC_PROVIDER_CONTEXT_KEY]: 'create', [GITHUB_OIDC_IMPORT_CONTEXT_KEY]: 'true' }, /needs cupmark:githubOidcProvider=reference/],
  ])('rejects %s', (_label, context, error) => {
    expect(() => testApp({ context })).toThrow(error);
  });
});

describe('the repository and subjects', () => {
  it('names the repository with GitHub\'s exact case (sub is compared case-sensitively)', () => {
    expect(GITHUB_REPOSITORY).toBe('UrsSchweigert/TheTasteOfCoffee');
  });

  it('trusts exactly the dev and prod environments, in GitHub\'s immutable form, and no ref (claude.yml runs on main without one)', () => {
    expect(GITHUB_DEPLOY_SUBJECTS).toEqual([
      'repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:environment:dev',
      'repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:environment:prod',
    ]);
  });

  it('pins the owner id and repository id, and builds every subject from the one prefix', () => {
    expect(GITHUB_OWNER_ID).toBe('132881530');
    expect(GITHUB_REPOSITORY_ID).toBe('1470617081');
    expect(GITHUB_SUBJECT_PREFIX).toBe(PREFIX);
    for (const sub of GITHUB_DEPLOY_SUBJECTS) {
      expect(sub.startsWith(`${PREFIX}:environment:`)).toBe(true);
      // Fails if a subject loses the owner id or repository id (the plain form), gains a
      // wildcard, or becomes a ref/pull_request subject.
      expect(sub).toMatch(/^repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:(dev|prod)$/);
      expect(sub).not.toMatch(/[*?]/);
      expect(sub).not.toContain(':ref:');
    }
    expect(GITHUB_DEPLOY_SUBJECTS).toHaveLength(2);
  });

  it('renders exactly those subjects into the trust, with StringEquals and no StringLike', () => {
    for (const importMode of [true, false]) {
      const props = templateOf(githubOidcApp({ importMode }).stack).Resources.DeployRole?.Properties;
      const statement = (props?.AssumeRolePolicyDocument as { Statement: { Condition: Record<string, Json> }[] }).Statement[0];
      expect(Object.keys(statement?.Condition ?? {})).toEqual(['StringEquals']);
      expect(statement?.Condition.StringEquals?.['token.actions.githubusercontent.com:sub']).toEqual([`${PREFIX}:environment:dev`, `${PREFIX}:environment:prod`]);
    }
  });
});

describe('reference mode (committed)', () => {
  const template = templateOf(githubOidcApp().stack);

  it('holds only the role, and nothing an import change set could not take', () => {
    expect(Object.keys(template.Resources)).toEqual(['DeployRole']);
    expect(template.Resources.DeployRole?.Type).toBe('AWS::IAM::Role');
    // No Parameters (no BootstrapVersion), Outputs, Conditions or Rules.
    expect(Object.keys(template).sort()).toEqual(['Description', 'Resources']);
  });

  it('defines the role exactly: name, trust, inline policy and the project tag; no boundary', () => {
    expect(template.Resources.DeployRole?.Properties).toEqual({
      RoleName: 'CupmarkGitHubDeploy',
      AssumeRolePolicyDocument: expectedTrust(EXISTING_PROVIDER),
      Policies: EXPECTED_POLICIES,
      Tags: PROJECT_TAG,
    });
  });

  it('retains the role on stack delete and on replacement', () => {
    expect(template.Resources.DeployRole?.DeletionPolicy).toBe('Retain');
    expect(template.Resources.DeployRole?.UpdateReplacePolicy).toBe('Retain');
  });

  it('never creates or imports a provider: it names the existing one by ARN', () => {
    expect(JSON.stringify(template)).not.toContain('AWS::IAM::OIDCProvider');
    const { stack } = githubOidcApp();
    expect(stack.provider).toBeUndefined();
    expect(stack.node.findAll().some((c) => c instanceof iam.OpenIdConnectProvider || c instanceof iam.OidcProviderNative)).toBe(false);
  });
});

describe('import mode (-c cupmark:githubOidcImport=true)', () => {
  const { app, stack } = githubOidcApp({ importMode: true });
  const template = templateOf(stack);
  const committed = templateOf(githubOidcApp().stack);

  it('matches the hand-made role: no tags, no boundary, nothing else', () => {
    expect(template.Resources.DeployRole?.Properties).toEqual({
      RoleName: 'CupmarkGitHubDeploy',
      AssumeRolePolicyDocument: expectedTrust(EXISTING_PROVIDER),
      Policies: EXPECTED_POLICIES,
    });
    expect(app.synth().getStackByName(GITHUB_OIDC_STACK_NAME).tags).toEqual({});
  });

  it('differs from the committed template only by the project tag (the post-import update)', () => {
    const { Tags: tags, ...rest } = committed.Resources.DeployRole?.Properties ?? {};
    expect(tags).toEqual(PROJECT_TAG);
    expect(template.Resources.DeployRole?.Properties).toEqual(rest);
    expect(template.Resources.DeployRole?.DeletionPolicy).toBe('Retain');
  });

  it('passes every guard (the tag guard exempts only this mode)', () => {
    expect(formatViolations(checkApp(app))).toBe('');
  });
});

describe('create mode (-c cupmark:githubOidcProvider=create)', () => {
  const { app, stack } = githubOidcApp({ providerMode: 'create' });
  const template = templateOf(stack);

  it('creates the GitHub provider for sts.amazonaws.com, retained', () => {
    expect(Object.keys(template.Resources).sort()).toEqual(['DeployRole', 'GitHubOidcProvider']);
    expect(template.Resources.GitHubOidcProvider).toMatchObject({
      Type: 'AWS::IAM::OIDCProvider',
      Properties: { Url: 'https://token.actions.githubusercontent.com', ClientIdList: ['sts.amazonaws.com'], Tags: PROJECT_TAG },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    expect(Object.keys(template.Resources.GitHubOidcProvider?.Properties ?? {}).sort()).toEqual(['ClientIdList', 'Tags', 'Url']);
  });

  it('trusts that provider, with the same role otherwise', () => {
    expect(template.Resources.DeployRole?.Properties).toEqual({
      RoleName: 'CupmarkGitHubDeploy',
      AssumeRolePolicyDocument: expectedTrust({ 'Fn::GetAtt': [OIDC_PROVIDER_LOGICAL_ID, 'Arn'] }),
      Policies: EXPECTED_POLICIES,
      Tags: PROJECT_TAG,
    });
    expect(template.Resources.DeployRole?.DeletionPolicy).toBe('Retain');
  });

  it('passes every guard, with template validation on', () => {
    expect(formatViolations(checkApp(githubOidcApp({ providerMode: 'create', validateTemplates: true }).app))).toBe('');
    expect(formatViolations(checkApp(app))).toBe('');
  });
});

describe('the cdk import resource mapping', () => {
  const mapping = JSON.parse(
    readFileSync(new URL('../import/cupmark-github-oidc.json', import.meta.url), 'utf8'),
  ) as Record<string, Record<string, string>>;

  it('pins the role\'s logical id (renaming it would create a second role after the import)', () => {
    expect(DEPLOY_ROLE_LOGICAL_ID).toBe('DeployRole');
    expect(OIDC_PROVIDER_LOGICAL_ID).toBe('GitHubOidcProvider');
  });

  it('maps exactly the resources of the import template, by role name', () => {
    expect(mapping).toEqual({ DeployRole: { RoleName: 'CupmarkGitHubDeploy' } });
    const template = templateOf(githubOidcApp({ importMode: true }).stack);
    expect(Object.keys(mapping)).toEqual(Object.keys(template.Resources));
    expect(mapping[DEPLOY_ROLE_LOGICAL_ID]?.RoleName).toBe(template.Resources[DEPLOY_ROLE_LOGICAL_ID]?.Properties.RoleName);
    expect(mapping[DEPLOY_ROLE_LOGICAL_ID]?.RoleName).toBe(GITHUB_DEPLOY_ROLE_NAME);
  });
});

// Each guard can fail on this stack too. Every test changes one thing on a throwaway copy.
describe('guards on cupmark-github-oidc', () => {
  const role = (stack: CupmarkGitHubOidcStack): iam.CfnRole => stack.role;

  it('fails on a role without RETAIN', () => {
    const violations = githubOidcViolationsAfter((stack) => {
      role(stack).cfnOptions.deletionPolicy = CfnDeletionPolicy.DELETE;
    });
    expectViolation(violations, 'stateful', /AWS::IAM::Role: DeletionPolicy is Delete, must be Retain/);
  });

  it('fails on a role that is deleted on replacement', () => {
    const violations = githubOidcViolationsAfter((stack) => {
      role(stack).cfnOptions.updateReplacePolicy = CfnDeletionPolicy.DELETE;
    });
    expectViolation(violations, 'stateful', /AWS::IAM::Role: UpdateReplacePolicy is Delete, must be Retain/);
  });

  it('fails on a provider without RETAIN (create mode)', () => {
    const violations = githubOidcViolationsAfter(
      (stack) => {
        if (stack.provider === undefined) throw new Error('no provider');
        stack.provider.cfnOptions.deletionPolicy = CfnDeletionPolicy.DELETE;
      },
      { providerMode: 'create' },
    );
    expectViolation(violations, 'stateful', /AWS::IAM::OIDCProvider: DeletionPolicy is Delete/);
  });

  it('fails on a second role, or the role under another name', () => {
    const violations = githubOidcViolationsAfter((stack) => {
      role(stack).roleName = 'CupmarkGitHubDeploy2';
    });
    expectViolation(violations, 'name', /RoleName "CupmarkGitHubDeploy2" must be exactly CupmarkGitHubDeploy/);
  });

  it('fails on any other resource type, for example a bucket', () => {
    const violations = githubOidcViolationsAfter((stack) => {
      new s3.CfnBucket(stack, 'Bucket', { bucketName: 'cupmark-github-oidc-x' });
    });
    expectViolation(violations, 'resource-type', /AWS::S3::Bucket is not on GITHUB_OIDC_RESOURCE_TYPES/);
  });

  it('fails on an asset (the stack must not need the bootstrap for anything but its template)', () => {
    const dir = fileURLToPath(new URL('../import/', import.meta.url));
    const violations = githubOidcViolationsAfter((stack) => {
      new s3assets.Asset(stack, 'Asset', { path: dir });
    });
    expectViolation(violations, 'bootstrap', /must have no assets besides its template/);
  });

  it.each([
    ['a wildcard action', ['sts:*'], undefined, /action "sts:\*" has a wildcard/],
    ['Resource "*"', ['sts:AssumeRole'], ['*'], /Resource "\*" is not allowed/],
    ['a wildcard bootstrap role', ['sts:AssumeRole'], [`arn:aws:iam::${Aws.ACCOUNT_ID}:role/cdk-cupmark-*`], /has a wildcard/],
    ['the shared bootstrap', ['sts:AssumeRole'], [`arn:aws:iam::${Aws.ACCOUNT_ID}:role/cdk-hnb659fds-deploy-role-${Aws.ACCOUNT_ID}-eu-central-1`], /is not a Cupmark resource/],
    ['another project\'s role', ['sts:AssumeRole'], [`arn:aws:iam::${Aws.ACCOUNT_ID}:role/LastLookGitHubDeploy`], /is not a Cupmark resource/],
    ['another account', ['sts:AssumeRole'], ['arn:aws:iam::999999999999:role/cdk-cupmark-deploy-role-999999999999-eu-central-1'], /is in another account/],
  ])('fails on %s in the inline policy', (_label, actions, resources, message) => {
    const violations = githubOidcViolationsAfter((stack) => {
      role(stack).addPropertyOverride('Policies.0.PolicyDocument.Statement.0.Action', actions);
      if (resources !== undefined) role(stack).addPropertyOverride('Policies.0.PolicyDocument.Statement.0.Resource', resources);
    });
    expectViolation(violations, 'iam', message);
  });

  const trust = 'AssumeRolePolicyDocument.Statement.0';
  it.each([
    ['StringLike subjects', `${trust}.Condition`, { StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:*' } }, /StringEquals only/],
    ['a wildcard subject', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:*'], /must be one of repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:dev, repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:prod/],
    ['another repository', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert/Other:ref:refs/heads/main'], /must be one of repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:dev, repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:prod/],
    ['a different case', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:ursschweigert/thetasteofcoffee:environment:dev'], /must be one of repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:dev, repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081:environment:prod/],
    ['the main branch ref (claude.yml\'s issue_comment job has that sub)', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:ref:refs/heads/main'], /environment subjects of repo:UrsSchweigert@132881530\/TheTasteOfCoffee@1470617081 only/],
    ['a pull request subject', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:pull_request'], /environment subjects/],
    ['another environment', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee@1470617081:environment:staging'], /environment subjects/],
    ['the plain subject form without the ids', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert/TheTasteOfCoffee:environment:dev'], /environment subjects of repo:UrsSchweigert@132881530/],
    ['a subject without the repository id', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee:environment:dev'], /environment subjects of repo:UrsSchweigert@132881530/],
    ['a subject with another repository id', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:sub`, ['repo:UrsSchweigert@132881530/TheTasteOfCoffee@1:environment:dev'], /environment subjects of repo:UrsSchweigert@132881530/],
    ['another audience', `${trust}.Condition.StringEquals.token\\.actions\\.githubusercontent\\.com:aud`, 'example.com', /aud must be exactly sts.amazonaws.com/],
    ['another provider', `${trust}.Principal.Federated`, 'arn:aws:iam::123456789012:oidc-provider/example.com', /Federated must be the GitHub provider/],
    ['an AWS principal', `${trust}.Principal.AWS`, 'arn:aws:iam::999999999999:root', /AWS principals are not allowed/],
    ['the anonymous principal', `${trust}.Principal`, '*', /must be exactly one Service or Federated principal/],
    ['sts:AssumeRole for the provider', `${trust}.Action`, 'sts:AssumeRole', /only be trusted with sts:AssumeRoleWithWebIdentity/],
  ])('fails on a trust with %s', (_label, path, value, message) => {
    const violations = githubOidcViolationsAfter((stack) => {
      // Overrides merge objects: an AWS principal replaces the Federated one.
      if (path.endsWith('.Principal.AWS')) role(stack).addPropertyDeletionOverride(`${trust}.Principal.Federated`);
      role(stack).addPropertyOverride(path, value);
    });
    expectViolation(violations, 'trust', message);
  });

  it('fails without the project tag in the committed mode', () => {
    const violations = githubOidcViolationsAfter((stack) => {
      role(stack).addPropertyDeletionOverride('Tags');
    });
    expectViolation(violations, 'tag', /AWS::IAM::Role lacks tag project=cupmark/);
  });
});
