// The write of the nightly rebuild (ADR 0035 point 8, M3-T7): new or changed
// items first, then the deletes of what the new set no longer contains.
//
// Not one transaction (a table-wide set is far over the 100-item limit). A
// failure part way throws and the next night repairs it. What a reader may see
// in between: each item is one whole, self-consistent item (one put or one
// delete), the old and the new set side by side, and `readAggregate` applies
// the threshold to each item by itself. Withdrawn contributions are gone at the
// next successful run, or by the age limit if runs keep failing.
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AggregateItem, RankingItem } from '../aggregation/rebuild/types.ts';
import { AggregateWriteIncompleteError } from './errors.ts';
import type { ExistingAggregates, PutItem, WritePlan } from './existing-aggregates.ts';
import type { Key } from './keys.ts';

/** BatchWriteItem takes at most 25 requests. */
export const AGGREGATE_BATCH_SIZE = 25;
/** Batches in flight at once. */
export const AGGREGATE_BATCH_CONCURRENCY = 8;
/** Attempts of one batch, the first included, before unprocessed requests fail the run. */
export const AGGREGATE_BATCH_ATTEMPTS = 8;

export interface WriteReport {
  readonly written: number;
  readonly deleted: number;
  readonly unchangedAggregates: number;
  readonly unchangedRankings: number;
}

type WriteRequest = { PutRequest: { Item: PutItem } } | { DeleteRequest: { Key: Key } };

async function sendBatch(client: DynamoDBDocumentClient, table: string, sleep: (ms: number) => Promise<void>, batch: readonly WriteRequest[]): Promise<void> {
  let requests = batch;
  for (let attempt = 1; requests.length > 0; attempt += 1) {
    if (attempt > AGGREGATE_BATCH_ATTEMPTS) throw new AggregateWriteIncompleteError('aggregate writes are left after retries');
    if (attempt > 1) await sleep(Math.min(1000, 25 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
    const result = await client.send(new BatchWriteCommand({ RequestItems: { [table]: [...requests] } }));
    requests = (result.UnprocessedItems?.[table] ?? []) as WriteRequest[];
  }
}

/** Runs the batches with a bounded number in flight; the first failure stops new ones and is thrown. */
async function sendAll(client: DynamoDBDocumentClient, table: string, sleep: (ms: number) => Promise<void>, requests: readonly WriteRequest[]): Promise<void> {
  const batches: WriteRequest[][] = [];
  for (let index = 0; index < requests.length; index += AGGREGATE_BATCH_SIZE) batches.push(requests.slice(index, index + AGGREGATE_BATCH_SIZE));
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < batches.length) {
      const batch = batches[next] ?? [];
      next += 1;
      try {
        await sendBatch(client, table, sleep, batch);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGGREGATE_BATCH_CONCURRENCY, batches.length) }, worker));
}

export async function replaceAggregates(
  client: DynamoDBDocumentClient,
  table: string,
  sleep: (ms: number) => Promise<void>,
  existing: ExistingAggregates,
  next: { readonly aggregates: readonly AggregateItem[]; readonly rankings: readonly RankingItem[] },
  runDay: string,
): Promise<WriteReport> {
  // The whole plan is made, and checked, before the first request.
  const plan: WritePlan = existing.plan(next, runDay);
  await sendAll(client, table, sleep, plan.puts.map((Item) => ({ PutRequest: { Item } })));
  await sendAll(client, table, sleep, plan.deletes.map((Key) => ({ DeleteRequest: { Key } })));
  return { written: plan.puts.length, deleted: plan.deletes.length, unchangedAggregates: plan.unchangedAggregates, unchangedRankings: plan.unchangedRankings };
}
