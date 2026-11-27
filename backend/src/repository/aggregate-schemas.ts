// The stored shapes of aggregate and ranking items (contracts/README.md,
// Aggregate item shapes), as zod schemas built from the generated contract
// types. Used to check what the rebuild hands over before it is written, and to
// decode what the Scan and the read find. No key is built or read here.
import { z } from 'zod';
import { HISTOGRAM_PARAMETER_IDS } from '../generated/aggregation.ts';
import { CalendarDateSchema, FlavourNoteSchema, IdSchema, IntensitiesSchema, IntensityLevelSchema, MethodSchema, ScoresSchema } from '../generated/contract.ts';
import { BUCKET_IDS } from '../aggregation/rebuild/buckets.ts';
import type { AggregateItem } from '../aggregation/rebuild/types.ts';

/** `type` attribute of the two stored item kinds, as ITEM_TYPE does for the others. */
export const AGGREGATE_ITEM_TYPE = 'AGGREGATE';
export const RANKING_ITEM_TYPE = 'RANKING';

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Criterion = ScoresSchema.keyof();
const Dimension = IntensitiesSchema.keyof();
const Parameter = z.enum(HISTOGRAM_PARAMETER_IDS);

const CriterionTotals = z.strictObject({ weighted_count: Count, sum: Count, sum_of_squares: Count });

/** Everything of an aggregate item except its key attributes. */
export const AggregateBody = z
  .strictObject({
    kind: z.enum(['all', 'method']),
    bean_id: IdSchema,
    method: MethodSchema.optional(),
    run_day: CalendarDateSchema,
    weight_denominator: Count,
    raters: Count,
    criteria: z.record(Criterion, CriterionTotals),
    intensities: z.partialRecord(Dimension, z.partialRecord(IntensityLevelSchema, Count)),
    notes: z.partialRecord(FlavourNoteSchema, Count),
    buy_again: z.strictObject({ yes: Count, no: Count }),
    histograms: z.partialRecord(Parameter, z.record(z.string(), Count)),
    raters_by_part: z.strictObject({
      buy_again: Count,
      notes: Count,
      intensities: z.partialRecord(Dimension, Count),
      histograms: z.partialRecord(Parameter, Count),
    }),
  })
  .superRefine((item, context) => {
    if ((item.kind === 'method') !== (item.method !== undefined)) context.addIssue({ code: 'custom', message: 'method is present exactly when kind is method' });
    for (const parameter of HISTOGRAM_PARAMETER_IDS) {
      const buckets = item.histograms[parameter];
      if (buckets === undefined) continue;
      const allowed = new Set(BUCKET_IDS[parameter]);
      for (const key of Object.keys(buckets)) if (!allowed.has(key)) context.addIssue({ code: 'custom', message: 'bucket id of another parameter' });
    }
  });

const KeyAttributes = z.object({ pk: z.string(), sk: z.string() });

const StoredAggregate = KeyAttributes.extend({ type: z.literal(AGGREGATE_ITEM_TYPE) }).loose();
export const RankingBody = z.strictObject({ bean_ids: z.array(IdSchema), run_day: CalendarDateSchema });
const StoredRanking = KeyAttributes.extend({ type: z.literal(RANKING_ITEM_TYPE) }).loose();

export type RankingBodyValue = z.infer<typeof RankingBody>;

/** The contract attributes of a stored item: everything but `pk`, `sk` and `type`. */
function withoutKeyAttributes(item: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...item };
  delete rest.pk;
  delete rest.sk;
  delete rest.type;
  return rest;
}

/** Parses an aggregate body; the result has no `method` key at all when the item has none (exactOptionalPropertyTypes). */
export function parseAggregateBody(value: unknown): AggregateItem | undefined {
  const parsed = AggregateBody.safeParse(value);
  if (!parsed.success) return undefined;
  const { method, ...rest } = parsed.data;
  return method === undefined ? rest : { ...rest, method };
}

/** The aggregate a stored item holds, split from its key and type attributes, or undefined if it does not decode. */
export function decodeStoredAggregate(item: unknown): { readonly pk: string; readonly sk: string; readonly body: AggregateItem } | undefined {
  const parsed = StoredAggregate.safeParse(item);
  if (!parsed.success) return undefined;
  const { pk, sk } = parsed.data;
  const body = parseAggregateBody(withoutKeyAttributes(parsed.data));
  return body === undefined ? undefined : { pk, sk, body };
}

export function decodeStoredRanking(item: unknown): { readonly pk: string; readonly sk: string; readonly body: RankingBodyValue } | undefined {
  const parsed = StoredRanking.safeParse(item);
  if (!parsed.success) return undefined;
  const { pk, sk } = parsed.data;
  const body = RankingBody.safeParse(withoutKeyAttributes(parsed.data));
  return body.success ? { pk, sk, body: body.data } : undefined;
}

/** Key order independent text of a value: two items are equal when this is. Maps come back from DynamoDB in any order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
