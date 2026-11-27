// Shared by the replay and load tests of the nightly rebuild (M3-T10): the
// stated limits, the measuring client, one run of the real nightly handler, the
// fixed measurement line and the expected result from the oracle.
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import type { RebuildInput, RebuildResult } from '../../src/aggregation/rebuild/types.ts';
import { createNightlyHandler } from '../../src/handlers/nightly-aggregates.ts';
import { PREFIX } from '../../src/repository/keys.ts';
import { canonical } from '../../src/repository/aggregate-schemas.ts';
import { AggregateRepository } from '../../src/repository/index.ts';
import { analyse } from '../aggregation/support/oracle.ts';
import { Rng } from '../aggregation/support/rng.ts';
import { RUN_MS, storedAggregate, storedRanking } from '../repository/aggregate-fixtures.ts';
import type { Item } from '../repository/fake-table.ts';

// ---- the stated limits (a test fails above them) ----

/** The Lambda timeout of the job (infra/src/config.ts, M3-T9), milliseconds. */
export const LAMBDA_TIMEOUT_MS = 300_000;
/** The Lambda memory of the job, megabytes. The test runs with a V8 old space of this size. */
export const LAMBDA_MEMORY_MB = 512;
/** Time budget of the full job on the CI runner (M3-T10): five times inside the timeout. */
export const FULL_RUN_BUDGET_MS = 60_000;
/** ADR 0035 scale trigger: a run above this share of the timeout needs a new ADR. */
export const TIMEOUT_SHARE_TRIGGER = 0.5;
/** ADR 0035 scale trigger: a peak heap above this share of the memory needs a new ADR. */
export const HEAP_SHARE_TRIGGER = 0.6;
/** The scan page at which the injected failure happens. */
export const FAILING_PAGE = 40;

const MB = 1024 * 1024;

export function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

const heapUsed = (): number => process.memoryUsage().heapUsed;

export interface Stats {
  scanPages: number;
  writeRequests: number;
  peakHeapBytes: number;
}

export interface ProbeOptions {
  /** Shuffle the items inside every Scan page with this seed (the scan then hands the rebuild another order). */
  readonly shuffleSeed?: number;
  /** Throw on this (1-based) Scan page. */
  readonly failOnScanPage?: number;
}

/** Wraps a client: counts scan pages and write requests, samples the heap after every request. */
export function probe(inner: DynamoDBDocumentClient, options: ProbeOptions = {}): { client: DynamoDBDocumentClient; stats: Stats } {
  const stats: Stats = { scanPages: 0, writeRequests: 0, peakHeapBytes: heapUsed() };
  const rng = options.shuffleSeed === undefined ? undefined : new Rng(options.shuffleSeed);
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ScanCommand) {
      stats.scanPages += 1;
      if (stats.scanPages === options.failOnScanPage) throw new Error('injected scan failure');
    }
    if (command instanceof BatchWriteCommand) {
      stats.writeRequests += Object.values(command.input.RequestItems ?? {}).reduce((sum, list) => sum + list.length, 0);
    }
    const result = (await inner.send(command as never)) as { Items?: Item[] };
    if (rng !== undefined && command instanceof ScanCommand && result.Items !== undefined) result.Items = rng.shuffle(result.Items);
    stats.peakHeapBytes = Math.max(stats.peakHeapBytes, heapUsed());
    return result;
  };
  return { client: { send } as unknown as DynamoDBDocumentClient, stats };
}

export interface RunReport {
  /** The handler's own log line, parsed. */
  readonly log: Record<string, unknown>;
  readonly logLine: string;
  readonly stats: Stats;
  readonly durationMs: number;
  readonly baselineHeapBytes: number;
  readonly failed: boolean;
}

/** One run of the real nightly handler (real repository, real rebuild) on `client`. Never throws: a failure is in `failed`. */
export async function runHandler(client: DynamoDBDocumentClient, tableName: string, options: ProbeOptions & { scanPageSize?: number } = {}): Promise<RunReport> {
  const probed = probe(client, options);
  const lines: string[] = [];
  const repository = new AggregateRepository({
    client: probed.client,
    tableName,
    sleep: () => Promise.resolve(),
    ...(options.scanPageSize === undefined ? {} : { scanPageSize: options.scanPageSize }),
  });
  const handler = createNightlyHandler({
    store: repository,
    now: () => RUN_MS,
    log: (line) => lines.push(line),
    rebuild: (input: RebuildInput): RebuildResult => {
      probed.stats.peakHeapBytes = Math.max(probed.stats.peakHeapBytes, heapUsed());
      const result = rebuild(input);
      probed.stats.peakHeapBytes = Math.max(probed.stats.peakHeapBytes, heapUsed());
      return result;
    },
  });
  collectGarbage();
  const baselineHeapBytes = heapUsed();
  probed.stats.peakHeapBytes = baselineHeapBytes;
  const started = performance.now();
  let failed = false;
  try {
    await handler({}, { getRemainingTimeInMillis: () => LAMBDA_TIMEOUT_MS - (performance.now() - started) });
  } catch {
    failed = true;
  }
  const durationMs = performance.now() - started;
  const logLine = lines[0] ?? '{}';
  return { log: JSON.parse(logLine) as Record<string, unknown>, logLine, stats: probed.stats, durationMs, baselineHeapBytes, failed };
}

/**
 * The one-line measurement, fixed keys in a fixed order, to compare with the
 * Lambda run log of M3-T15 (that log line has duration_ms, share_of_timeout, items_scanned,
 * items_written, items_deleted under the same names).
 */
export function measurementLine(target: string, label: string, report: RunReport): string {
  const log = report.log;
  const share = report.durationMs / LAMBDA_TIMEOUT_MS;
  const peakMb = report.stats.peakHeapBytes / MB;
  const parts: [string, string | number][] = [
    ['target', target],
    ['run', label],
    ['items_scanned', Number(log.items_scanned ?? 0)],
    ['scan_pages', report.stats.scanPages],
    ['brews_seen', Number(log.brews_seen ?? 0)],
    ['brews_counted', Number(log.brews_counted ?? 0)],
    ['duration_ms', Math.round(report.durationMs)],
    ['timeout_ms', LAMBDA_TIMEOUT_MS],
    ['share_of_timeout', share.toFixed(3)],
    ['peak_heap_mb', peakMb.toFixed(1)],
    ['heap_baseline_mb', (report.baselineHeapBytes / MB).toFixed(1)],
    ['memory_mb', LAMBDA_MEMORY_MB],
    ['heap_share', (peakMb / LAMBDA_MEMORY_MB).toFixed(3)],
    ['write_requests', report.stats.writeRequests],
    ['items_written', Number(log.items_written ?? 0)],
    ['items_deleted', Number(log.items_deleted ?? 0)],
  ];
  return `REPLAY_MEASURE ${parts.map(([key, value]) => `${key}=${String(value)}`).join(' ')}`;
}

export function printMeasurement(target: string, label: string, report: RunReport): void {
  process.stdout.write(`${measurementLine(target, label, report)}\n`);
  process.stdout.write(`REPLAY_HANDLER_LOG ${report.logLine}\n`);
}

// ---- comparing tables ----

export const isAggregateKey = (item: Item): boolean =>
  (String(item.pk).startsWith(PREFIX.bean) && String(item.sk).startsWith(PREFIX.aggregate)) || String(item.pk).startsWith(PREFIX.ranking);

/** Every item as canonical text, in key order: two tables are the same when these are the same string. */
export function dump(items: Iterable<Item>, only: (item: Item) => boolean = () => true): string {
  return [...items]
    .filter(only)
    .map((item) => canonical(item))
    .sort()
    .join('\n');
}

/** What the oracle says the table must hold afterwards, as stored items. */
export function expectedDump(input: RebuildInput): { text: string; result: RebuildResult } {
  const { result } = analyse(input);
  const items: Item[] = [...result.aggregates.map((a) => storedAggregate(a)), ...result.rankings.map((r) => storedRanking(r))];
  return { text: dump(items), result };
}
