import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.ts';
import type { CupmarkApp } from '../src/app.ts';
import { checkApp } from '../src/guards.ts';
import type { Violation } from '../src/guards.ts';
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
  options: TestAppOptions = {},
): Violation[] {
  // CloudFormation's own template validation is off here: throwaway resources are
  // deliberately incomplete, and the point is to see what the Cupmark guards report.
  const cupmark = testApp({
    ...options,
    context: { stage: 'dev', '@aws-cdk/core:validateAgainstDefaultRules': false, ...options.context },
  });
  const dev = cupmark.stages[0];
  if (dev === undefined) throw new Error('dev stage missing');
  mutate(dev.core, cupmark);
  return checkApp(cupmark.app);
}
