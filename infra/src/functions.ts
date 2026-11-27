// One Cupmark Lambda function: Node 22 on arm64, code from the backend bundle, its own
// role (with the CupmarkBoundary boundary from the stage, and one inline policy with
// only the statements given), a reserved concurrency cap and a 14-day log group. Every
// function of the app is built here, so each gets the same guards-compliant shape.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { NAME_PREFIX } from './config.ts';
import type { StageName } from './config.ts';

/** backend/dist, written by `npm run build` in backend/ (backend/scripts/build.ts). */
export const BACKEND_DIST_DIR = fileURLToPath(new URL('../../backend/dist/', import.meta.url));

/** The handlers in backend/src/handlers/ that infra deploys. */
export type BackendHandler = 'api' | 'health' | 'apple-idp' | 'nightly-aggregates';

export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

/** Physical name of a function (and its role and log group): `cupmark-<stage>-<part>`. */
export function functionName(stage: StageName, part: BackendHandler): string {
  return `${NAME_PREFIX}${stage}-${part}`;
}

/** The bundle of a handler, or a clear error if the backend was not built. */
export function backendBundle(name: BackendHandler, distDir: string = BACKEND_DIST_DIR): lambda.Code {
  const dir = join(distDir, name);
  if (!existsSync(join(dir, 'index.mjs'))) {
    throw new Error(
      `Backend bundle ${join(dir, 'index.mjs')} is missing. Run \`npm ci && npm run build\` in backend/ before synthesising infra.`,
    );
  }
  return lambda.Code.fromAsset(dir);
}

/** `arn:<partition>:logs:<region>:<account>:log-group:<name>:*`, the streams of a log group, from its literal name. */
export function logStreamsArn(scope: Construct, logGroupName: string): string {
  return Stack.of(scope).formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: `${logGroupName}:*`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

export interface FunctionSpec {
  readonly stage: StageName;
  readonly part: BackendHandler;
  /** Prefix of the construct ids: `<id>Logs`, `<id>Role`, `<id>Function`. */
  readonly id: string;
  readonly description: string;
  readonly memorySize: number;
  readonly timeout: Duration;
  /** Reserved concurrency cap; omit it for no reservation (the nightly job). */
  readonly concurrency?: number;
  /** Lambda's own asynchronous retries (0..2, default 2); omit to keep the default. */
  readonly retryAttempts?: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly statements: readonly iam.PolicyStatement[];
}

export function cupmarkFunction(scope: Construct, spec: FunctionSpec): lambda.Function {
  const name = functionName(spec.stage, spec.part);

  const logGroupName = `/aws/lambda/${name}`;
  const logGroup = new logs.LogGroup(scope, `${spec.id}Logs`, {
    logGroupName,
    retention: LOG_RETENTION,
    // Logs are operational only (docs/06: no payloads); they go with the stack.
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const role = new iam.Role(scope, `${spec.id}Role`, {
    roleName: name,
    description: `Execution role of ${name}`,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    inlinePolicies: {
      [name]: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'Logs',
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            // Built from the literal name, not logGroup.logGroupArn: that is Fn::GetAtt Arn,
            // which CloudFormation resolves with logs:DescribeLogGroups, and the execution
            // role cannot have that (it cannot be scoped to named log groups).
            resources: [logStreamsArn(scope, logGroupName)],
          }),
          ...spec.statements,
        ],
      }),
    },
  });

  return new lambda.Function(scope, `${spec.id}Function`, {
    functionName: name,
    description: spec.description,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: backendBundle(spec.part),
    memorySize: spec.memorySize,
    timeout: spec.timeout,
    ...(spec.retryAttempts === undefined ? {} : { retryAttempts: spec.retryAttempts }),
    ...(spec.concurrency === undefined ? {} : { reservedConcurrentExecutions: spec.concurrency }),
    role,
    logGroup,
    environment: { ...spec.environment, NODE_OPTIONS: '--enable-source-maps' },
  });
}
