// An in-memory DynamoDB document client for the aggregate repository tests:
// Scan (Limit, ExclusiveStartKey, key order), BatchWriteItem (25 request limit,
// no repeated key in one batch, optional unprocessed items) and GetItem. Only
// these three commands exist; any other throws, so a test notices a new access
// pattern. Items are copied in and out, so nothing is shared by reference.
// DynamoDB Local runs the same scenarios in test/integration/aggregates.test.ts.
import { BatchWriteCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;

const order = (item: Item): string => `${String(item.pk)}\u0000${String(item.sk)}`;

export class FakeTable {
  public readonly items = new Map<string, Item>();
  public readonly scanLimits: (number | undefined)[] = [];
  public scanCalls = 0;
  public getCalls = 0;
  /** Put and delete requests that reached the table, in order. */
  public readonly writes: { op: 'put' | 'delete'; pk: string; sk: string }[] = [];
  public batchCalls = 0;
  /** Throws on this (1-based) Scan call. */
  public failScanOnCall: number | undefined;
  /** Throws on this (1-based) BatchWriteItem call. */
  public failBatchOnCall: number | undefined;
  /** For the first this-many BatchWriteItem calls, returns every request but the first as unprocessed. */
  public leaveUnprocessedCalls = 0;
  /** Always returns every request as unprocessed. */
  public neverProcess = false;

  public put(item: Item): this {
    this.items.set(order(item), structuredClone(item));
    return this;
  }

  public get(pk: string, sk: string): Item | undefined {
    const found = this.items.get(`${pk}\u0000${sk}`);
    return found === undefined ? undefined : structuredClone(found);
  }

  public keys(prefixPk?: string): string[] {
    return [...this.items.values()].filter((i) => prefixPk === undefined || String(i.pk).startsWith(prefixPk)).map((i) => `${String(i.pk)} | ${String(i.sk)}`).sort();
  }

  public get client(): DynamoDBDocumentClient {
    const send = (command: unknown): Promise<unknown> => {
      try {
        return Promise.resolve(this.#handle(command));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('fake table failure'));
      }
    };
    return { send } as unknown as DynamoDBDocumentClient;
  }

  #handle(command: unknown): unknown {
    if (command instanceof ScanCommand) {
      this.scanCalls += 1;
      if (this.failScanOnCall === this.scanCalls) throw new Error('injected scan failure');
      const { Limit, ExclusiveStartKey } = command.input;
      this.scanLimits.push(Limit);
      const all = [...this.items.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
      const after = ExclusiveStartKey === undefined ? -1 : all.findIndex((i) => order(i) === `${String(ExclusiveStartKey.pk)}\u0000${String(ExclusiveStartKey.sk)}`);
      const page = all.slice(after + 1, after + 1 + (Limit ?? all.length));
      const last = page[page.length - 1];
      const more = after + 1 + page.length < all.length;
      return { Items: page.map((i) => structuredClone(i)), ...(more && last !== undefined ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command instanceof GetCommand) {
      this.getCalls += 1;
      const { pk, sk } = command.input.Key ?? {};
      const found = this.get(String(pk), String(sk));
      return found === undefined ? {} : { Item: found };
    }
    if (command instanceof BatchWriteCommand) {
      this.batchCalls += 1;
      if (this.failBatchOnCall === this.batchCalls) throw new Error('injected batch failure');
      const requests = Object.entries(command.input.RequestItems ?? {}).flatMap(([table, list]) => list.map((request) => ({ table, request })));
      if (requests.length === 0 || requests.length > 25) throw new Error('a batch holds 1 to 25 requests');
      const seen = new Set<string>();
      for (const { request } of requests) {
        const key = request.PutRequest?.Item ?? request.DeleteRequest?.Key ?? {};
        const text = order(key as Item);
        if (seen.has(text)) throw new Error('a batch must not repeat a key');
        seen.add(text);
      }
      const unprocessed = this.neverProcess ? requests : this.batchCalls <= this.leaveUnprocessedCalls ? requests.slice(1) : [];
      const done = requests.filter((r) => !unprocessed.includes(r));
      for (const { request } of done) {
        const put = request.PutRequest?.Item;
        if (put !== undefined) {
          this.put(put);
          this.writes.push({ op: 'put', pk: String(put.pk), sk: String(put.sk) });
        } else if (request.DeleteRequest !== undefined) {
          const { pk, sk } = request.DeleteRequest.Key ?? {};
          this.items.delete(`${String(pk)}\u0000${String(sk)}`);
          this.writes.push({ op: 'delete', pk: String(pk), sk: String(sk) });
        }
      }
      const table = requests[0]?.table ?? '';
      return unprocessed.length === 0 ? {} : { UnprocessedItems: { [table]: unprocessed.map((u) => u.request) } };
    }
    throw new Error('the fake table does not implement this command');
  }
}
