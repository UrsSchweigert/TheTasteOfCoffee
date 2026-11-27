import { DefaultStackSynthesizer, PermissionsBoundary, Stack, Stage, Tags } from 'aws-cdk-lib';
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
import { CupmarkApi } from './api.ts';
import type { OpenFoodFactsSettings } from './api.ts';
import { CupmarkData } from './data.ts';
import { CupmarkExport } from './export.ts';
import { CupmarkIdentity } from './identity.ts';

export interface CupmarkStageProps {
  readonly stage: StageName;
  /** Target account id, or undefined for an account-agnostic synth. */
  readonly account?: string | undefined;
  /** OFF_CONTACT and OFF_LOOKUP_CAP of the API function (ADR 0019); none by default. */
  readonly openFoodFacts?: OpenFoodFactsSettings;
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
  /** The stage's stack: table and buckets (M1-T1), identity and API (M1-T2). */
  public readonly core: CupmarkStack;
  public readonly data: CupmarkData;
  public readonly identity: CupmarkIdentity;
  public readonly api: CupmarkApi;
  public readonly weeklyExport: CupmarkExport;

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
    this.data = new CupmarkData(this.core, 'Data', { stage: props.stage });
    this.identity = new CupmarkIdentity(this.core, 'Identity', { stage: props.stage });
    this.api = new CupmarkApi(this.core, 'Api', {
      stage: props.stage,
      data: this.data,
      userPool: this.identity.userPool,
      appClient: this.identity.appClient,
      openFoodFacts: props.openFoodFacts ?? {},
    });

    this.weeklyExport = new CupmarkExport(this.core, 'Export', { stage: props.stage, data: this.data });

    // Resource tags (in the template), on top of the stack tags above.
    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
    Tags.of(this).add('stage', props.stage);
  }
}
