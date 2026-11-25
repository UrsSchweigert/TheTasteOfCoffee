// Each guard in src/guards.ts must be able to fail. Every test adds one bad thing to a
// throwaway copy of the dev stage and expects the matching violation. Nothing here is
// written to cdk.out or deployed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aws, CfnOutput, CfnResource, Duration, Fn, RemovalPolicy, Stack, Stage, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { describe, expect, it } from 'vitest';
import { DENIED_RESOURCE_TYPES, formatViolations } from '../src/guards.ts';
import type { GuardName, Violation } from '../src/guards.ts';
import { CupmarkStack } from '../src/stage.ts';
import { FAKE_ACCOUNT, violationsAfter } from './helpers.ts';

function expectViolation(violations: readonly Violation[], guard: GuardName, message: RegExp): void {
  const hit = violations.some((v) => v.guard === guard && message.test(v.message));
  expect(hit, `expected [${guard}] ${String(message)} in:\n${formatViolations(violations)}`).toBe(true);
}

function inlineFunction(stack: Stack, id: string, props: Partial<lambda.FunctionProps> = {}): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline('export const handler = async () => ({ statusCode: 200 });'),
    ...props,
  });
}

describe('positive control', () => {
  it('passes a stack of representative, correctly named M1 resources', () => {
    const violations = violationsAfter((stack) => {
      new dynamodb.Table(stack, 'Table', {
        tableName: 'cupmark-dev-main',
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      new s3.Bucket(stack, 'Photos', {
        bucketName: Fn.join('', ['cupmark-dev-photos-', Aws.ACCOUNT_ID]),
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const logGroup = new logs.LogGroup(stack, 'HealthLogs', {
        logGroupName: '/aws/lambda/cupmark-dev-health',
        retention: logs.RetentionDays.TWO_WEEKS,
      });
      const fn = inlineFunction(stack, 'Health', { functionName: 'cupmark-dev-health', logGroup });
      new cloudwatch.Alarm(stack, 'Errors', {
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      });
      // Lambda's own log group: /aws/lambda/<Ref fn>, resolved through the function name.
      inlineFunction(stack, 'Named', { functionName: 'cupmark-dev-named' });
      inlineFunction(stack, 'Unnamed');
      new sns.Topic(stack, 'Alerts');
      new scheduler.CfnScheduleGroup(stack, 'Group', { name: 'cupmark-dev-jobs' });
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('gives every IAM role the CupmarkBoundary permissions boundary', () => {
    let template: Template | undefined;
    violationsAfter((stack) => {
      inlineFunction(stack, 'Fn');
      template = Template.fromStack(stack);
    });
    template?.hasResourceProperties('AWS::IAM::Role', {
      PermissionsBoundary: {
        'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':policy/CupmarkBoundary']],
      },
    });
    expect(template).toBeDefined();
  });
});

describe('(a) forbidden and unreviewed resource types', () => {
  it.each(DENIED_RESOURCE_TYPES.map((d) => [d.match.endsWith('::') ? `${d.match}Anything` : d.match]))(
    'fails on %s',
    (type) => {
      const violations = violationsAfter((stack) => {
        new CfnResource(stack, 'Bad', { type });
      });
      expectViolation(violations, 'resource-type', /is forbidden/);
    },
  );

  it('fails on a NAT gateway (L1)', () => {
    const violations = violationsAfter((stack) => {
      new ec2.CfnNatGateway(stack, 'Nat', { subnetId: 'subnet-12345678' });
    });
    expectViolation(violations, 'resource-type', /AWS::EC2::NatGateway is forbidden: NAT gateway/);
  });

  it('fails on a VPC with its NAT gateways and addresses (L2)', () => {
    const violations = violationsAfter((stack) => {
      new ec2.Vpc(stack, 'Vpc', { maxAzs: 1 });
    });
    expectViolation(violations, 'resource-type', /AWS::EC2::NatGateway is forbidden/);
    expectViolation(violations, 'resource-type', /AWS::EC2::EIP is forbidden/);
    expectViolation(violations, 'resource-type', /AWS::EC2::VPC is forbidden/);
  });

  it('fails on a customer-managed KMS key', () => {
    const violations = violationsAfter((stack) => {
      new kms.Key(stack, 'Key');
    });
    expectViolation(violations, 'resource-type', /AWS::KMS::Key is forbidden: customer-managed KMS key/);
  });

  it('fails on a Secrets Manager secret', () => {
    const violations = violationsAfter((stack) => {
      new secretsmanager.Secret(stack, 'Secret');
    });
    expectViolation(violations, 'resource-type', /AWS::SecretsManager::Secret is forbidden/);
  });

  it('fails on provisioned concurrency on a Lambda alias', () => {
    const violations = violationsAfter((stack) => {
      const fn = inlineFunction(stack, 'Fn', { functionName: 'cupmark-dev-fn' });
      new lambda.Alias(stack, 'Live', { aliasName: 'live', version: fn.currentVersion, provisionedConcurrentExecutions: 1 });
    });
    expectViolation(violations, 'fixed-fee-property', /AWS::Lambda::Alias: ProvisionedConcurrencyConfig/);
  });

  it('fails on provisioned concurrency on a Lambda version', () => {
    const violations = violationsAfter((stack) => {
      const fn = inlineFunction(stack, 'Fn', { functionName: 'cupmark-dev-fn' });
      new lambda.Version(stack, 'V1', { lambda: fn, provisionedConcurrentExecutions: 1 });
    });
    expectViolation(violations, 'fixed-fee-property', /AWS::Lambda::Version: ProvisionedConcurrencyConfig/);
  });

  it('fails on a DynamoDB table with provisioned capacity', () => {
    const violations = violationsAfter((stack) => {
      new dynamodb.Table(stack, 'Table', {
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PROVISIONED,
      });
    });
    expectViolation(violations, 'fixed-fee-property', /BillingMode must be PAY_PER_REQUEST/);
  });

  it('fails on a type that is not on the reviewed allow list', () => {
    const violations = violationsAfter((stack) => {
      new sqs.Queue(stack, 'Queue');
    });
    expectViolation(violations, 'resource-type', /AWS::SQS::Queue is not on the reviewed allow list/);
  });

  it('fails on a custom resource (not reviewed)', () => {
    const violations = violationsAfter((stack) => {
      new CfnResource(stack, 'Custom', { type: 'Custom::Anything', properties: { ServiceToken: 'arn' } });
    });
    expectViolation(violations, 'resource-type', /Custom::Anything is not on the reviewed allow list/);
  });
});

describe('(b) region', () => {
  it('fails on a stack in another region', () => {
    const violations = violationsAfter((_stack, { app }) => {
      const rogue = new Stage(app, 'rogue', { env: { region: 'us-east-1' } });
      new CupmarkStack(rogue, 'core', 'dev', 'rogue');
    });
    expectViolation(violations, 'region', /stack region is us-east-1/);
    expectViolation(violations, 'region', /manifest region is us-east-1/);
  });

  it('fails on another region mentioned in a template', () => {
    const violations = violationsAfter((stack) => {
      inlineFunction(stack, 'Fn', { functionName: 'cupmark-dev-fn', environment: { TARGET: 'eu-west-1' } });
    });
    expectViolation(violations, 'region', /template mentions region eu-west-1/);
  });
});

describe('(c) names', () => {
  it('fails on a bucket name without the cupmark-<stage>- prefix', () => {
    const violations = violationsAfter((stack) => {
      new s3.Bucket(stack, 'Site', { bucketName: 'derschweigert-site' });
    });
    expectViolation(violations, 'name', /BucketName "derschweigert-site" must start with cupmark-dev-/);
  });

  it('fails on an IAM role name without the prefix', () => {
    const violations = violationsAfter((stack) => {
      new iam.Role(stack, 'Role', { roleName: 'Admin', assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    });
    expectViolation(violations, 'name', /RoleName "Admin" must start with cupmark-dev-/);
  });

  it('fails on a name of the other stage, and flags the cross-stage reference', () => {
    const violations = violationsAfter((stack) => {
      new dynamodb.Table(stack, 'Table', {
        tableName: 'cupmark-prod-main',
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      });
    });
    expectViolation(violations, 'name', /TableName "cupmark-prod-main" must start with cupmark-dev-/);
    expectViolation(violations, 'isolation', /references stage prod/);
  });

  it('fails on a name that is not a literal and does not start with a literal prefix', () => {
    const violations = violationsAfter((stack) => {
      new s3.Bucket(stack, 'Bucket', { bucketName: Fn.join('-', [Aws.ACCOUNT_ID, 'cupmark-dev-x']) });
    });
    expectViolation(violations, 'name', /BucketName is not a literal and must start with cupmark-dev-/);
  });

  it('fails on a function name without the prefix, and on its log group', () => {
    const violations = violationsAfter((stack) => {
      inlineFunction(stack, 'Fn', { functionName: 'other-project-fn' });
    });
    expectViolation(violations, 'name', /FunctionName "other-project-fn" must start with cupmark-dev-/);
    expectViolation(violations, 'name', /LogGroupName is not a literal and must start with \/aws\/lambda\/cupmark-dev-/);
  });

  it('fails on a log group without a name (the generated one is outside the execution policy)', () => {
    const violations = violationsAfter((stack) => {
      new logs.LogGroup(stack, 'Logs');
    });
    expectViolation(violations, 'name', /LogGroupName must be set and start with \/aws\/lambda\/cupmark-dev- or \/cupmark\/dev\//);
  });

  it('fails on a schedule in the default group', () => {
    const violations = violationsAfter((stack) => {
      new scheduler.CfnSchedule(stack, 'Nightly', {
        scheduleExpression: 'cron(0 3 * * ? *)',
        flexibleTimeWindow: { mode: 'OFF' },
        target: { arn: 'arn:aws:lambda:eu-central-1:123456789012:function:cupmark-dev-rank', roleArn: 'arn:aws:iam::123456789012:role/cupmark-dev-x' },
      });
    });
    expectViolation(violations, 'name', /GroupName must be set/);
  });

  it('fails on a stack that does not extend CupmarkStack or has a foreign name', () => {
    const violations = violationsAfter((_stack, { stages }) => {
      const dev = stages[0];
      if (dev === undefined) throw new Error('dev missing');
      new Stack(dev, 'other', { stackName: 'derschweigert-site' });
    });
    expectViolation(violations, 'name', /must extend CupmarkStack/);
    expectViolation(violations, 'name', /stack name derschweigert-site must start with cupmark-<stage>-/);
    expectViolation(violations, 'bootstrap', /hnb659fds/);
  });
});

describe('(d) project tag', () => {
  it('fails on a taggable resource without project=cupmark', () => {
    const violations = violationsAfter((stack) => {
      const bucket = new s3.Bucket(stack, 'Bucket');
      Tags.of(bucket).remove('project');
    });
    expectViolation(violations, 'tag', /AWS::S3::Bucket lacks tag project=cupmark/);
  });

  it('fails on a stack without the project stack tag', () => {
    const violations = violationsAfter((_stack, { stages }) => {
      const dev = stages[0];
      if (dev === undefined) throw new Error('dev missing');
      new Stack(dev, 'untagged', { stackName: 'cupmark-dev-untagged' });
    });
    expectViolation(violations, 'tag', /stack tag project=cupmark is missing/);
  });
});

describe('(e) imports and lookups', () => {
  it('fails on Fn::ImportValue', () => {
    const violations = violationsAfter((stack) => {
      new CfnOutput(stack, 'Imported', { value: Fn.importValue('derschweigert-site-bucket') });
    });
    expectViolation(violations, 'import', /Fn::ImportValue is not allowed/);
  });

  it('fails on a context lookup', () => {
    const violations = violationsAfter(
      (stack) => {
        ssm.StringParameter.valueFromLookup(stack, '/cupmark/dev/anything');
      },
      { context: { 'cupmark:dev:account': FAKE_ACCOUNT } },
    );
    expectViolation(violations, 'import', /context lookup ssm is not allowed/);
  });

  it('fails on a VPC lookup', () => {
    const violations = violationsAfter(
      (stack) => {
        ec2.Vpc.fromLookup(stack, 'Default', { isDefault: true });
      },
      { context: { 'cupmark:dev:account': FAKE_ACCOUNT } },
    );
    expectViolation(violations, 'import', /context lookup vpc-provider is not allowed/);
  });

  it('fails on a resource imported by name', () => {
    const violations = violationsAfter((stack) => {
      s3.Bucket.fromBucketName(stack, 'Other', 'derschweigert-site');
    });
    expectViolation(violations, 'import', /imported resource/);
  });

  it('fails on an SSM parameter that is not a Cupmark parameter of the stage', () => {
    const violations = violationsAfter((stack) => {
      ssm.StringParameter.valueForStringParameter(stack, '/derschweigert/config');
    });
    expectViolation(violations, 'import', /SSM parameter \/derschweigert\/config is not a Cupmark parameter/);
  });

  it('fails on CfnInclude', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cupmark-include-'));
    try {
      const file = join(dir, 'foreign.json');
      writeFileSync(file, JSON.stringify({ Resources: {} }));
      const violations = violationsAfter((stack) => {
        new CfnInclude(stack, 'Foreign', { templateFile: file });
      });
      expectViolation(violations, 'import', /CfnInclude/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('permissions boundary', () => {
  it('fails on a role created outside a CupmarkStage, which has no boundary', () => {
    const violations = violationsAfter((_stack, { app }) => {
      const rogue = new Stage(app, 'rogue', { env: { region: 'eu-central-1' } });
      const stack = new CupmarkStack(rogue, 'core', 'dev', 'rogue');
      new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    });
    expectViolation(violations, 'boundary', /without the CupmarkBoundary permissions boundary/);
  });

  it('overrides any other boundary inside a CupmarkStage', () => {
    let template: Template | undefined;
    const violations = violationsAfter((stack) => {
      const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      (role.node.defaultChild as iam.CfnRole).addPropertyOverride(
        'PermissionsBoundary',
        'arn:aws:iam::123456789012:policy/SomethingElse',
      );
      template = Template.fromStack(stack);
    });
    expect(formatViolations(violations)).toBe('');
    expect(JSON.stringify(template?.toJSON())).not.toContain('SomethingElse');
  });
});
