// The API Lambda (docs/05-system-design.md, Components: one API function).
// Serves the routes in src/api/router.ts. Configuration comes from the
// environment set by infra (src/api/config.ts); a missing table name fails
// every request with 500, a missing cursor key fails the list routes only.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ENV, cursorSignerFromParameterStore } from '../api/config.ts';
import { empty } from '../api/http.ts';
import { createApi } from '../api/router.ts';
import { Repository } from '../repository/index.ts';

let api: ((event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>) | undefined;

function build(): typeof api {
  const tableName = process.env[ENV.tableName] ?? '';
  if (tableName === '') return undefined;
  return createApi({
    store: new Repository({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName }),
    cursorSigner: cursorSignerFromParameterStore(process.env[ENV.cursorKeyParameter], new SSMClient({})),
  });
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  api ??= build();
  if (api === undefined) {
    console.log(JSON.stringify({ operation: 'configuration', status: 500, error: 'TableNameMissing' }));
    return empty(500);
  }
  return api(event);
}
