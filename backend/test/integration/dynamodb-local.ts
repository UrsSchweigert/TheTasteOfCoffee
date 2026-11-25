// Connects the integration tests to DynamoDB Local, never to AWS.
//
// - Endpoint: DYNAMODB_ENDPOINT, default http://localhost:8000. Anything that is
//   not a loopback or plain-http endpoint is refused, so a stray environment
//   cannot point the tests at a real account.
// - Credentials: the fixed dummy pair DynamoDB Local accepts. They are not
//   secrets; the SDK's default provider chain is never consulted.
// - When DynamoDB Local is not reachable the suite is skipped with a message,
//   unless REQUIRE_DYNAMODB_LOCAL=1 (set in CI), which turns that into a failure.
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { newUlid } from '../../src/ids/ulid.ts';
import { tableKeySchema } from '../../src/repository/table.ts';

const DEFAULT_ENDPOINT = 'http://localhost:8000';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface LocalDynamoDb {
  readonly reachable: boolean;
  readonly reason: string;
  readonly client: DynamoDBClient;
  readonly documentClient: DynamoDBDocumentClient;
}

function localEndpoint(): string {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? DEFAULT_ENDPOINT;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('DYNAMODB_ENDPOINT must be a local http endpoint (DynamoDB Local), never AWS');
  }
  return endpoint;
}

export async function connectDynamoDbLocal(): Promise<LocalDynamoDb> {
  const endpoint = localEndpoint();
  const client = new DynamoDBClient({
    endpoint,
    region: 'eu-central-1',
    // DynamoDB Local's documented dummy credentials; not a secret.
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
  });
  const documentClient = DynamoDBDocumentClient.from(client);
  // Required (CI): wait up to 30 s for the service container to come up. Otherwise one quick try.
  const required = process.env.REQUIRE_DYNAMODB_LOCAL === '1';
  const attempts = required ? 30 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(3000) });
      return { reachable: true, reason: `DynamoDB Local reachable at ${endpoint}`, client, documentClient };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const detail = lastError instanceof Error ? lastError.message || lastError.name : 'unknown error';
  const reason =
    `DynamoDB Local is not reachable at ${endpoint} (${detail}). ` +
    'Start it with `npm run dynamodb:start` in backend/, or set DYNAMODB_ENDPOINT.';
  if (required) throw new Error(`${reason} REQUIRE_DYNAMODB_LOCAL=1, so this fails.`, { cause: lastError });
  console.warn(`SKIPPING integration tests: ${reason}`);
  return { reachable: false, reason, client, documentClient };
}

/** Creates a fresh table with the deployed key schema (src/repository/table.ts) and returns its name. */
export async function createTestTable(client: DynamoDBClient): Promise<string> {
  const tableName = `cupmark-test-${newUlid().toLowerCase()}`;
  const schema = tableKeySchema();
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [...schema.KeySchema],
      AttributeDefinitions: [...schema.AttributeDefinitions],
      GlobalSecondaryIndexes: schema.GlobalSecondaryIndexes.map((index) => ({
        IndexName: index.IndexName,
        KeySchema: [...index.KeySchema],
        Projection: { ProjectionType: index.Projection.ProjectionType },
      })),
      StreamSpecification: { StreamEnabled: true, StreamViewType: schema.StreamSpecification.StreamViewType },
    }),
  );
  return tableName;
}

export async function deleteTestTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
}
