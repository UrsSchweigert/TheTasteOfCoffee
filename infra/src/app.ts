import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';
import {
  DEPLOY_CONTEXT_KEY,
  OFF_CONTACT_CONTEXT_KEY,
  OFF_LOOKUP_CAP_CONTEXT_KEY,
  STAGE_CONTEXT_KEY,
  STAGES,
  accountContextKey,
  isStageName,
  isValidOffContact,
  offLookupCap,
} from './config.ts';
import type { StageName } from './config.ts';
import { CupmarkGitHubOidcStack, githubOidcImportMode, githubOidcProviderMode } from './github-oidc.ts';
import { CupmarkStage } from './stage.ts';
import type { OpenFoodFactsSettings } from './api.ts';

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

/** A context value, with an empty string treated as not given. */
function contextString(app: App, key: string): unknown {
  const value: unknown = app.node.tryGetContext(key);
  return value === '' ? undefined : value;
}

/**
 * The API function's Open Food Facts settings from context (ADR 0019). A value that is
 * given must be valid, or the synth fails; a missing one is left out of the environment.
 * The contact is never echoed in an error: it is kept out of the repository and logs.
 */
export function openFoodFactsSettings(app: App): OpenFoodFactsSettings {
  const contact = contextString(app, OFF_CONTACT_CONTEXT_KEY);
  if (contact !== undefined && !isValidOffContact(contact)) {
    throw new Error(`Context "${OFF_CONTACT_CONTEXT_KEY}" must be an e-mail address (the backend's OFF_CONTACT rule)`);
  }
  const capValue = contextString(app, OFF_LOOKUP_CAP_CONTEXT_KEY);
  const lookupCap = capValue === undefined ? undefined : offLookupCap(capValue);
  if (capValue !== undefined && lookupCap === undefined) {
    throw new Error(`Context "${OFF_LOOKUP_CAP_CONTEXT_KEY}" must be an integer from 0 to 10000; got ${JSON.stringify(capValue)}`);
  }
  return { contact, lookupCap };
}

/**
 * Deploy mode (`-c cupmark:deploy=<stage>`, ADR 0019). Undefined when not set. When set,
 * the synth is for a deploy of exactly that stage, so everything a deploy needs must be
 * there: the same `-c stage=`, the account from context, and a valid contact.
 */
export function checkDeployMode(app: App, settings: OpenFoodFactsSettings): StageName | undefined {
  const value = contextString(app, DEPLOY_CONTEXT_KEY);
  if (value === undefined) return undefined;
  if (!isStageName(value)) {
    throw new Error(`Context "${DEPLOY_CONTEXT_KEY}" must be one of ${STAGES.join(', ')}; got ${JSON.stringify(value)}`);
  }
  if (app.node.tryGetContext(STAGE_CONTEXT_KEY) !== value) {
    throw new Error(`Deploy mode for ${value} needs -c ${STAGE_CONTEXT_KEY}=${value}`);
  }
  if (contextString(app, accountContextKey(value)) === undefined) {
    throw new Error(`Deploy mode for ${value} needs -c ${accountContextKey(value)}=<account id>`);
  }
  if (settings.contact === undefined) {
    throw new Error(
      `Deploy mode for ${value} needs -c ${OFF_CONTACT_CONTEXT_KEY}=<operator mailbox> (the GitHub environment secret OFF_CONTACT)`,
    );
  }
  return value;
}

export function buildApp(options: BuildAppOptions = {}): CupmarkApp {
  // analyticsReporting false: no AWS::CDK::Metadata resource (library usage telemetry).
  const app = new App({ analyticsReporting: false, ...options.appProps });
  const env = options.env ?? process.env;
  const openFoodFacts = openFoodFactsSettings(app);
  checkDeployMode(app, openFoodFacts);
  const stages = selectedStages(app).map(
    (stage) => new CupmarkStage(app, { stage, account: stageAccount(app, stage, env), openFoodFacts }),
  );
  const githubOidc =
    app.node.tryGetContext(STAGE_CONTEXT_KEY) === undefined
      ? new CupmarkGitHubOidcStack(app, { providerMode: githubOidcProviderMode(app), importMode: githubOidcImportMode(app) })
      : undefined;
  return { app, stages, githubOidc };
}
