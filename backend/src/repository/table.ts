// The key schema of the table `cupmark-<stage>-main`, in the shape both the
// DynamoDB API (CreateTable) and CloudFormation (AWS::DynamoDB::Table) use.
//
// This file has no imports on purpose: infra/test/table-schema.test.ts imports
// it and checks that the synthesised CDK template has exactly these keys, this
// index and this stream view, and the integration tests create their DynamoDB
// Local table from it. So the backend, its tests and the deployed table cannot
// drift apart.

export const TABLE_ATTRIBUTES = {
  partitionKey: 'pk',
  sortKey: 'sk',
} as const;

/** The sparse review-queue index (infra/README.md, Index `gsi1`). */
export const REVIEW_QUEUE_INDEX = {
  indexName: 'gsi1',
  partitionKey: 'gsi1pk',
  sortKey: 'gsi1sk',
  projectionType: 'ALL',
} as const;

export const STREAM_VIEW_TYPE = 'NEW_AND_OLD_IMAGES';

export interface KeySchemaElement {
  readonly AttributeName: string;
  readonly KeyType: 'HASH' | 'RANGE';
}

export interface TableKeySchema {
  readonly KeySchema: readonly KeySchemaElement[];
  readonly AttributeDefinitions: readonly { readonly AttributeName: string; readonly AttributeType: 'S' }[];
  readonly GlobalSecondaryIndexes: readonly {
    readonly IndexName: string;
    readonly KeySchema: readonly KeySchemaElement[];
    readonly Projection: { readonly ProjectionType: 'ALL' };
  }[];
  readonly StreamSpecification: { readonly StreamViewType: typeof STREAM_VIEW_TYPE };
}

/** Keys, attribute definitions, index and stream of the table. */
export function tableKeySchema(): TableKeySchema {
  return {
    KeySchema: [
      { AttributeName: TABLE_ATTRIBUTES.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE_ATTRIBUTES.sortKey, KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: TABLE_ATTRIBUTES.partitionKey, AttributeType: 'S' },
      { AttributeName: TABLE_ATTRIBUTES.sortKey, AttributeType: 'S' },
      { AttributeName: REVIEW_QUEUE_INDEX.partitionKey, AttributeType: 'S' },
      { AttributeName: REVIEW_QUEUE_INDEX.sortKey, AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: REVIEW_QUEUE_INDEX.indexName,
        KeySchema: [
          { AttributeName: REVIEW_QUEUE_INDEX.partitionKey, KeyType: 'HASH' },
          { AttributeName: REVIEW_QUEUE_INDEX.sortKey, KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: REVIEW_QUEUE_INDEX.projectionType },
      },
    ],
    StreamSpecification: { StreamViewType: STREAM_VIEW_TYPE },
  };
}
