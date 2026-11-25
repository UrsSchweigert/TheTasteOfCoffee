// Health check for the post-deploy smoke test. ADR 0007 (D9) settled it:
// `GET /health` needs no token and returns only the fixed literal
// {"status":"ok"}, with no version, environment or other data. The route
// itself is declared in contracts/ and wired in infra/, not here.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const BODY = JSON.stringify({ status: 'ok' } as const);

export function handler(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: BODY,
  });
}
