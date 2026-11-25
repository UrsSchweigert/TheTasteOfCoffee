// The API Lambda (docs/05-system-design.md, Components: one API function).
// Serves the routes in src/api/router.ts. Configuration comes from the
// environment set by infra (src/api/config.ts); a missing table name fails
// every request with 500, a missing cursor key fails the list routes only, a
// missing Open Food Facts contact fails only lookups that would fetch (503), a
// missing photo bucket only stops image copies (hits without an image, and
// GET /catalogue_images is 404) and label photo uploads (both routes 500).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ENV, cursorSignerFromParameterStore, lookupCapFromEnv } from '../api/config.ts';
import { empty } from '../api/http.ts';
import { createApi } from '../api/router.ts';
import type { ApiDependencies } from '../api/router.ts';
import { s3CatalogueImageStore } from '../images/catalogue-store.ts';
import { s3LabelPhotoStore } from '../images/label-photo-store.ts';
import { createOpenFoodFactsClient } from '../openfoodfacts/client.ts';
import { Repository } from '../repository/index.ts';

let api: ((event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>) | undefined;

function optionalImages(): Pick<ApiDependencies, 'catalogueImages' | 'labelPhotos'> {
  const s3 = new S3Client({});
  const bucket = process.env[ENV.photoBucket];
  const catalogueImages = s3CatalogueImageStore(s3, bucket);
  const labelPhotos = s3LabelPhotoStore(s3, bucket);
  return {
    ...(catalogueImages === undefined ? {} : { catalogueImages }),
    ...(labelPhotos === undefined ? {} : { labelPhotos: { store: labelPhotos } }),
  };
}

function build(): typeof api {
  const tableName = process.env[ENV.tableName] ?? '';
  if (tableName === '') return undefined;
  return createApi({
    store: new Repository({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName }),
    cursorSigner: cursorSignerFromParameterStore(process.env[ENV.cursorKeyParameter], new SSMClient({})),
    openFoodFacts: {
      client: createOpenFoodFactsClient({ contact: process.env[ENV.openFoodFactsContact] }),
      dailyCap: lookupCapFromEnv(process.env[ENV.openFoodFactsLookupCap]),
    },
    ...optionalImages(),
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
