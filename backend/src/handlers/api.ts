// The API Lambda (docs/05-system-design.md, Components: one API function).
// Serves the routes in src/api/router.ts. Configuration comes from the
// environment set by infra (src/api/config.ts); a missing table name fails
// every request with 500, a missing cursor key fails the list routes only, a
// missing Open Food Facts contact fails only lookups that would fetch (503), a
// missing photo bucket only stops image copies (hits without an image, and
// GET /catalogue_images is 404) and label photo uploads (both routes 500).
// DELETE /account needs PHOTO_BUCKET, DELETION_LOG_BUCKET and USER_POOL_ID;
// without any of them it answers 500 before it changes anything, and every
// other route keeps working.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { s3DeletionLogStore } from '../account/deletion-log.ts';
import { cognitoUserDirectory } from '../account/user-pool.ts';
import type { AccountDeletionConfig } from '../api/account.ts';
import { ENV, cursorSignerFromParameterStore, lookupCapFromEnv } from '../api/config.ts';
import { empty } from '../api/http.ts';
import { createApi } from '../api/router.ts';
import type { ApiDependencies } from '../api/router.ts';
import { s3CatalogueImageStore } from '../images/catalogue-store.ts';
import { s3LabelPhotoStore } from '../images/label-photo-store.ts';
import { s3PhotoDeletionStore } from '../images/photo-deletion-store.ts';
import { createOpenFoodFactsClient } from '../openfoodfacts/client.ts';
import { Repository } from '../repository/index.ts';

let api: ((event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>) | undefined;

function optionalImages(s3: S3Client): Pick<ApiDependencies, 'catalogueImages' | 'labelPhotos'> {
  const bucket = process.env[ENV.photoBucket];
  const catalogueImages = s3CatalogueImageStore(s3, bucket);
  const labelPhotos = s3LabelPhotoStore(s3, bucket);
  const cleanup = s3PhotoDeletionStore(s3, bucket);
  return {
    ...(catalogueImages === undefined ? {} : { catalogueImages }),
    ...(labelPhotos === undefined ? {} : { labelPhotos: { store: labelPhotos, ...(cleanup === undefined ? {} : { cleanup }) } }),
  };
}

/** The parts DELETE /account needs; each is absent without its configuration (the route then answers 500). */
function accountDeletion(s3: S3Client): AccountDeletionConfig {
  const photos = s3PhotoDeletionStore(s3, process.env[ENV.photoBucket]);
  const deletionLog = s3DeletionLogStore(s3, process.env[ENV.deletionLogBucket]);
  const users = cognitoUserDirectory(new CognitoIdentityProviderClient({}), process.env[ENV.userPoolId]);
  return {
    ...(photos === undefined ? {} : { photos }),
    ...(deletionLog === undefined ? {} : { deletionLog }),
    ...(users === undefined ? {} : { users }),
  };
}

function build(): typeof api {
  const tableName = process.env[ENV.tableName] ?? '';
  if (tableName === '') return undefined;
  const s3 = new S3Client({});
  return createApi({
    store: new Repository({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName }),
    cursorSigner: cursorSignerFromParameterStore(process.env[ENV.cursorKeyParameter], new SSMClient({})),
    openFoodFacts: {
      client: createOpenFoodFactsClient({ contact: process.env[ENV.openFoodFactsContact] }),
      dailyCap: lookupCapFromEnv(process.env[ENV.openFoodFactsLookupCap]),
    },
    ...optionalImages(s3),
    accountDeletion: accountDeletion(s3),
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
