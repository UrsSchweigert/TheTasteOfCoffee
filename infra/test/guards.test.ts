// Each guard in src/guards.ts must be able to fail. Every test adds one bad thing to a
// throwaway copy of the dev stage and expects the matching violation. Nothing here is
// written to cdk.out or deployed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aws, CfnDeletionPolicy, CfnOutput, CfnResource, Duration, Fn, RemovalPolicy, Stack, Stage, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
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
import { AWS_MANAGED_ARN_EXCEPTIONS, DENIED_RESOURCE_TYPES, STATEFUL_RESOURCE_TYPES, formatViolations } from '../src/guards.ts';
import type { GuardName, Violation } from '../src/guards.ts';
import { CupmarkStack } from '../src/stage.ts';
import { FAKE_ACCOUNT, violationsAfter } from './helpers.ts';

function expectViolation(violations: readonly Violation[], guard: GuardName, message: RegExp): void {
  const hit = violations.some((v) => v.guard === guard && message.test(v.message));
  expect(hit, `expected [${guard}] ${String(message)} in:\n${formatViolations(violations)}`).toBe(true);
}

/**
 * A function with inline code. Unless the props bring a role, it gets a bare role of
 * its own: CDK's default role carries AWSLambdaBasicExecutionRole, which the iam
 * guard rejects (logs on `*`).
 */
function inlineFunction(stack: Stack, id: string, props: Partial<lambda.FunctionProps> = {}): lambda.Function {
  return new lambda.Function(stack, id, {
    role: new iam.Role(stack, `${id}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline('export const handler = async () => ({ statusCode: 200 });'),
    ...props,
  });
}

describe('positive control', () => {
  // Template validation stays on, as in cdk.json: the representative resources must
  // also pass CloudFormation's own rules, not only the Cupmark guards.
  it('passes a stack of representative, correctly named M1 resources, with template validation on', () => {
    const violations = violationsAfter((stack) => {
      new dynamodb.Table(stack, 'Table', {
        tableName: 'cupmark-dev-other',
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      new s3.Bucket(stack, 'Photos', {
        bucketName: Fn.join('', ['cupmark-dev-other-', Aws.ACCOUNT_ID]),
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const logGroup = new logs.LogGroup(stack, 'ProbeLogs', {
        logGroupName: '/aws/lambda/cupmark-dev-probe',
        retention: logs.RetentionDays.TWO_WEEKS,
      });
      const fn = inlineFunction(stack, 'Probe', { functionName: 'cupmark-dev-probe', logGroup });
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
    }, { validateTemplates: true });
    expect(formatViolations(violations)).toBe('');
  });

  it('fails the synth when template validation is on and a resource is invalid', () => {
    // Proves the positive control above really runs CloudFormation's validation.
    expect(() =>
      violationsAfter((stack) => {
        new CfnResource(stack, 'Broken', { type: 'AWS::SNS::Topic', properties: { NoSuchProperty: true } });
      }, { validateTemplates: true }),
    ).toThrow(/NoSuchProperty.*\(CloudFormation Validate\)/);
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

  it.each(['cupmark-dev-x', 'cupmark-devx', 'cupmark-prod', 'other'])(
    'fails on a Cognito domain prefix other than exactly cupmark-dev: %s',
    (domain) => {
      const violations = violationsAfter((stack) => {
        new cognito.CfnUserPoolDomain(stack, 'Domain', { domain, userPoolId: 'eu-central-1_abcdefghi' });
      });
      expectViolation(violations, 'name', /UserPoolDomain.Domain ".*" must be exactly cupmark-dev$/);
    },
  );

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

describe('(f) stateful resources', () => {
  /** A table that passes the stateful guard, with one property overridden. */
  function safeTable(stack: Stack, props: Partial<dynamodb.TableProps> = {}): dynamodb.Table {
    return new dynamodb.Table(stack, 'Table', {
      tableName: 'cupmark-dev-other',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      ...props,
    });
  }

  /** A bucket that passes the stateful guard, with one property overridden. */
  function safeBucket(stack: Stack, props: Partial<s3.BucketProps> = {}): s3.Bucket {
    return new s3.Bucket(stack, 'Bucket', {
      bucketName: Fn.join('', ['cupmark-dev-other-', Aws.ACCOUNT_ID]),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      ...props,
    });
  }

  function statefulOnly(violations: readonly Violation[]): Violation[] {
    return violations.filter((v) => v.guard === 'stateful');
  }

  it('passes a safe table and a safe bucket', () => {
    const violations = violationsAfter((stack) => {
      safeTable(stack);
      safeBucket(stack);
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on a table with RemovalPolicy.DESTROY', () => {
    const violations = violationsAfter((stack) => {
      safeTable(stack, { removalPolicy: RemovalPolicy.DESTROY });
    });
    expectViolation(violations, 'stateful', /AWS::DynamoDB::Table: DeletionPolicy is Delete, must be Retain/);
    expectViolation(violations, 'stateful', /AWS::DynamoDB::Table: UpdateReplacePolicy is Delete, must be Retain/);
  });

  it('fails on a table that is retained on delete but deleted on replacement', () => {
    const violations = violationsAfter((stack) => {
      const table = safeTable(stack);
      (table.node.defaultChild as dynamodb.CfnTable).cfnOptions.updateReplacePolicy = CfnDeletionPolicy.DELETE;
    });
    expect(statefulOnly(violations).map((v) => v.message)).toEqual([
      'AWS::DynamoDB::Table: UpdateReplacePolicy is Delete, must be Retain (RemovalPolicy.RETAIN)',
    ]);
  });

  it('fails on a table without deletion protection', () => {
    const violations = violationsAfter((stack) => {
      safeTable(stack, { deletionProtection: false });
    });
    expectViolation(violations, 'stateful', /DeletionProtectionEnabled must be true/);
  });

  it('fails on a table without point-in-time recovery', () => {
    const violations = violationsAfter((stack) => {
      safeTable(stack, { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false } });
    });
    expectViolation(violations, 'stateful', /PointInTimeRecoveryEnabled must be true/);
  });

  it('fails on a raw L1 table with none of the safety properties', () => {
    const violations = violationsAfter((stack) => {
      new dynamodb.CfnTable(stack, 'Raw', {
        tableName: 'cupmark-dev-raw',
        billingMode: 'PAY_PER_REQUEST',
        keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
        attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      });
    });
    expect(statefulOnly(violations)).toHaveLength(4);
  });

  it('fails on an unversioned bucket', () => {
    const violations = violationsAfter((stack) => {
      safeBucket(stack, { versioned: false });
    });
    expectViolation(violations, 'stateful', /AWS::S3::Bucket: VersioningConfiguration.Status must be Enabled/);
  });

  it('fails on a bucket with RemovalPolicy.DESTROY', () => {
    const violations = violationsAfter((stack) => {
      safeBucket(stack, { removalPolicy: RemovalPolicy.DESTROY });
    });
    expectViolation(violations, 'stateful', /AWS::S3::Bucket: DeletionPolicy is Delete, must be Retain/);
  });

  it('fails on a bucket whose public access block is partial', () => {
    const violations = violationsAfter((stack) => {
      safeBucket(stack, {
        blockPublicAccess: new s3.BlockPublicAccess({
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: false,
          restrictPublicBuckets: false,
        }),
      });
    });
    expectViolation(violations, 'stateful', /must set BlockPublicPolicy, RestrictPublicBuckets to true/);
  });
});

describe('(f) stateful: the user pool', () => {
  function pool(stack: Stack, props: Partial<cognito.UserPoolProps> = {}): cognito.UserPool {
    return new cognito.UserPool(stack, 'Pool', {
      userPoolName: 'cupmark-dev-other',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      ...props,
    });
  }

  it('is a stateful type', () => {
    expect(STATEFUL_RESOURCE_TYPES).toContain('AWS::Cognito::UserPool');
  });

  it('passes a retained pool with deletion protection', () => {
    const violations = violationsAfter((stack) => {
      pool(stack);
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on a pool without deletion protection', () => {
    const violations = violationsAfter((stack) => {
      pool(stack, { deletionProtection: false });
    });
    expectViolation(violations, 'stateful', /AWS::Cognito::UserPool: DeletionProtection must be ACTIVE/);
  });

  it('fails on a pool with RemovalPolicy.DESTROY', () => {
    const violations = violationsAfter((stack) => {
      pool(stack, { removalPolicy: RemovalPolicy.DESTROY });
    });
    expectViolation(violations, 'stateful', /AWS::Cognito::UserPool: DeletionPolicy is Delete, must be Retain/);
    expectViolation(violations, 'stateful', /AWS::Cognito::UserPool: UpdateReplacePolicy is Delete, must be Retain/);
  });
});

describe('(g) IAM policies', () => {
  const lambdaPrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');

  function roleWith(stack: Stack, ...statements: iam.PolicyStatement[]): iam.Role {
    return new iam.Role(stack, 'Role', {
      assumedBy: lambdaPrincipal,
      inlinePolicies: { probe: new iam.PolicyDocument({ statements }) },
    });
  }

  function iamOnly(violations: readonly Violation[]): string[] {
    return violations.filter((v) => v.guard === 'iam').map((v) => v.message);
  }

  it('passes ARNs of this stack, Cupmark-named ARNs and the own parameters', () => {
    const violations = violationsAfter((stack) => {
      const table = new dynamodb.Table(stack, 'Table', {
        tableName: 'cupmark-dev-other',
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const role = roleWith(
        stack,
        new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [table.tableArn, `${table.tableArn}/index/gsi1`] }),
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'cupmark/dev/x' })],
        }),
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`arn:aws:s3:::cupmark-dev-other-${Aws.ACCOUNT_ID}/catalogue/*`] }),
      );
      // A separate AWS::IAM::Policy is checked too.
      role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [table.tableArn] }));
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on Resource "*"', () => {
    const violations = violationsAfter((stack) => {
      roleWith(stack, new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: ['*'] }));
    });
    expectViolation(violations, 'iam', /Resource "\*" is not allowed/);
  });

  it.each(['*', 's3:*', 'dynamodb:Get*'])('fails on the wildcard action %s', (action) => {
    const violations = violationsAfter((stack) => {
      roleWith(stack, new iam.PolicyStatement({ actions: [action], resources: ['arn:aws:s3:::cupmark-dev-x/*'] }));
    });
    expectViolation(violations, 'iam', /has a wildcard/);
  });

  it.each([
    ['another project', 'arn:aws:s3:::derschweigert-site/*'],
    ['a wildcard name', 'arn:aws:dynamodb:eu-central-1:123456789012:table/*'],
    ['a prefix without the dash', 'arn:aws:dynamodb:eu-central-1:123456789012:table/cupmark*'],
    ['another account', 'arn:aws:dynamodb:eu-central-1:999999999999:table/cupmark-dev-main'],
    ['a non-ARN', 'cupmark-dev-main'],
  ])('fails on a resource of %s', (_label, resource) => {
    const violations = violationsAfter(
      (stack) => {
        roleWith(stack, new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [resource] }));
      },
      { context: { 'cupmark:dev:account': FAKE_ACCOUNT } },
    );
    expect(iamOnly(violations)).toHaveLength(1);
  });

  it.each([
    ['S3, cupmark- after another bucket', 'arn:aws:s3:::derschweigert/cupmark-x'],
    ['S3, cupmark- inside the bucket name', 'arn:aws:s3:::other-cupmark-x/*'],
    ['S3, the shared bootstrap bucket', 'arn:aws:s3:::cdk-hnb659fds-assets-123456789012-eu-central-1/*'],
    ['DynamoDB, an index named cupmark- of another table', 'arn:aws:dynamodb:eu-central-1:123456789012:table/other/index/cupmark-x'],
    ['Lambda, another function', 'arn:aws:lambda:eu-central-1:123456789012:function:other-cupmark-x'],
    ['SSM, cupmark/ under another path', 'arn:aws:ssm:eu-central-1:123456789012:parameter/other/cupmark/x'],
    ['logs, another log group', 'arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/other/cupmark-x:*'],
    ['IAM, a role under another path', 'arn:aws:iam::123456789012:role/other/cupmark-x'],
    ['Cognito, a literal pool ARN (only the template pool counts)', 'arn:aws:cognito-idp:eu-central-1:123456789012:userpool/*'],
    ['an unlisted service', 'arn:aws:sqs:eu-central-1:123456789012:cupmark-dev-queue'],
  ])('fails on a foreign ARN: %s', (_label, resource) => {
    const violations = violationsAfter(
      (stack) => {
        roleWith(stack, new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [resource] }));
      },
      { context: { 'cupmark:dev:account': FAKE_ACCOUNT } },
    );
    expect(iamOnly(violations)).toHaveLength(1);
    expectViolation(violations, 'iam', /is not a Cupmark resource|is not on OWNED_ARN_PREFIXES/);
  });

  it('passes literal ARNs whose first name segment is Cupmark\'s, for every listed service', () => {
    const violations = violationsAfter(
      (stack) => {
        roleWith(
          stack,
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [
              'arn:aws:s3:::cupmark-dev-x/catalogue/*',
              'arn:aws:s3:::cdk-cupmark-assets-123456789012-eu-central-1/*',
              'arn:aws:dynamodb:eu-central-1:123456789012:table/cupmark-dev-main/index/gsi1',
              'arn:aws:lambda:eu-central-1:123456789012:function:cupmark-dev-api',
              'arn:aws:ssm:eu-central-1:123456789012:parameter/cupmark/dev/x',
              'arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/cupmark-dev-api:*',
              'arn:aws:logs:eu-central-1:123456789012:log-group:/cupmark/dev/x:*',
              'arn:aws:iam::123456789012:role/cupmark-dev-api',
              'arn:aws:iam::123456789012:role/CupmarkGitHubDeploy',
              'arn:aws:iam::123456789012:policy/CupmarkBoundary',
            ],
          }),
        );
      },
      { context: { 'cupmark:dev:account': FAKE_ACCOUNT } },
    );
    expect(formatViolations(violations)).toBe('');
  });

  it('passes the template pool\'s ARN for the Cognito identity-provider actions', () => {
    const violations = violationsAfter((stack) => {
      const pool = new cognito.UserPool(stack, 'Pool', {
        userPoolName: 'cupmark-dev-other',
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      roleWith(stack, new iam.PolicyStatement({ actions: ['cognito-idp:UpdateIdentityProvider'], resources: [pool.userPoolArn] }));
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on a resource that cannot be resolved at synth time', () => {
    const violations = violationsAfter((stack) => {
      roleWith(stack, new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [Fn.importValue('Other-BucketArn')] }));
    });
    expectViolation(violations, 'iam', /cannot be checked at synth time/);
  });

  it('fails on NotAction and NotResource', () => {
    const violations = violationsAfter((stack) => {
      roleWith(
        stack,
        new iam.PolicyStatement({ notActions: ['iam:CreateUser'], resources: ['arn:aws:s3:::cupmark-dev-x'] }),
        new iam.PolicyStatement({ actions: ['s3:GetObject'], notResources: ['arn:aws:s3:::cupmark-dev-x'] }),
      );
    });
    expectViolation(violations, 'iam', /NotAction is not allowed/);
    expectViolation(violations, 'iam', /NotResource is not allowed/);
  });

  it('fails on an AWS-managed policy, for example the default Lambda role', () => {
    expect(AWS_MANAGED_ARN_EXCEPTIONS).toEqual([]);
    const violations = violationsAfter((stack) => {
      new lambda.Function(stack, 'Default', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('export const handler = async () => ({});'),
      });
    });
    expectViolation(violations, 'iam', /managed policy ".*AWSLambdaBasicExecutionRole" is not on AWS_MANAGED_ARN_EXCEPTIONS/);
  });

  it('checks AWS::IAM::Policy resources as well as inline role policies', () => {
    const violations = violationsAfter((stack) => {
      const role = new iam.Role(stack, 'Role', { assumedBy: lambdaPrincipal });
      role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: ['*'] }));
    });
    expect(violations.some((v) => v.guard === 'iam' && v.message.includes('AWS::IAM::Policy: Statement[0]: Resource "*"'))).toBe(true);
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

describe('(h) M1-T9: wildcards, trust policies and bucket policies', () => {
  const lambdaPrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');
  const fake = { context: { 'cupmark:dev:account': FAKE_ACCOUNT } };

  function roleWith(stack: Stack, ...statements: iam.PolicyStatement[]): iam.Role {
    return new iam.Role(stack, 'Role', {
      assumedBy: lambdaPrincipal,
      inlinePolicies: { probe: new iam.PolicyDocument({ statements }) },
    });
  }

  it.each([
    ['a table prefix', 'arn:aws:dynamodb:eu-central-1:123456789012:table/cupmark-dev-*'],
    ['an index wildcard', 'arn:aws:dynamodb:eu-central-1:123456789012:table/cupmark-dev-main/index/*'],
    ['a function prefix', 'arn:aws:lambda:eu-central-1:123456789012:function:cupmark-dev-*'],
    ['a parameter path', 'arn:aws:ssm:eu-central-1:123456789012:parameter/cupmark/dev/*'],
    ['a role prefix', 'arn:aws:iam::123456789012:role/cupmark-dev-*'],
    ['a bucket prefix', 'arn:aws:s3:::cupmark-dev-*'],
    ['a bucket wildcard before the key', 'arn:aws:s3:::cupmark-dev-*/catalogue/*'],
    ['a single-character wildcard', 'arn:aws:s3:::cupmark-dev-photo?'],
    ['a log group prefix', 'arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/cupmark-dev-*'],
  ])('fails on a resource wildcard after a Cupmark prefix: %s', (_label, resource) => {
    const violations = violationsAfter((stack) => {
      roleWith(stack, new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [resource] }));
    }, fake);
    expect(violations.filter((v) => v.guard === 'iam')).toHaveLength(1);
    expectViolation(violations, 'iam', /has a wildcard; only RESOURCE_WILDCARD_EXCEPTIONS allow one/);
  });

  it('passes the documented wildcard exceptions: objects of a bucket or a key prefix, and the streams of one log group', () => {
    const violations = violationsAfter((stack) => {
      const bucket = new s3.Bucket(stack, 'Bucket', {
        versioned: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      roleWith(
        stack,
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('*'), bucket.arnForObjects('catalogue/*'), 'arn:aws:s3:::cupmark-dev-x/a/b/*'],
        }),
        new iam.PolicyStatement({
          actions: ['logs:PutLogEvents'],
          resources: ['arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/cupmark-dev-x:*'],
        }),
      );
    }, fake);
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on a single-character wildcard in an action', () => {
    const violations = violationsAfter((stack) => {
      // PolicyStatement rejects `?` itself; a raw document does not.
      new iam.CfnRole(stack, 'Raw', {
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
        },
        policies: [
          {
            policyName: 'probe',
            policyDocument: { Statement: [{ Effect: 'Allow', Action: 'dynamodb:GetIte?', Resource: 'arn:aws:s3:::cupmark-dev-x' }] },
          },
        ],
      });
    });
    expectViolation(violations, 'iam', /action "dynamodb:GetIte\?" has a wildcard/);
  });

  it('fails on a stage role that names a cdk-cupmark bootstrap role (only the GitHub deploy role may)', () => {
    const violations = violationsAfter((stack) => {
      roleWith(
        stack,
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: ['arn:aws:iam::123456789012:role/cdk-cupmark-deploy-role-123456789012-eu-central-1'],
        }),
      );
    }, fake);
    expectViolation(violations, 'iam', /is not a Cupmark resource: it must start with iam:role\/cupmark-/);
  });

  it('fails on a bucket policy that allows anything', () => {
    const violations = violationsAfter((stack) => {
      const bucket = new s3.Bucket(stack, 'Bucket', {
        versioned: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [bucket.arnForObjects('*')], principals: [new iam.AccountRootPrincipal()] }),
      );
    });
    expectViolation(violations, 'iam', /AWS::S3::BucketPolicy: Statement\[\d\]: a bucket policy may only Deny/);
  });

  it.each<[string, () => iam.IPrincipal, RegExp]>([
    ['a service that is not reviewed', () => new iam.ServicePrincipal('ec2.amazonaws.com'), /service principal "ec2.amazonaws.com" is not on TRUSTED_SERVICE_PRINCIPALS/],
    ['another account', () => new iam.AccountPrincipal('999999999999'), /AWS principals are not allowed/],
    ['anyone', () => new iam.AnyPrincipal(), /AWS principals are not allowed/],
    ['a federated provider in a stage stack', () => new iam.WebIdentityPrincipal('token.actions.githubusercontent.com'), /Federated principal is only allowed in cupmark-github-oidc/],
  ])('fails on a role that trusts %s', (_label, principal, message) => {
    const violations = violationsAfter((stack) => {
      new iam.Role(stack, 'Role', { assumedBy: principal() });
    });
    expectViolation(violations, 'trust', message);
  });

  it('fails on a GitHub OIDC provider or the deploy role in a stage stack', () => {
    const violations = violationsAfter((stack) => {
      new iam.CfnOIDCProvider(stack, 'Provider', { url: 'https://token.actions.githubusercontent.com', clientIdList: ['sts.amazonaws.com'] });
      new iam.Role(stack, 'Deploy', { roleName: 'CupmarkGitHubDeploy', assumedBy: lambdaPrincipal });
    });
    expectViolation(violations, 'resource-type', /AWS::IAM::OIDCProvider is not on the reviewed allow list/);
    expectViolation(violations, 'name', /RoleName "CupmarkGitHubDeploy" must start with cupmark-dev-/);
  });
});
