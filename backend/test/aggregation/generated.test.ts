import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AggregationGenerationError, generateAggregationSource } from '../../scripts/codegen/aggregation.ts';
import { AGGREGATION_DIR, GENERATED_AGGREGATION_FILE, generateAggregationFromContract } from '../../scripts/codegen/paths.ts';
import { AGGREGATION_CONTRACT_VERSION, HISTOGRAM_PARAMETERS, HISTOGRAM_PARAMETER_IDS, REASON_IDS } from '../../src/generated/aggregation.ts';

function json(name: string): { version: number; reasons?: { id: string }[]; parameters?: Record<string, { scale: number; sets: { id: string; methods: string[]; buckets: { id: string; from: number; to: number }[] }[] }> } {
  return JSON.parse(readFileSync(join(AGGREGATION_DIR, name), 'utf8')) as never;
}

describe('src/generated/aggregation.ts (M3-T3: generated, not read at run time)', () => {
  it('is what the generator makes from contracts/aggregation/v1', () => {
    const committed = readFileSync(GENERATED_AGGREGATION_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === generateAggregationFromContract(), 'run `npm run generate` and commit the result').toBe(true);
  });

  it('has the reason ids of reasons.json in rule order', () => {
    expect([...REASON_IDS]).toEqual((json('reasons.json').reasons ?? []).map((r) => r.id));
    expect(REASON_IDS).toHaveLength(8);
    expect(AGGREGATION_CONTRACT_VERSION).toBe(1);
  });

  it('has every set and bucket of histogram_buckets.json, edges unchanged', () => {
    const file = json('histogram_buckets.json').parameters ?? {};
    expect([...HISTOGRAM_PARAMETER_IDS]).toEqual(Object.keys(file));
    for (const id of HISTOGRAM_PARAMETER_IDS) {
      const generated = HISTOGRAM_PARAMETERS[id];
      const source = file[id];
      expect(generated.scale).toBe(source?.scale);
      expect(generated.sets.map((s) => ({ id: s.id, methods: [...s.methods], buckets: s.buckets.map((b) => ({ ...b })) }))).toEqual(source?.sets);
    }
  });
});

describe('aggregation generator', () => {
  const reasons = { version: 1, reasons: [{ id: 'a' }, { id: 'b' }] };
  const buckets = { version: 1, vocabulary_version: 3, parameters: { p: { source_fields: ['x'], scale: 1, sets: [{ id: 's', methods: ['m'], buckets: [{ id: 'p_s_from_0', from: 0, to: 5 }] }] } } };

  it('generates from a small valid input', () => {
    const source = generateAggregationSource(reasons, buckets);
    expect(source).toContain("'a',\n  'b',\n] as const;");
    expect(source).toContain("{ id: 'p_s_from_0', from: 0, to: 5 }");
  });

  it.each([
    ['a repeated reason id', { ...reasons, reasons: [{ id: 'a' }, { id: 'a' }] }, buckets],
    ['a reason id that is not an id', { ...reasons, reasons: [{ id: "a'];" }] }, buckets],
    ['no reasons', { ...reasons, reasons: [] }, buckets],
    ['different versions', reasons, { ...buckets, version: 2 }],
    ['a fractional edge', reasons, { ...buckets, parameters: { p: { source_fields: ['x'], scale: 1, sets: [{ id: 's', methods: ['m'], buckets: [{ id: 'p_s_from_0', from: 0.5, to: 5 }] }] } } }],
    ['a repeated bucket id', reasons, { ...buckets, parameters: { p: { source_fields: ['x'], scale: 1, sets: [{ id: 's', methods: ['m'], buckets: [{ id: 'q', from: 0, to: 5 }, { id: 'q', from: 5, to: 9 }] }] } } }],
  ])('fails on %s', (_name, r, b) => {
    expect(() => generateAggregationSource(r, b)).toThrow(AggregationGenerationError);
  });
});
