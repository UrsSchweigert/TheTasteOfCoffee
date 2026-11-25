import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { HealthStatusSchema } from '../src/generated/contract.ts';
import { handler } from '../src/handlers/health.ts';

function event(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /health',
    rawPath: '/health',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'example.invalid',
      domainPrefix: 'example',
      http: { method: 'GET', path: '/health', protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
      requestId: 'request',
      routeKey: 'GET /health',
      stage: '$default',
      time: '25/Nov/2026:07:30:00 +0000',
      timeEpoch: 0,
    },
  };
}

describe('health handler', () => {
  it('returns 200 with the fixed body {"status":"ok"}', async () => {
    const result = await handler(event());
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    expect(result.body).toBe('{"status":"ok"}');
    expect(HealthStatusSchema.safeParse(JSON.parse(result.body ?? '')).success).toBe(true);
  });

  it('puts nothing from the environment into the body', async () => {
    const saved = { ...process.env };
    process.env.npm_package_version = '9.9.9';
    process.env.AWS_LAMBDA_FUNCTION_VERSION = '42';
    try {
      const result = await handler(event());
      expect(result.body).toBe('{"status":"ok"}');
    } finally {
      process.env = saved;
    }
  });
});
