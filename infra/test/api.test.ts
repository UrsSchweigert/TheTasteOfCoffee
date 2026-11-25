// M1-T2: the HTTP API, its routes and authorizer, and the two Lambda functions with
// their roles and log groups. The route list is checked against contracts/openapi.yaml.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { API_INDEX_ACTIONS, API_TABLE_ACTIONS, CATALOGUE_IMAGE_PREFIX, STAGE_LIMITS, cursorKeyParameter } from '../src/api.ts';
import { LABEL_PHOTO_PREFIX, UPLOAD_PHOTO_PREFIX } from '../src/data.ts';
import { backendBundle } from '../src/functions.ts';
import { STAGES } from '../src/config.ts';
import type { StageName } from '../src/config.ts';
import { API_ROUTES, UNAUTHENTICATED_ROUTES, routeKey } from '../src/routes.ts';
import { testApp } from './helpers.ts';

type Resource = { Type: string; Properties: Record<string, unknown> } & Record<string, unknown>;

// The contract's own YAML parser (backend devDependency `yaml`); infra adds no dependency.
const requireFromBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const yaml = requireFromBackend('yaml') as { parse: (text: string) => unknown };

interface ContractOperation {
  readonly key: string;
  readonly unauthenticated: boolean;
}

/** Every operation of contracts/openapi.yaml: `METHOD /path`, and whether it has `security: []`. */
function contractOperations(): ContractOperation[] {
  const file = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
  const doc = yaml.parse(readFileSync(file, 'utf8')) as { paths: Record<string, Record<string, { security?: unknown[] }>> };
  const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => methods.includes(method))
      .map(([method, op]) => ({
        key: `${method.toUpperCase()} ${path}`,
        unauthenticated: Array.isArray(op.security) && op.security.length === 0,
      })),
  );
}

function templateOf(stage: StageName): Template {
  const { stages } = testApp({ context: { stage } });
  const s = stages[0];
  if (s === undefined) throw new Error(`stage ${stage} missing`);
  return Template.fromStack(s.core);
}

function resources(template: Template, type: string): [string, Resource][] {
  return Object.entries(template.findResources(type)) as [string, Resource][];
}

function only(template: Template, type: string): [string, Resource] {
  const found = resources(template, type);
  expect(found, type).toHaveLength(1);
  const first = found[0];
  if (first === undefined) throw new Error(`no ${type}`);
  return first;
}

function byName(template: Template, type: string, nameProp: string, name: string): [string, Resource] {
  const hits = resources(template, type).filter(([, r]) => r.Properties[nameProp] === name);
  expect(hits, `${type} ${name}`).toHaveLength(1);
  const hit = hits[0];
  if (hit === undefined) throw new Error(`no ${type} ${name}`);
  return hit;
}

describe('the route list', () => {
  it('matches the operations of contracts/openapi.yaml exactly (method and path)', () => {
    const contract = contractOperations().map((o) => o.key).sort();
    const routes = API_ROUTES.map(routeKey).sort();
    expect(routes).toEqual(contract);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('leaves the authorizer off exactly the routes the contract marks `security: []`, and only listed ones', () => {
    const contractOpen = contractOperations().filter((o) => o.unauthenticated).map((o) => o.key).sort();
    const routesOpen = API_ROUTES.filter((r) => r.auth === 'none').map(routeKey).sort();
    expect(routesOpen).toEqual(contractOpen);
    expect(routesOpen).toEqual([...UNAUTHENTICATED_ROUTES].sort());
    // ADR 0007. The App Store notifications route joins in M4, with its ADR.
    expect(UNAUTHENTICATED_ROUTES).toEqual(['GET /health']);
  });

  it('sends GET /health to the health function and everything else to the API function', () => {
    for (const r of API_ROUTES) expect(r.target, routeKey(r)).toBe(r.path === '/health' ? 'health' : 'api');
  });
});

describe('backend bundles', () => {
  it('fails with a clear message when the backend was not built', () => {
    expect(() => backendBundle('api', '/nonexistent/backend/dist')).toThrow(/Run `npm ci && npm run build` in backend\//);
  });
});

describe.each(STAGES)('stage %s', (stage) => {
  const template = templateOf(stage);
  const [poolId] = only(template, 'AWS::Cognito::UserPool');
  const [clientId] = only(template, 'AWS::Cognito::UserPoolClient');
  const [apiId, api] = only(template, 'AWS::ApiGatewayV2::Api');
  const [authorizerId, authorizer] = only(template, 'AWS::ApiGatewayV2::Authorizer');
  const [apiFnId, apiFn] = byName(template, 'AWS::Lambda::Function', 'FunctionName', `cupmark-${stage}-api`);
  const [healthFnId, healthFn] = byName(template, 'AWS::Lambda::Function', 'FunctionName', `cupmark-${stage}-health`);
  const [tableId] = only(template, 'AWS::DynamoDB::Table');
  const photoBucketId = resources(template, 'AWS::S3::Bucket')
    .filter(([, r]) => JSON.stringify(r.Properties.BucketName).includes(`"cupmark-${stage}-photos-"`))
    .map(([id]) => id)[0];

  describe('the HTTP API', () => {
    it(`is an HTTP API named cupmark-${stage}-api`, () => {
      expect(api.Properties.Name).toBe(`cupmark-${stage}-api`);
      expect(api.Properties.ProtocolType).toBe('HTTP');
      expect(api.Properties.CorsConfiguration).toBeUndefined();
    });

    it('has only the $default stage, auto-deployed and throttled', () => {
      const [, s] = only(template, 'AWS::ApiGatewayV2::Stage');
      expect(s.Properties.StageName).toBe('$default');
      expect(s.Properties.AutoDeploy).toBe(true);
      expect(s.Properties.ApiId).toEqual({ Ref: apiId });
      expect(s.Properties.DefaultRouteSettings).toEqual({
        ThrottlingRateLimit: STAGE_LIMITS[stage].throttleRate,
        ThrottlingBurstLimit: STAGE_LIMITS[stage].throttleBurst,
      });
    });

    it('has a JWT authorizer for the stage pool and app client', () => {
      expect(authorizer.Properties).toEqual({
        ApiId: { Ref: apiId },
        AuthorizerType: 'JWT',
        Name: `cupmark-${stage}-cognito`,
        IdentitySource: ['$request.header.Authorization'],
        JwtConfiguration: {
          Audience: [{ Ref: clientId }],
          Issuer: { 'Fn::Join': ['', ['https://cognito-idp.eu-central-1.amazonaws.com/', { Ref: poolId }]] },
        },
      });
    });

    it('has exactly one route per contract operation', () => {
      const keys = resources(template, 'AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties.RouteKey as string).sort();
      expect(keys).toEqual(contractOperations().map((o) => o.key).sort());
    });

    it('attaches the JWT authorizer to every route except the unauthenticated ones', () => {
      for (const [, route] of resources(template, 'AWS::ApiGatewayV2::Route')) {
        const key = route.Properties.RouteKey as string;
        expect(route.Properties.ApiId, key).toEqual({ Ref: apiId });
        if (UNAUTHENTICATED_ROUTES.includes(key)) {
          expect(route.Properties.AuthorizationType, key).toBe('NONE');
          expect(route.Properties.AuthorizerId, key).toBeUndefined();
        } else {
          expect(route.Properties.AuthorizationType, key).toBe('JWT');
          expect(route.Properties.AuthorizerId, key).toEqual({ Ref: authorizerId });
        }
      }
    });

    it('integrates every route with the right function, payload format 2.0', () => {
      const integrations = Object.fromEntries(resources(template, 'AWS::ApiGatewayV2::Integration'));
      for (const [, route] of resources(template, 'AWS::ApiGatewayV2::Route')) {
        const key = route.Properties.RouteKey as string;
        const target = JSON.stringify(route.Properties.Target);
        const integrationId = Object.keys(integrations).find((id) => target.includes(`"${id}"`));
        const integration = integrationId === undefined ? undefined : integrations[integrationId];
        expect(integration?.Properties, key).toMatchObject({
          IntegrationType: 'AWS_PROXY',
          PayloadFormatVersion: '2.0',
          IntegrationUri: { 'Fn::GetAtt': [key === 'GET /health' ? healthFnId : apiFnId, 'Arn'] },
        });
      }
    });

    it('lets API Gateway invoke each function only from this API', () => {
      const permissions = resources(template, 'AWS::Lambda::Permission');
      expect(permissions).toHaveLength(API_ROUTES.length);
      for (const [, p] of permissions) {
        expect(p.Properties.Principal).toBe('apigateway.amazonaws.com');
        expect(p.Properties.Action).toBe('lambda:InvokeFunction');
        expect(JSON.stringify(p.Properties.SourceArn)).toContain(`{"Ref":"${apiId}"}`);
      }
    });
  });

  describe.each([
    ['api', 256, 10, () => STAGE_LIMITS[stage].apiConcurrency],
    ['health', 128, 3, () => STAGE_LIMITS[stage].healthConcurrency],
  ] as const)('the %s function', (part, memory, timeout, concurrency) => {
    const [, fn] = part === 'api' ? [apiFnId, apiFn] : [healthFnId, healthFn];
    const name = `cupmark-${stage}-${part}`;
    const [logGroupId, logGroup] = byName(template, 'AWS::Logs::LogGroup', 'LogGroupName', `/aws/lambda/${name}`);
    const [roleId, role] = byName(template, 'AWS::IAM::Role', 'RoleName', name);

    it('runs Node 22 on arm64 from the backend bundle, outside any VPC', () => {
      expect(fn.Properties).toMatchObject({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        MemorySize: memory,
        Timeout: timeout,
      });
      expect(fn.Properties.VpcConfig).toBeUndefined();
      expect(JSON.stringify(fn.Properties.Code)).toContain('cdk-cupmark-assets-');
    });

    it('has a reserved concurrency cap', () => {
      expect(fn.Properties.ReservedConcurrentExecutions).toBe(concurrency());
    });

    it('logs to its own log group, kept 14 days', () => {
      expect(logGroup.Properties.RetentionInDays).toBe(14);
      expect(fn.Properties.LoggingConfig).toEqual({ LogGroup: { Ref: logGroupId } });
    });

    it('has its own role, with the boundary and no managed policies', () => {
      expect(fn.Properties.Role).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
      expect(role.Properties.AssumeRolePolicyDocument).toEqual({
        Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
        Version: '2012-10-17',
      });
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(':policy/CupmarkBoundary');
    });

    it('grants exactly the permissions the function uses', () => {
      const logs = {
        Sid: 'Logs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: { 'Fn::GetAtt': [logGroupId, 'Arn'] },
      };
      const tableArn = { 'Fn::GetAtt': [tableId, 'Arn'] };
      const expected =
        part === 'health'
          ? [logs]
          : [
              logs,
              { Sid: 'Table', Effect: 'Allow', Action: [...API_TABLE_ACTIONS], Resource: tableArn },
              {
                Sid: 'ReviewQueueIndex',
                Effect: 'Allow',
                Action: API_INDEX_ACTIONS[0],
                Resource: { 'Fn::Join': ['', [tableArn, '/index/gsi1']] },
              },
              {
                Sid: 'CursorKey',
                Effect: 'Allow',
                Action: 'ssm:GetParameter',
                Resource: {
                  'Fn::Join': ['', ['arn:aws:ssm:eu-central-1:', { Ref: 'AWS::AccountId' }, `:parameter/cupmark/${stage}/cursor-key`]],
                },
              },
              {
                Sid: 'CatalogueImages',
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject'],
                Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [photoBucketId, 'Arn'] }, '/catalogue/*']] },
              },
              {
                Sid: 'LabelPhotoUploads',
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject'],
                Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [photoBucketId, 'Arn'] }, '/uploads/*']] },
              },
              {
                Sid: 'LabelPhotos',
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [photoBucketId, 'Arn'] }, '/labels/*']] },
              },
            ];
      expect(role.Properties.Policies).toEqual([
        { PolicyName: name, PolicyDocument: { Version: '2012-10-17', Statement: expected } },
      ]);
      // No separate policy resource adds anything.
      expect(resources(template, 'AWS::IAM::Policy')).toEqual([]);
    });
  });

  it('lets the API role touch the photo bucket only under catalogue/, uploads/ and labels/, without List or Delete (ADR 0016)', () => {
    const [, apiRole] = byName(template, 'AWS::IAM::Role', 'RoleName', `cupmark-${stage}-api`);
    const statements = (apiRole.Properties.Policies as { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } }[])
      .flatMap((p) => p.PolicyDocument.Statement);
    const actions = statements.flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
    // No delete of any kind (s3:DeleteObject, s3:DeleteObjectVersion, ...) and no S3 listing.
    expect(actions.filter((a) => /^s3:.*delete/i.test(a))).toEqual([]);
    expect(actions.filter((a) => /^s3:List/i.test(a))).toEqual([]);
    const s3 = statements
      .filter((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).some((a) => a.startsWith('s3:')))
      .map((st) => ({ actions: st.Action, resource: st.Resource }));
    const objects = (prefix: string) => ({ 'Fn::Join': ['', [{ 'Fn::GetAtt': [photoBucketId, 'Arn'] }, `/${prefix}*`]] });
    expect(s3).toEqual([
      { actions: ['s3:GetObject', 's3:PutObject'], resource: objects(CATALOGUE_IMAGE_PREFIX) },
      { actions: ['s3:GetObject', 's3:PutObject'], resource: objects(UPLOAD_PHOTO_PREFIX) },
      { actions: 's3:PutObject', resource: objects(LABEL_PHOTO_PREFIX) },
    ]);
    expect([CATALOGUE_IMAGE_PREFIX, UPLOAD_PHOTO_PREFIX, LABEL_PHOTO_PREFIX]).toEqual(['catalogue/', 'uploads/', 'labels/']);
  });

  it('gives no role any delete action except the Apple identity-provider sync', () => {
    for (const [, r] of resources(template, 'AWS::IAM::Role')) {
      const actions = (r.Properties.Policies as { PolicyDocument: { Statement: { Action: string | string[] }[] } }[])
        .flatMap((p) => p.PolicyDocument.Statement)
        .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
      const deletes = actions.filter((a) => /delete/i.test(a) && a !== 'dynamodb:DeleteItem' && a !== 'cognito-idp:DeleteIdentityProvider');
      expect(deletes, String(r.Properties.RoleName)).toEqual([]);
    }
  });

  it('gives the API function the table name, the cursor key parameter and the photo bucket, and nothing secret', () => {
    expect(photoBucketId).toBeDefined();
    expect(apiFn.Properties.Environment).toEqual({
      Variables: {
        TABLE_NAME: { Ref: tableId },
        CURSOR_KEY_PARAMETER: cursorKeyParameter(stage),
        PHOTO_BUCKET: { Ref: photoBucketId },
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    expect(cursorKeyParameter(stage)).toBe(`/cupmark/${stage}/cursor-key`);
  });

  it('gives the health function no data access and no configuration', () => {
    expect(healthFn.Properties.Environment).toEqual({ Variables: { NODE_OPTIONS: '--enable-source-maps' } });
  });

  it('gives the photo bucket name only to the API function, not to health or apple-idp', () => {
    const [, appleFn] = byName(template, 'AWS::Lambda::Function', 'FunctionName', `cupmark-${stage}-apple-idp`);
    for (const fn of [healthFn, appleFn]) {
      const variables = (fn.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
      expect(variables).not.toHaveProperty('PHOTO_BUCKET');
    }
  });

  it('names the photo bucket so the backend accepts it (PHOTO_BUCKET pattern, no `--`)', () => {
    // The backend's check of PHOTO_BUCKET (M1-T4c). The name is
    // Fn::Join of a literal prefix and AWS::AccountId; resolve it with a realistic id.
    const accepted = /^cupmark-[a-z0-9][a-z0-9-]{0,53}[a-z0-9]$/;
    const bucket = resources(template, 'AWS::S3::Bucket').find(([id]) => id === photoBucketId);
    const join = bucket?.[1].Properties.BucketName as { 'Fn::Join': [string, unknown[]] };
    const [separator, parts] = join['Fn::Join'];
    for (const account of ['123456789012', '000000000001', '999999999999']) {
      const name = parts
        .map((p) => {
          if (typeof p === 'string') return p;
          expect(p).toEqual({ Ref: 'AWS::AccountId' });
          return account;
        })
        .join(separator);
      expect(name).toBe(`cupmark-${stage}-photos-${account}`);
      expect(name).toMatch(accepted);
      expect(name).not.toContain('--');
    }
  });

  it('outputs the API URL, the pool and client ids, without exports', () => {
    const outputs = (template.toJSON() as { Outputs: Record<string, { Value: unknown; Export?: unknown }> }).Outputs;
    const values = Object.values(outputs).map((o) => o.Value);
    expect(values).toEqual(
      expect.arrayContaining([
        { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] },
        { Ref: poolId },
        { Ref: clientId },
        `https://cupmark-${stage}.auth.eu-central-1.amazoncognito.com`,
      ]),
    );
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });
});
