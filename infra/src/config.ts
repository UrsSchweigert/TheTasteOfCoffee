// Fixed settings of the Cupmark CDK app. Nothing here may name an AWS account:
// the account comes from context or the environment at synth time.

/** Invariant 6: everything runs in Frankfurt. */
export const REGION = 'eu-central-1';

/** Invariant 9: every resource carries this tag. */
export const PROJECT_TAG_KEY = 'project';
export const PROJECT_TAG_VALUE = 'cupmark';

/** Invariant 9: physical names start with this prefix. */
export const NAME_PREFIX = 'cupmark-';

/**
 * ADR 0002: the Cupmark-only CDK bootstrap (stack `CDKToolkit-cupmark`), never the
 * shared `CDKToolkit` (default qualifier `hnb659fds`).
 */
export const BOOTSTRAP_QUALIFIER = 'cupmark';

/**
 * ADR 0002 and scripts/aws/cupmark-cfn-execution-policy.json: CloudFormation may only
 * create roles that carry this customer-managed boundary policy.
 */
export const PERMISSIONS_BOUNDARY_NAME = 'CupmarkBoundary';

export const STAGES = ['dev', 'prod'] as const;
export type StageName = (typeof STAGES)[number];

/** Context key that restricts synthesis to one stage: `cdk synth -c stage=dev`. */
export const STAGE_CONTEXT_KEY = 'stage';

/** Context key for the target account of a stage: `-c cupmark:dev:account=<12 digits>`. */
export function accountContextKey(stage: StageName): string {
  return `cupmark:${stage}:account`;
}

export function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** Physical name of a stack: `cupmark-<stage>-<part>`. */
export function stackName(stage: StageName, part: string): string {
  return `${NAME_PREFIX}${stage}-${part}`;
}

/**
 * Context key of the operator mailbox for the Open Food Facts User-Agent (docs/05,
 * Barcode lookup): `-c cupmark:offContact=<address>`. It becomes the API function's
 * `OFF_CONTACT`. Not a secret, but kept out of the repository: the deploy workflow
 * passes it from the GitHub environment secret `OFF_CONTACT`, which GitHub masks in the
 * public log (ADR 0019).
 */
export const OFF_CONTACT_CONTEXT_KEY = 'cupmark:offContact';

/** Optional: `-c cupmark:offLookupCap=<0..10000>`, the API function's `OFF_LOOKUP_CAP`. */
export const OFF_LOOKUP_CAP_CONTEXT_KEY = 'cupmark:offLookupCap';

/**
 * Deploy mode (ADR 0019): `-c cupmark:deploy=<stage>`, set only by
 * scripts/deploy/deploy-stage.sh. With it, the synth fails unless `-c stage=` names the
 * same stage, `cupmark:<stage>:account` is given, and `cupmark:offContact` is valid.
 * Without it, a synth is "not for deploy": the contact may be missing, and then the API
 * function has no `OFF_CONTACT` (uncached lookups answer 503).
 */
export const DEPLOY_CONTEXT_KEY = 'cupmark:deploy';

/**
 * The backend's own rule for OFF_CONTACT (backend/src/openfoodfacts/client.ts,
 * isValidContact): an e-mail address of at most 254 characters, so no white space,
 * parentheses, quotes or control characters can reach the User-Agent header.
 */
const OFF_CONTACT = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;

export function isValidOffContact(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && OFF_CONTACT.test(value);
}

/** The backend's MAX_LOOKUP_CAP (backend/src/api/config.ts, lookupCapFromEnv). */
export const MAX_OFF_LOOKUP_CAP = 10_000;

/** The cap as the backend accepts it, a plain integer 0..10000 as a string, or undefined. */
export function offLookupCap(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,4})$/.test(text)) return undefined;
  return Number(text) <= MAX_OFF_LOOKUP_CAP ? text : undefined;
}

// ---------------------------------------------------------------------------
// Nightly rebuild of the community aggregates (ADR 0035, M3-T9)
// ---------------------------------------------------------------------------

/**
 * Timeout of `cupmark-<stage>-nightly-aggregates`, in seconds. M3-T10 replays a seeded
 * history of 20,000 brews across 200 users with a Lambda-like 512 MB heap and states a
 * time budget of 60 seconds, so 300 seconds leaves at least five times the margin. The
 * handler logs the share of the timeout it used (the scale trigger): when a real run
 * passes about half of it, raise the timeout here (Lambda allows 900) in a pull request,
 * with the measured numbers.
 */
export const NIGHTLY_TIMEOUT_SECONDS = 300;

/**
 * Memory of the nightly function, in MB. M3-T10 measures the peak heap of the full job on
 * the 20,000-brew history and fails above its bound, which is what supports this value.
 * Lambda gives CPU in proportion to memory, so more memory also shortens the scan; the
 * cost per run stays a fraction of a cent.
 */
export const NIGHTLY_MEMORY_MB = 512;

/** Once a day at 02:00 UTC (the weekly export follows at 03:00 on Sundays). */
export const NIGHTLY_SCHEDULE = 'cron(0 2 * * ? *)';
export const NIGHTLY_SCHEDULE_TIMEZONE = 'UTC';
/** The Scheduler starts the run at a random moment within this window after 02:00. */
export const NIGHTLY_FLEXIBLE_WINDOW_MINUTES = 15;
/** At most one retry of a failed invocation (a second failure shows in the logs and the alarm). */
export const NIGHTLY_MAX_RETRY_ATTEMPTS = 1;

/**
 * Period of the missing-run alarm: the schedule fires once a day, so a day plus an hour
 * of slack (the 15 minute window and the run itself) separates "late" from "missing".
 */
export const MISSING_RUN_ALARM_PERIOD_HOURS = 25;
/** Period of the errors alarm: one day, so one failed night raises it once. */
export const ERRORS_ALARM_PERIOD_SECONDS = 86_400;

/** Settings that differ between stages and change only through a pull request. */
export interface StageSettings {
  /**
   * ADR 0035, Addendum 2: failure alarms only from more than 100 users. When `enabled` is
   * false the stack creates no alarm and no SNS topic. Turn it on in a pull request when
   * `users_seen` in the nightly log line (or the Cognito console) shows more than 100 users.
   */
  readonly failureAlarms: { readonly enabled: boolean };
  /**
   * Whether the nightly schedule is ENABLED. `prod` stays disabled until the owner enables
   * it (the first prod deploy is not part of M3). While it is disabled the missing-run
   * alarm does not exist either, since it would fire every day.
   */
  readonly nightlyScheduleEnabled: boolean;
}

export const STAGE_SETTINGS: Readonly<Record<StageName, StageSettings>> = {
  dev: { failureAlarms: { enabled: false }, nightlyScheduleEnabled: true },
  prod: { failureAlarms: { enabled: false }, nightlyScheduleEnabled: false },
};
