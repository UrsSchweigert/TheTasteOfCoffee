import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { buildApp } from '../src/app.ts';
import type { CupmarkApp } from '../src/app.ts';
import { checkApp } from '../src/guards.ts';
import type { Violation } from '../src/guards.ts';
import { CupmarkGitHubOidcStack } from '../src/github-oidc.ts';
import type { GitHubOidcProviderMode } from '../src/github-oidc.ts';
import type { CupmarkStack } from '../src/stage.ts';

export const INFRA_DIR = fileURLToPath(new URL('..', import.meta.url));

interface CdkJson {
  readonly app: string;
  readonly lookups?: boolean;
  readonly versionReporting?: boolean;
  readonly context: Record<string, unknown>;
}

export function readCdkJson(): CdkJson {
  return JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as CdkJson;
}

/** A fake, documentation-style account id. Never a real account. */
export const FAKE_ACCOUNT = '123456789012';

export interface TestAppOptions {
  readonly context?: Record<string, unknown>;
  readonly env?: Record<string, string | undefined>;
}

export interface ViolationsAfterOptions extends TestAppOptions {
  /**
   * Keep CloudFormation's own template validation on (as in cdk.json), so a finding
   * fails the synth. Only for complete, deployable resources such as the positive control.
   */
  readonly validateTemplates?: boolean;
}

/** The real app, with the feature flags from cdk.json, as the CDK CLI would build it. */
export function testApp(options: TestAppOptions = {}): CupmarkApp {
  return buildApp({
    appProps: { context: { ...readCdkJson().context, ...options.context } },
    env: options.env ?? {},
  });
}

/**
 * Builds the dev stage only, lets `mutate` add something to its core stack (a throwaway
 * change that never leaves the test), and returns the guard violations.
 */
export function violationsAfter(
  mutate: (stack: CupmarkStack, cupmark: CupmarkApp) => void,
  options: ViolationsAfterOptions = {},
): Violation[] {
  // CloudFormation's own template validation is off by default here: throwaway
  // resources are deliberately incomplete, and the point is to see what the Cupmark
  // guards report.
  const validation = options.validateTemplates === true ? {} : { '@aws-cdk/core:validateAgainstDefaultRules': false };
  const cupmark = testApp({
    ...options,
    context: { stage: 'dev', ...validation, ...options.context },
  });
  const dev = cupmark.stages[0];
  if (dev === undefined) throw new Error('dev stage missing');
  mutate(dev.core, cupmark);
  return checkApp(cupmark.app);
}

export interface GitHubOidcTestOptions {
  readonly providerMode?: GitHubOidcProviderMode;
  readonly importMode?: boolean;
  /** As in ViolationsAfterOptions. */
  readonly validateTemplates?: boolean;
}

/**
 * An app with only the `cupmark-github-oidc` stack (no stages, so no backend bundle is
 * needed), with the feature flags from cdk.json. Defaults: `reference`, not import mode.
 */
export function githubOidcApp(options: GitHubOidcTestOptions = {}): { app: App; stack: CupmarkGitHubOidcStack } {
  const validation = options.validateTemplates === false ? { '@aws-cdk/core:validateAgainstDefaultRules': false } : {};
  const app = new App({ analyticsReporting: false, context: { ...readCdkJson().context, ...validation } });
  const stack = new CupmarkGitHubOidcStack(app, {
    providerMode: options.providerMode ?? 'reference',
    importMode: options.importMode ?? false,
  });
  return { app, stack };
}

/** Like violationsAfter, for a throwaway change to the GitHub OIDC stack. */
export function githubOidcViolationsAfter(
  mutate: (stack: CupmarkGitHubOidcStack) => void,
  options: GitHubOidcTestOptions = {},
): Violation[] {
  const { app, stack } = githubOidcApp({ validateTemplates: false, ...options });
  mutate(stack);
  return checkApp(app);
}
