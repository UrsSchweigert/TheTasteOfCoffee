// Health check. The body is a fixed literal: no free text, no build or
// environment values. Whether a route reaches it without a token is open
// question D9 (docs/07-open-questions.md); no route or infra exists yet.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const BODY = JSON.stringify({ status: 'ok' } as const);

export function handler(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: BODY,
  });
}
