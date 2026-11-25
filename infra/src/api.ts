// The API of a stage (docs/05-system-design.md, Components): an API Gateway HTTP API
// with the built-in Cognito JWT authorizer and stage throttling, and the two Lambda
// functions behind it (`api` and `health`). Each function has its own role with only
// the permissions it uses, a reserved concurrency cap and a 14-day log group.
//
// The functions run outside any VPC, so they reach Open Food Facts over HTTPS through
// Lambda's own internet access: no VPC, no NAT gateway, no fixed fee.

import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NAME_PREFIX } from './config.ts';
import type { StageName } from './config.ts';
import type { CupmarkData } from './data.ts';
import { DELETION_LOG_PREFIX, LABEL_PHOTO_PREFIX, REVIEW_QUEUE_INDEX, UPLOAD_PHOTO_PREFIX } from './data.ts';
import { cupmarkFunction } from './functions.ts';
import { API_ROUTES, routeKey } from './routes.ts';
import type { RouteTarget } from './routes.ts';

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

/**
 * ADR 0017: account deletion removes every version of the user's label photos under
 * `labels/` and `uploads/`, and nowhere else. These are the only photo prefixes the
 * API may list versions of or delete in.
 */
export const ACCOUNT_DELETION_PHOTO_PREFIXES = [LABEL_PHOTO_PREFIX, UPLOAD_PHOTO_PREFIX] as const;
/** The only Cognito action the API may call, on the stage pool only (ADR 0017). */
export const API_COGNITO_ACTIONS = ['cognito-idp:AdminDeleteUser'] as const;

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

export interface CupmarkApiProps {
  readonly stage: StageName;
  readonly data: CupmarkData;
  readonly userPool: cognito.IUserPool;
  readonly appClient: cognito.IUserPoolClient;
}


export class CupmarkApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly stage: apigwv2.HttpStage;
  public readonly apiFunction: lambda.Function;
  public readonly healthFunction: lambda.Function;

  public constructor(scope: Construct, id: string, props: CupmarkApiProps) {
    super(scope, id);
    const { stage, data } = props;
    const limits = STAGE_LIMITS[stage];
    const stack = Stack.of(this);

    const cursorKeyArn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      // formatArn adds the slash; the parameter name starts with one.
      resourceName: cursorKeyParameter(stage).slice(1),
    });

    this.apiFunction = cupmarkFunction(this, {
      stage,
      part: 'api',
      id: 'Api',
      description: 'Cupmark API (contracts/openapi.yaml)',
      memorySize: 256,
      timeout: Duration.seconds(10),
      concurrency: limits.apiConcurrency,
      environment: {
        TABLE_NAME: data.table.tableName,
        CURSOR_KEY_PARAMETER: cursorKeyParameter(stage),
        // The backend stores and serves catalogue images under `catalogue/` (ADR 0011),
        // signs label photo uploads to `uploads/` and writes stripped ones to `labels/`
        // (ADR 0016).
        PHOTO_BUCKET: data.photoBucket.bucketName,
        // Account deletion (ADR 0017): the log entry goes to this bucket, then the
        // Cognito user is deleted from this pool.
        DELETION_LOG_BUCKET: data.deletionLogBucket.bucketName,
        USER_POOL_ID: props.userPool.userPoolId,
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
        // ADR 0016. PutObject authorises the presigned POST the API signs; GetObject lets
        // the completion call read the raw upload. No delete: a lifecycle rule removes it.
        new iam.PolicyStatement({
          sid: 'LabelPhotoUploads',
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [data.photoBucket.arnForObjects(`${UPLOAD_PHOTO_PREFIX}*`)],
        }),
        // The stripped photo. Write only: the operator's tooling reads it, not the API.
        new iam.PolicyStatement({
          sid: 'LabelPhotos',
          actions: ['s3:PutObject'],
          resources: [data.photoBucket.arnForObjects(`${LABEL_PHOTO_PREFIX}*`)],
        }),
        // Account deletion (ADR 0017). Every version and delete marker of the user's
        // photos goes, so only these two prefixes; catalogue/ and verified/ are not the
        // user's data.
        new iam.PolicyStatement({
          sid: 'AccountDeletionPhotos',
          actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: ACCOUNT_DELETION_PHOTO_PREFIXES.map((p) => data.photoBucket.arnForObjects(`${p}*`)),
        }),
        // ListObjectVersions with the exact key as prefix, to find the version ids.
        new iam.PolicyStatement({
          sid: 'AccountDeletionPhotoVersions',
          actions: ['s3:ListBucketVersions'],
          resources: [data.photoBucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': ACCOUNT_DELETION_PHOTO_PREFIXES.map((p) => `${p}*`) } },
        }),
        // Write only: reading the log is for the operator's restore procedure (M5).
        new iam.PolicyStatement({
          sid: 'DeletionLog',
          actions: ['s3:PutObject'],
          resources: [data.deletionLogBucket.arnForObjects(`${DELETION_LOG_PREFIX}*`)],
        }),
        new iam.PolicyStatement({
          sid: 'AccountDeletionUser',
          actions: [...API_COGNITO_ACTIONS],
          resources: [props.userPool.userPoolArn],
        }),
      ],
    });

    this.healthFunction = cupmarkFunction(this, {
      stage,
      part: 'health',
      id: 'Health',
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
}
