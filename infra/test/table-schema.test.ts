// The backend's repository (backend/src/repository/table.ts) and its DynamoDB Local
// integration tests use one definition of the table's keys, index and stream.
// This test fails if the synthesised table drifts from it (M1-T3).
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { REVIEW_QUEUE_INDEX as BACKEND_INDEX, TABLE_ATTRIBUTES, tableKeySchema } from '../../backend/src/repository/table.ts';
import { STAGES } from '../src/config.ts';
import { REVIEW_QUEUE_INDEX, TABLE_KEYS } from '../src/data.ts';
import { testApp } from './helpers.ts';

function byName<T extends { AttributeName: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));
}

describe('table schema shared with the backend', () => {
  it('names the same attributes and index as infra/src/data.ts', () => {
    expect(TABLE_ATTRIBUTES).toEqual(TABLE_KEYS);
    expect({ indexName: BACKEND_INDEX.indexName, partitionKey: BACKEND_INDEX.partitionKey, sortKey: BACKEND_INDEX.sortKey }).toEqual(
      REVIEW_QUEUE_INDEX,
    );
  });

  it.each(STAGES)('matches the synthesised table of %s', (stage) => {
    const { stages } = testApp({ context: { stage } });
    const core = stages[0]?.core;
    if (core === undefined) throw new Error(`stage ${stage} missing`);
    const tables = Object.values(Template.fromStack(core).findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(1);
    const props = (tables[0] as { Properties: Record<string, unknown> }).Properties;
    const expected = tableKeySchema();

    expect(props.KeySchema).toEqual(expected.KeySchema);
    expect(byName(props.AttributeDefinitions as { AttributeName: string }[])).toEqual(byName(expected.AttributeDefinitions));
    expect(props.GlobalSecondaryIndexes).toEqual(expected.GlobalSecondaryIndexes);
    expect(props.StreamSpecification).toEqual(expected.StreamSpecification);
  });
});
