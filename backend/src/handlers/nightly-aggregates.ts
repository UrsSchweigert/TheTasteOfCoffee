// The nightly aggregates job (ADR 0035 points 6 to 8 and 13, M3-T8): Scan the
// table, rebuild every aggregate and ranking item from nothing, write the
// result. Entry point `handler` of `cupmark-<stage>-nightly-aggregates`
// (bundled to dist/nightly-aggregates/index.mjs, export `handler`).
//
// Fail closed: a failure in the scan, the rebuild or the write makes the
// handler throw, so the invocation is reported as failed (the alarms are
// infra, M3-T9). A scan or rebuild failure happens before any write, so
// nothing partial is written. The handler reads nothing from the event except
// the literal `dry_run: true`: it takes no user or bean selection.
//
// The wall clock is read exactly once (the run time passed to the core). The
// duration and the share of the timeout come from the Lambda context's
// remaining time, so no second clock read exists.
//
// One log line per run, fixed keys, numbers and fixed words only: no user id,
// bean id, error message or other text. No custom metrics (they bill per metric).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { utcDay } from '../aggregation/age.ts';
import { rebuild as rebuildAggregates } from '../aggregation/rebuild/rebuild.ts';
import type { AggregateItem, RankingItem, RebuildInput, RebuildResult } from '../aggregation/rebuild/types.ts';
import { REASON_IDS } from '../generated/aggregation.ts';
import { AggregateRepository } from '../repository/index.ts';
import type { ExistingAggregates, RebuildScan, WriteReport } from '../repository/index.ts';

/**
 * Attempts of the SDK client per request, the first included. The Scan is the
 * big read of the night and the table is on demand: a throttled page is
 * retried by the client (the SDK default of 3 is too few for a whole-table
 * Scan). A page that still fails fails the run (ADR 0035 point 7).
 */
export const SDK_MAX_ATTEMPTS = 10;

/** Environment variable with the table name (the same name as ENV.tableName of the API; not imported, since src/api/config.ts pulls the SSM client into this bundle). */
const TABLE_NAME_VARIABLE = 'TABLE_NAME';

/** The SDK client of the job, with the retry attempts for throttled Scan pages. */
export function newDynamoClient(): DynamoDBClient {
  return new DynamoDBClient({ maxAttempts: SDK_MAX_ATTEMPTS });
}

/** What the job needs from the aggregate repository (the real `AggregateRepository` fits). */
export interface NightlyStore {
  scanForRebuild(): Promise<RebuildScan>;
  replaceAggregates(
    next: { readonly aggregates: readonly AggregateItem[]; readonly rankings: readonly RankingItem[] },
    existing: ExistingAggregates,
    runDay: string,
  ): Promise<WriteReport>;
}

export interface NightlyDependencies {
  readonly store: NightlyStore;
  /** The run's single wall-clock read, epoch milliseconds. */
  readonly now: () => number;
  /** Receives the one JSON log line of the run. */
  readonly log: (line: string) => void;
  /** The rebuild core; replaceable for tests. */
  readonly rebuild?: (input: RebuildInput) => RebuildResult;
}

/** The part of the Lambda context the job uses. */
export interface NightlyContext {
  getRemainingTimeInMillis(): number;
}

type Stage = 'scan' | 'rebuild' | 'write';

/** True only for the literal `{ "dry_run": true }`; nothing else in the event is read. */
function isDryRun(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { dry_run?: unknown }).dry_run === true;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The error's class name when it is a plain identifier, else a fixed word. Never the message. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error';
}

export function createNightlyHandler(deps: NightlyDependencies): (event: unknown, context: NightlyContext) => Promise<void> {
  const rebuild = deps.rebuild ?? rebuildAggregates;

  return async (event, context) => {
    const dryRun = isDryRun(event);
    const startRemainingMs = context.getRemainingTimeInMillis();
    const runTimeMs = deps.now();
    let stage: Stage = 'scan';

    /** One read of the remaining time gives both numbers, so they always agree. */
    const timing = (): { duration_ms: number; share_of_timeout: number } => {
      const duration = Math.max(0, startRemainingMs - context.getRemainingTimeInMillis());
      return { duration_ms: duration, share_of_timeout: startRemainingMs > 0 ? round3(duration / startRemainingMs) : 0 };
    };

    try {
      const scan = await deps.store.scanForRebuild();
      stage = 'rebuild';
      const result = rebuild({
        brews: scan.brews,
        shelfEntries: scan.shelfEntries,
        beans: scan.beans,
        consentByUser: scan.consentByUser,
        runTimeMs,
      });
      stage = 'write';
      const report = dryRun ? undefined : await deps.store.replaceAggregates(result, scan.existing, utcDay(runTimeMs));

      const reasons = Object.fromEntries(REASON_IDS.map((id) => [id, result.counts.reasons[id]]));
      deps.log(
        JSON.stringify({
          operation: 'nightly-aggregates',
          status: 'OK',
          dry_run: dryRun,
          ...timing(),
          items_scanned: scan.itemsScanned,
          users_seen: result.counts.users_seen,
          brews_seen: result.counts.brews_seen,
          brews_counted: result.counts.brews_counted,
          brews_orphaned: result.counts.brews_orphaned,
          reasons,
          beans_with_aggregates: result.counts.beans_with_aggregates,
          beans_ranked: result.counts.beans_ranked,
          items_written: report?.written ?? 0,
          items_deleted: report?.deleted ?? 0,
        }),
      );
    } catch (error) {
      deps.log(
        JSON.stringify({
          operation: 'nightly-aggregates',
          status: 'FAILED',
          dry_run: dryRun,
          stage,
          error: errorName(error),
          ...timing(),
        }),
      );
      // The Lambda runtime also logs the error's own message and stack. So error
      // messages in the repository and arithmetic code must stay fixed text
      // without values (see src/repository/errors.ts).
      throw error;
    }
  };
}

let configured: ((event: unknown, context: NightlyContext) => Promise<void>) | undefined;

export async function handler(event: unknown, context: NightlyContext): Promise<void> {
  if (configured === undefined) {
    const tableName = process.env[TABLE_NAME_VARIABLE] ?? '';
    if (tableName === '') {
      console.log(JSON.stringify({ operation: 'nightly-aggregates', status: 'FAILED', stage: 'configuration', error: 'TableNameMissing' }));
      throw new Error('TABLE_NAME is not set');
    }
    const client = DynamoDBDocumentClient.from(newDynamoClient());
    configured = createNightlyHandler({
      store: new AggregateRepository({ client, tableName }),
      now: () => Date.now(),
      log: (line) => {
        console.log(line);
      },
    });
  }
  await configured(event, context);
}
