import { DefaultStackSynthesizer, PermissionsBoundary, Stack, Stage, Tags, Validations } from 'aws-cdk-lib';
import type { Environment, StackProps, StageProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  BOOTSTRAP_QUALIFIER,
  PERMISSIONS_BOUNDARY_NAME,
  PROJECT_TAG_KEY,
  PROJECT_TAG_VALUE,
  REGION,
  stackName,
} from './config.ts';
import type { StageName } from './config.ts';

export interface CupmarkStageProps {
  readonly stage: StageName;
  /** Target account id, or undefined for an account-agnostic synth. */
  readonly account?: string | undefined;
}

/**
 * Every stack of the app extends this: the Cupmark bootstrap qualifier (ADR 0002),
 * the `cupmark-<stage>-<part>` name, stack tags and termination protection. The region
 * comes from the enclosing CupmarkStage.
 */
export class CupmarkStack extends Stack {
  public readonly cupmarkStage: StageName;

  public constructor(scope: Construct, id: string, stage: StageName, part: string, props: StackProps = {}) {
    super(scope, id, {
      ...props,
      stackName: stackName(stage, part),
      synthesizer: new DefaultStackSynthesizer({ qualifier: BOOTSTRAP_QUALIFIER }),
      terminationProtection: true,
      // Stack tags must be explicit (feature flag @aws-cdk/core:explicitStackTags);
      // CloudFormation copies them to every resource that supports tags.
      tags: { ...props.tags, [PROJECT_TAG_KEY]: PROJECT_TAG_VALUE, stage },
    });
    this.cupmarkStage = stage;
  }
}

/**
 * One deployment environment (dev or prod). Nothing is shared between stages: each
 * stage owns all its stacks and resources. Every IAM role created inside gets the
 * CupmarkBoundary permissions boundary, which CupmarkCfnExecution requires.
 */
export class CupmarkStage extends Stage {
  public readonly cupmarkStage: StageName;
  /** Placeholder stack; M1 adds the table, buckets, identity and API here. */
  public readonly core: CupmarkStack;

  public constructor(scope: Construct, props: CupmarkStageProps) {
    const env: Environment =
      props.account === undefined ? { region: REGION } : { account: props.account, region: REGION };
    const stageProps: StageProps = {
      env,
      permissionsBoundary: PermissionsBoundary.fromName(PERMISSIONS_BOUNDARY_NAME),
    };
    super(scope, props.stage, stageProps);
    this.cupmarkStage = props.stage;

    this.core = new CupmarkStack(this, 'core', props.stage, 'core', {
      description: `Cupmark ${props.stage}: core resources`,
    });
    // M0 skeleton: the stack has no resources yet (the CDK CLI skips deploying an
    // empty stack). Remove this when M1-T1 adds the table.
    Validations.of(this.core).acknowledge({
      id: 'CloudFormation-Validate::F0001',
      reason: 'M0 skeleton has no resources yet; M1-T1 adds them',
    });

    // Resource tags (in the template), on top of the stack tags above.
    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
    Tags.of(this).add('stage', props.stage);
  }
}
