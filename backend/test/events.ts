// Test helpers: API Gateway HTTP API events with a JWT authorizer context.
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { userIdFromEvent } from '../src/auth/user-id.ts';
import type { UserId } from '../src/auth/user-id.ts';

/** A user id that the tests plant in the query, path, headers and body. */
export const PLANTED_OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** An event whose token carries `claims`; every other place names PLANTED_OTHER. */
export function event(claims: Record<string, string | number | boolean | string[]> | undefined): APIGatewayProxyEventV2WithJWTAuthorizer {
  const base = {
    version: '2.0',
    routeKey: 'GET /profile',
    rawPath: '/profile',
    rawQueryString: `sub=${PLANTED_OTHER}`,
    queryStringParameters: { sub: PLANTED_OTHER, user_id: PLANTED_OTHER },
    pathParameters: { user_id: PLANTED_OTHER },
    headers: { 'x-user-id': PLANTED_OTHER },
    body: JSON.stringify({ sub: PLANTED_OTHER }),
    isBase64Encoded: false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'example.invalid',
      domainPrefix: 'example',
      http: { method: 'GET', path: '/profile', protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
      requestId: 'request',
      routeKey: 'GET /profile',
      stage: '$default',
      time: '25/Nov/2026:07:30:00 +0000',
      timeEpoch: 0,
      authorizer:
        claims === undefined
          ? undefined
          : { principalId: '', integrationLatency: 0, jwt: { claims, scopes: [] } },
    },
  };
  return base as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/** The verified UserId of a token subject, obtained the only way there is. */
export function verifiedUserId(sub: string): UserId {
  const id = userIdFromEvent(event({ sub }));
  if (id === undefined) throw new Error('not a valid token subject');
  return id;
}
