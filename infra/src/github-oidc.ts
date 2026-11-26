// The stack `cupmark-github-oidc` (M1-T9, ADR 0009, ADR 0018): the GitHub OIDC trust and
// the deploy role `CupmarkGitHubDeploy`, which GitHub Actions in this repository assumes
// and which may only assume the four `cdk-cupmark-*` bootstrap roles.
//
// This stack is not part of a stage and is never deployed through CupmarkCfnExecution:
// a human deploys it once with their own credentials (infra/README.md, "The GitHub
// deploy role"). It uses CliCredentialsStackSynthesizer, so the CLI deploys with the
// caller's credentials and assumes no bootstrap role. It has no assets; only the
// template itself is uploaded to the Cupmark bootstrap bucket (`cdk-cupmark-assets-*`).
//
// The role already exists (created by hand on 2026-11-25, docs/07). The resources here
// are written as L1 constructs with literal policy documents, so that the template matches
// the existing role exactly and `cdk import` brings it in without any change. Every
// property that is not in the existing role (tags) is left out in import mode.
import { Aws, CfnDeletionPolicy, CliCredentialsStackSynthesizer, Stack } from 'aws-cdk-lib';
import type { App, CfnResource, CfnTag } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { BOOTSTRAP_QUALIFIER, PROJECT_TAG_KEY, PROJECT_TAG_VALUE, REGION } from './config.ts';

/** Stack name and construct id: the CLI selects it as `cupmark-github-oidc`. */
export const GITHUB_OIDC_STACK_NAME = 'cupmark-github-oidc';

/**
 * Context flag (ADR 0009): `create` makes the account's GitHub OIDC provider,
 * `reference` trusts the existing one by ARN and never modifies it. cdk.json commits
 * `reference`, because the shared account already has the provider. There is no
 * implicit default: a missing or unknown value fails the synth.
 */
export const GITHUB_OIDC_PROVIDER_CONTEXT_KEY = 'cupmark:githubOidcProvider';
export const GITHUB_OIDC_PROVIDER_MODES = ['create', 'reference'] as const;
export type GitHubOidcProviderMode = (typeof GITHUB_OIDC_PROVIDER_MODES)[number];

/**
 * Context flag (ADR 0018), only for the one-time `cdk import`: `true` leaves out the
 * stack and resource tags, so the template matches the hand-made role, which has none.
 * The committed state (flag absent) carries `project=cupmark`; the deploy right after the
 * import adds the tag as an in-place update.
 */
export const GITHUB_OIDC_IMPORT_CONTEXT_KEY = 'cupmark:githubOidcImport';

export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/**
 * Owner and repository exactly as GitHub names them (checked against the GitHub API on
 * 2026-11-25). GitHub puts them into `sub` with this case, and IAM compares
 * `StringEquals` case-sensitively: a different case would make every assume fail.
 */
export const GITHUB_REPOSITORY = 'UrsSchweigert/TheTasteOfCoffee';

/**
 * GitHub's numeric ids of the owner account and of this repository (public, not secret;
 * `GET /repos/UrsSchweigert/TheTasteOfCoffee` returns `owner.id` and `id`). The live
 * trust of the role uses the immutable subject form `repo:<owner>@<owner_id>/<repo>@<repo_id>:...`,
 * so that is taken to be what GitHub issues for this repository; the first AWS OIDC check
 * after the trust change proves it, and a wrong `sub` fails closed (ADR 0018, addendum 2026-11-26). A different owner or repository that
 * reuses the name has other ids and never matches.
 */
export const GITHUB_OWNER_ID = '132881530';
export const GITHUB_REPOSITORY_ID = '1470617081';

/** The one prefix every trusted subject starts with: `repo:<owner>@<id>/<repo>@<id>`. */
export const GITHUB_SUBJECT_PREFIX = (() => {
  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  return `repo:${owner ?? ''}@${GITHUB_OWNER_ID}/${repo ?? ''}@${GITHUB_REPOSITORY_ID}`;
})();

/** The GitHub environments the role trusts; both are limited to `main` in GitHub. */
export const GITHUB_DEPLOY_ENVIRONMENTS = ['dev', 'prod'] as const;

/**
 * The `sub` values the role trusts (ADR 0018): only jobs that declare the GitHub
 * environment `dev` or `prod`. GitHub writes `sub` as
 * `repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:<name>` for such a job. The
 * setup script (scripts/aws/first-deploy-setup.sh, step 2) sets the same list on the
 * existing role before the import, so the import template still matches it exactly
 * (docs/07, issue #46).
 *
 * Not `ref:refs/heads/main`: `.github/workflows/claude.yml` runs on `issue_comment` with
 * `id-token: write`, and for that event GitHub sets the ref to the default branch, so
 * its `sub` is `ref:refs/heads/main`. Trusting it would let that agent job assume this
 * role and, through the bootstrap's deploy role, deploy any `cupmark-*` stack.
 *
 * IAM does not keep other branches out: a job on any branch that names `environment: dev`
 * gets `environment:dev`. What separates `main` from other branches is the deployment
 * branch limit of both environments in GitHub (owner, issue #46). dev and prod are not
 * separated in IAM either: one role, one bootstrap.
 */
export const GITHUB_DEPLOY_SUBJECTS: readonly string[] = GITHUB_DEPLOY_ENVIRONMENTS.map(
  (env) => `${GITHUB_SUBJECT_PREFIX}:environment:${env}`,
);

/** The existing role's name; the IAM `Cupmark` prefix of invariant 9. */
export const GITHUB_DEPLOY_ROLE_NAME = 'CupmarkGitHubDeploy';
/** The existing role's one inline policy. */
export const GITHUB_DEPLOY_POLICY_NAME = 'AssumeCdkBootstrapRoles';

/**
 * Logical ids. The role's id is the key of infra/import/cupmark-github-oidc.json, the
 * resource mapping of `cdk import`; test/github-oidc.test.ts pins both. Changing it after
 * the import would make CloudFormation try to create a second role of the same name.
 */
export const DEPLOY_ROLE_LOGICAL_ID = 'DeployRole';
export const OIDC_PROVIDER_LOGICAL_ID = 'GitHubOidcProvider';

/** The four roles of the `cupmark` bootstrap (CDKToolkit-cupmark), in the hand-made policy's order. */
export const CDK_BOOTSTRAP_ROLE_KINDS = ['deploy-role', 'file-publishing-role', 'image-publishing-role', 'lookup-role'] as const;

export function githubOidcProviderMode(app: App): GitHubOidcProviderMode {
  const value: unknown = app.node.tryGetContext(GITHUB_OIDC_PROVIDER_CONTEXT_KEY);
  if (typeof value === 'string' && (GITHUB_OIDC_PROVIDER_MODES as readonly string[]).includes(value)) {
    return value as GitHubOidcProviderMode;
  }
  throw new Error(
    `Context "${GITHUB_OIDC_PROVIDER_CONTEXT_KEY}" must be one of ${GITHUB_OIDC_PROVIDER_MODES.join(', ')}; got ${JSON.stringify(value)}`,
  );
}

export function githubOidcImportMode(app: App): boolean {
  const value: unknown = app.node.tryGetContext(GITHUB_OIDC_IMPORT_CONTEXT_KEY);
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(`Context "${GITHUB_OIDC_IMPORT_CONTEXT_KEY}" must be true or false; got ${JSON.stringify(value)}`);
}

/** ARN of the account's existing GitHub provider; IAM names it after the host. */
export function existingProviderArn(): string {
  return `arn:aws:iam::${Aws.ACCOUNT_ID}:oidc-provider/${GITHUB_OIDC_HOST}`;
}

/** ARN of one `cupmark` bootstrap role in this account and eu-central-1. */
export function bootstrapRoleArn(kind: (typeof CDK_BOOTSTRAP_ROLE_KINDS)[number]): string {
  return `arn:aws:iam::${Aws.ACCOUNT_ID}:role/cdk-${BOOTSTRAP_QUALIFIER}-${kind}-${Aws.ACCOUNT_ID}-${REGION}`;
}

export interface CupmarkGitHubOidcStackProps {
  readonly providerMode: GitHubOidcProviderMode;
  /** True only for the one-time `cdk import` (no tags). */
  readonly importMode: boolean;
}

function retain(resource: CfnResource): void {
  resource.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
  resource.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
}

export class CupmarkGitHubOidcStack extends Stack {
  public readonly providerMode: GitHubOidcProviderMode;
  public readonly importMode: boolean;
  public readonly role: iam.CfnRole;
  /** Only in `create` mode. */
  public readonly provider: iam.CfnOIDCProvider | undefined;

  public constructor(scope: App, props: CupmarkGitHubOidcStackProps) {
    if (props.importMode && props.providerMode === 'create') {
      // The resource mapping imports only the role. In create mode the provider is new,
      // and an import change set cannot create resources.
      throw new Error(`${GITHUB_OIDC_IMPORT_CONTEXT_KEY}=true needs ${GITHUB_OIDC_PROVIDER_CONTEXT_KEY}=reference`);
    }
    const tags: Record<string, string> = props.importMode ? {} : { [PROJECT_TAG_KEY]: PROJECT_TAG_VALUE };
    super(scope, GITHUB_OIDC_STACK_NAME, {
      stackName: GITHUB_OIDC_STACK_NAME,
      // Account-agnostic: every ARN uses AWS::AccountId, so synth works offline.
      env: { region: REGION },
      // The caller's credentials, no bootstrap role, no CupmarkCfnExecution (ADR 0009).
      // The qualifier only names the bucket the CLI uploads the template to.
      synthesizer: new CliCredentialsStackSynthesizer({ qualifier: BOOTSTRAP_QUALIFIER }),
      terminationProtection: true,
      description: 'Cupmark: GitHub OIDC deploy role (deployed by the owner, not by CI)',
      tags,
    });
    this.providerMode = props.providerMode;
    this.importMode = props.importMode;
    const resourceTags: CfnTag[] | undefined = props.importMode
      ? undefined
      : [{ key: PROJECT_TAG_KEY, value: PROJECT_TAG_VALUE }];

    let providerArn: string;
    if (props.providerMode === 'create') {
      const provider = new iam.CfnOIDCProvider(this, OIDC_PROVIDER_LOGICAL_ID, {
        url: `https://${GITHUB_OIDC_HOST}`,
        clientIdList: [GITHUB_OIDC_AUDIENCE],
        tags: resourceTags,
      });
      retain(provider);
      this.provider = provider;
      providerArn = provider.attrArn;
    } else {
      // Never imported, looked up or modified: only its ARN is named (ADR 0009).
      this.provider = undefined;
      providerArn = existingProviderArn();
    }

    this.role = new iam.CfnRole(this, DEPLOY_ROLE_LOGICAL_ID, {
      roleName: GITHUB_DEPLOY_ROLE_NAME,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: providerArn },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
                [`${GITHUB_OIDC_HOST}:sub`]: [...GITHUB_DEPLOY_SUBJECTS],
              },
            },
          },
        ],
      },
      // The same document scripts/aws/apply-guardrails.sh step 3 wrote before M1-T9.
      policies: [
        {
          policyName: GITHUB_DEPLOY_POLICY_NAME,
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: 'sts:AssumeRole',
                Resource: CDK_BOOTSTRAP_ROLE_KINDS.map(bootstrapRoleArn),
              },
            ],
          },
        },
      ],
      // No permissionsBoundary: the existing role has none, and CupmarkBoundary does not
      // allow sts:AssumeRole on the bootstrap roles (ADR 0018).
      tags: resourceTags,
    });
    // A stack delete or a replacement never removes the role (or the provider).
    retain(this.role);
  }
}
