// The API of a stage (docs/05-system-design.md, Components): an API Gateway HTTP API
// with the built-in Cognito JWT authorizer and stage throttling, and the two Lambda
// functions behind it (`api` and `health`). Each function has its own role with only
// the permissions it uses, a reserved concurrency cap and a 14-day log group.
//
// The functions run outside any VPC, so they reach Open Food Facts over HTTPS through
// Lambda's own internet access: no VPC, no NAT gateway, no fixed fee.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NAME_PREFIX } from './config.ts';
import type { StageName } from './config.ts';
import type { CupmarkData } from './data.ts';
import { REVIEW_QUEUE_INDEX } from './data.ts';
import { API_ROUTES, routeKey } from './routes.ts';
import type { RouteTarget } from './routes.ts';

/** backend/dist, written by `npm run build` in backend/ (backend/scripts/build.ts). */
export const BACKEND_DIST_DIR = fileURLToPath(new URL('../../backend/dist/', import.meta.url));

/** Prefix of every object the API may read and write in the photo bucket (ADR 0011). */
export const CATALOGUE_IMAGE_PREFIX = 'catalogue/';

/** Parameter Store SecureString with the cursor HMAC key (ADR 0013). */
export function cursorKeyParameter(stage: StageName): string {
  return `/cupmark/${stage}/cursor-key`;
}

/**
 * Exactly the DynamoDB actions the repository (backend/src/repository/) uses.
 * Transactions need no action of their own: TransactWriteItems is authorised per
 * contained Put, Update, Delete and ConditionCheck.
 */
export const API_TABLE_ACTIONS = [
  'dynamodb:ConditionCheckItem',
  'dynamodb:DeleteItem',
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:Query',
  'dynamodb:UpdateItem',
] as const;
/** On the review-queue index only reads. */
export const API_INDEX_ACTIONS = ['dynamodb:Query'] as const;

export interface StageLimits {
  /** HTTP API stage throttling: steady requests per second, and burst. */
  readonly throttleRate: number;
  readonly throttleBurst: number;
  /** Reserved concurrency caps (free; they bound the cost of a request flood). */
  readonly apiConcurrency: number;
  readonly healthConcurrency: number;
}

/**
 * docs/06 assumes 60 calls per active user a month: 10,000 users are about 0.25
 * requests per second on average. These caps leave ample room and bound a flood.
 */
export const STAGE_LIMITS: Readonly<Record<StageName, StageLimits>> = {
  dev: { throttleRate: 10, throttleBurst: 20, apiConcurrency: 5, healthConcurrency: 1 },
  prod: { throttleRate: 25, throttleBurst: 50, apiConcurrency: 10, healthConcurrency: 2 },
};

export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

/** Physical name of a function (and its role and log group): `cupmark-<stage>-<part>`. */
export function functionName(stage: StageName, part: RouteTarget): string {
  return `${NAME_PREFIX}${stage}-${part}`;
}

/** The bundle of a handler, or a clear error if the backend was not built. */
export function backendBundle(name: RouteTarget, distDir: string = BACKEND_DIST_DIR): lambda.Code {
  const dir = join(distDir, name);
  if (!existsSync(join(dir, 'index.mjs'))) {
    throw new Error(
      `Backend bundle ${join(dir, 'index.mjs')} is missing. Run \`npm ci && npm run build\` in backend/ before synthesising infra.`,
    );
  }
  return lambda.Code.fromAsset(dir);
}

export interface CupmarkApiProps {
  readonly stage: StageName;
  readonly data: CupmarkData;
  readonly userPool: cognito.IUserPool;
  readonly appClient: cognito.IUserPoolClient;
}

interface FunctionSpec {
  readonly part: RouteTarget;
  readonly description: string;
  readonly memorySize: number;
  readonly timeout: Duration;
  readonly concurrency: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly statements: readonly iam.PolicyStatement[];
}

export class CupmarkApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly stage: apigwv2.HttpStage;
  public readonly apiFunction: lambda.Function;
  public readonly healthFunction: lambda.Function;
  readonly #cupmarkStage: StageName;

  public constructor(scope: Construct, id: string, props: CupmarkApiProps) {
    super(scope, id);
    const { stage, data } = props;
    this.#cupmarkStage = stage;
    const limits = STAGE_LIMITS[stage];
    const stack = Stack.of(this);

    const cursorKeyArn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      // formatArn adds the slash; the parameter name starts with one.
      resourceName: cursorKeyParameter(stage).slice(1),
    });

    this.apiFunction = this.function({
      part: 'api',
      description: 'Cupmark API (contracts/openapi.yaml)',
      memorySize: 256,
      timeout: Duration.seconds(10),
      concurrency: limits.apiConcurrency,
      environment: {
        TABLE_NAME: data.table.tableName,
        CURSOR_KEY_PARAMETER: cursorKeyParameter(stage),
      },
      statements: [
        new iam.PolicyStatement({
          sid: 'Table',
          actions: [...API_TABLE_ACTIONS],
          resources: [data.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReviewQueueIndex',
          actions: [...API_INDEX_ACTIONS],
          resources: [`${data.table.tableArn}/index/${REVIEW_QUEUE_INDEX.indexName}`],
        }),
        new iam.PolicyStatement({
          sid: 'CursorKey',
          actions: ['ssm:GetParameter'],
          resources: [cursorKeyArn],
        }),
        new iam.PolicyStatement({
          sid: 'CatalogueImages',
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [data.photoBucket.arnForObjects(`${CATALOGUE_IMAGE_PREFIX}*`)],
        }),
      ],
    });

    this.healthFunction = this.function({
      part: 'health',
      description: 'Cupmark health check (ADR 0007)',
      memorySize: 128,
      timeout: Duration.seconds(3),
      concurrency: limits.healthConcurrency,
      environment: {},
      statements: [],
    });

    const authorizer = new HttpUserPoolAuthorizer('Cognito', props.userPool, {
      authorizerName: `${NAME_PREFIX}${stage}-cognito`,
      userPoolClients: [props.appClient],
      identitySource: ['$request.header.Authorization'],
    });

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${NAME_PREFIX}${stage}-api`,
      description: `Cupmark ${stage} API`,
      // The API Lambda routes on `rawPath`, so the stage must be `$default` (ADR 0013).
      createDefaultStage: false,
    });
    this.stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: limits.throttleRate, burstLimit: limits.throttleBurst },
    });

    const integrations: Record<RouteTarget, HttpLambdaIntegration> = {
      api: new HttpLambdaIntegration('ApiIntegration', this.apiFunction, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
      health: new HttpLambdaIntegration('HealthIntegration', this.healthFunction, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    };

    for (const route of API_ROUTES) {
      new apigwv2.HttpRoute(this, `Route ${routeKey(route)}`, {
        httpApi: this.httpApi,
        routeKey: apigwv2.HttpRouteKey.with(route.path, apigwv2.HttpMethod[route.method]),
        integration: integrations[route.target],
        authorizer: route.auth === 'jwt' ? authorizer : new apigwv2.HttpNoneAuthorizer(),
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint, description: 'HTTP API base URL ($default stage)' });
  }

  private function(spec: FunctionSpec): lambda.Function {
    const name = functionName(this.#cupmarkStage, spec.part);
    const id = spec.part === 'api' ? 'Api' : 'Health';

    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      logGroupName: `/aws/lambda/${name}`,
      retention: LOG_RETENTION,
      // Logs are operational only (docs/06: no payloads); they go with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, `${id}Role`, {
      roleName: name,
      description: `Execution role of ${name}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        [name]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'Logs',
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [logGroup.logGroupArn],
            }),
            ...spec.statements,
          ],
        }),
      },
    });

    return new lambda.Function(this, `${id}Function`, {
      functionName: name,
      description: spec.description,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: backendBundle(spec.part),
      memorySize: spec.memorySize,
      timeout: spec.timeout,
      reservedConcurrentExecutions: spec.concurrency,
      role,
      logGroup,
      environment: { ...spec.environment, NODE_OPTIONS: '--enable-source-maps' },
    });
  }
}
