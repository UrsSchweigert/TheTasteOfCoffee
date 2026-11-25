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
