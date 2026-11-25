import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';
import { STAGE_CONTEXT_KEY, STAGES, accountContextKey, isStageName } from './config.ts';
import type { StageName } from './config.ts';
import { CupmarkGitHubOidcStack, githubOidcImportMode, githubOidcProviderMode } from './github-oidc.ts';
import { CupmarkStage } from './stage.ts';

export interface BuildAppOptions {
  /** Passed to `new App()`. Tests set `context` and `outdir` here. */
  readonly appProps?: AppProps;
  /** Stands in for `process.env`; only `CDK_DEFAULT_ACCOUNT` is read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CupmarkApp {
  readonly app: App;
  readonly stages: readonly CupmarkStage[];
  /**
   * `cupmark-github-oidc` (M1-T9), only when no stage is selected. `-c stage=<name>`
   * leaves it out, so a stage deploy can never select it by accident.
   */
  readonly githubOidc: CupmarkGitHubOidcStack | undefined;
}

const ACCOUNT_ID = /^\d{12}$/;

/** The stages to synthesise: both, or the one named by `-c stage=<dev|prod>`. */
export function selectedStages(app: App): readonly StageName[] {
  const value: unknown = app.node.tryGetContext(STAGE_CONTEXT_KEY);
  if (value === undefined) return STAGES;
  if (!isStageName(value)) {
    throw new Error(`Context "${STAGE_CONTEXT_KEY}" must be one of ${STAGES.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return [value];
}

/**
 * The account of a stage: context `cupmark:<stage>:account`, else `CDK_DEFAULT_ACCOUNT`
 * (set by the CDK CLI from the current credentials), else none. With none, the stack is
 * account-agnostic and synth works offline without credentials.
 */
export function stageAccount(
  app: App,
  stage: StageName,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const fromContext: unknown = app.node.tryGetContext(accountContextKey(stage));
  const account = fromContext ?? env.CDK_DEFAULT_ACCOUNT;
  if (account === undefined || account === '') return undefined;
  if (typeof account !== 'string' || !ACCOUNT_ID.test(account)) {
    throw new Error(`Account for stage ${stage} must be 12 digits; got ${JSON.stringify(account)}`);
  }
  return account;
}

export function buildApp(options: BuildAppOptions = {}): CupmarkApp {
  // analyticsReporting false: no AWS::CDK::Metadata resource (library usage telemetry).
  const app = new App({ analyticsReporting: false, ...options.appProps });
  const env = options.env ?? process.env;
  const stages = selectedStages(app).map(
    (stage) => new CupmarkStage(app, { stage, account: stageAccount(app, stage, env) }),
  );
  const githubOidc =
    app.node.tryGetContext(STAGE_CONTEXT_KEY) === undefined
      ? new CupmarkGitHubOidcStack(app, { providerMode: githubOidcProviderMode(app), importMode: githubOidcImportMode(app) })
      : undefined;
  return { app, stages, githubOidc };
}
