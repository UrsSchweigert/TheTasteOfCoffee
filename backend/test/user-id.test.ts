import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { userIdFromEvent } from '../src/auth/user-id.ts';

const SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function event(claims: Record<string, string | number | boolean | string[]> | undefined): APIGatewayProxyEventV2WithJWTAuthorizer {
  const base = {
    version: '2.0',
    routeKey: 'GET /profile',
    rawPath: '/profile',
    rawQueryString: `sub=${OTHER}`,
    queryStringParameters: { sub: OTHER, user_id: OTHER },
    pathParameters: { user_id: OTHER },
    headers: { 'x-user-id': OTHER },
    body: JSON.stringify({ sub: OTHER }),
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

describe('userIdFromEvent', () => {
  it('returns the token subject', () => {
    expect(userIdFromEvent(event({ sub: SUB }))).toBe(SUB);
  });

  it('ignores user ids in the query, path, headers and body', () => {
    expect(userIdFromEvent(event({ sub: SUB }))).not.toBe(OTHER);
  });

  it.each([
    ['no authorizer', undefined],
    ['no sub claim', { username: SUB }],
    ['an empty sub', { sub: '' }],
    ['a non-string sub', { sub: 42 }],
    ['a list as sub', { sub: [SUB] }],
    ['an upper-case sub', { sub: SUB.toUpperCase() }],
    ['a sub with a partition key separator', { sub: `${SUB}#PROFILE` }],
    ['a sub that is not a UUID', { sub: 'apple-user.0001' }],
  ])('returns undefined for %s', (_name, claims) => {
    expect(userIdFromEvent(event(claims))).toBeUndefined();
  });
});
