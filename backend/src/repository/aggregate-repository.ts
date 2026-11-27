// The aggregation side of the repository (ADR 0035, M3-T7): the nightly Scan,
// the write of the rebuild's result, and `readAggregate`, the one function that
// returns aggregate data. A class of its own so `Repository` never touches
// aggregate keys.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AggregateItem, RankingItem } from '../aggregation/rebuild/types.ts';
import type { Method } from '../generated/contract.ts';
import { readAggregate } from './aggregate-read.ts';
import type { AggregateRead } from './aggregate-read.ts';
import { replaceAggregates } from './aggregate-write.ts';
import type { WriteReport } from './aggregate-write.ts';
import { InvalidValuesError } from './errors.ts';
import type { ExistingAggregates } from './existing-aggregates.ts';
import { scanForRebuild } from './scan.ts';
import type { RebuildScan } from './scan.ts';

export interface AggregateRepositoryOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Clock for `readAggregate`, for tests. */
  readonly now?: () => Date;
  /** Wait before retrying unprocessed writes, for tests. Default: setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Items per Scan page; default SCAN_PAGE_SIZE. For tests that need several pages. */
  readonly scanPageSize?: number;
}

export class AggregateRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pageSize: number | undefined;

  public constructor(options: AggregateRepositoryOptions) {
    if (options.tableName === '') throw new InvalidValuesError('a table name is required');
    this.#client = options.client;
    this.#table = options.tableName;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pageSize = options.scanPageSize;
  }

  /** The whole table in pages. Throws on any failure, and returns nothing then (ADR 0035 point 7). */
  public scanForRebuild(): Promise<RebuildScan> {
    return scanForRebuild(this.#client, this.#table, this.#pageSize);
  }

  /**
   * Writes the rebuilt set and deletes what it no longer contains. `existing` is
   * the one the same run's scan returned; `runDay` is the UTC day of the run.
   */
  public replaceAggregates(
    next: { readonly aggregates: readonly AggregateItem[]; readonly rankings: readonly RankingItem[] },
    existing: ExistingAggregates,
    runDay: string,
  ): Promise<WriteReport> {
    return replaceAggregates(this.#client, this.#table, this.#sleep, existing, next, runDay);
  }

  /** The only function that returns aggregate data: behind the 5-rater threshold and the age limit. */
  public readAggregate(beanId: string, method?: Method): Promise<AggregateRead> {
    return readAggregate(this.#client, this.#table, this.#now(), beanId, method);
  }
}
