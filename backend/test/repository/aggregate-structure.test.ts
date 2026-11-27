// Structural tests (M3-T7, ADR 0035 points 10 and 11, ADR 0034): the 5-rater
// threshold holds because there is one read path, and that is checked on the
// source text, so a new reader of aggregate keys fails a test before it ships.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name))
    .sort();
}

const rel = (file: string): string => relative(SRC, file).split(sep).join('/');
const read = (file: string): string => readFileSync(file, 'utf8');

/** Anything that names an aggregate or ranking key, builder, parser or the read function. */
const AGGREGATE_KEYS = /AGG#|RANK#|aggregateAllKey|aggregateMethodKey|rankingKey|PREFIX\.(aggregate|aggregateMethod|ranking)\b|SORT_KEY\.aggregateAll|parseRankingPk|parseAggregateSortKey|aggregate-read|aggregate-write|existing-aggregates/;

describe('one read path for aggregates', () => {
  const all = sourceFiles(SRC);

  it('(a) no file outside src/repository and src/aggregation mentions the aggregate or ranking key builders', () => {
    const outside = all.filter((f) => !rel(f).startsWith('repository/') && !rel(f).startsWith('aggregation/'));
    expect(outside.length).toBeGreaterThan(10);
    const offenders = outside.filter((f) => AGGREGATE_KEYS.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('(a) the repository index does not export the key builders or parsers of aggregates (they are reached through the store only)', () => {
    // keys.ts is `export *`ed; the builders are in it by design (the same as every other key). What must not leak is anything that returns data.
    const index = read(join(SRC, 'repository', 'index.ts'));
    expect(index).not.toMatch(/export \{[^}]*\bserveFrom\b/);
    expect(index).not.toMatch(/export \{[^}]*\breadAggregate\b/);
    expect(index).not.toMatch(/aggregate-schemas|decodeStored/);
  });

  it('(b) within the repository, only aggregate-read.ts reads an aggregate item (GetItem or Query of aggregate keys)', () => {
    const files = all.filter((f) => rel(f).startsWith('repository/'));
    const readers = files
      .filter((f) => {
        const text = read(f);
        return /\b(GetCommand|QueryCommand|BatchGetCommand|TransactGetCommand)\b/.test(text) && /aggregateAllKey|aggregateMethodKey|AGG#/.test(text);
      })
      .map(rel);
    expect(readers).toEqual(['repository/aggregate-read.ts']);
  });

  it('(b) the Scan reader and the writer have no way to read one aggregate by key, and the class that holds the Scan result keeps it private', () => {
    for (const name of ['scan.ts', 'aggregate-write.ts', 'existing-aggregates.ts']) {
      expect(read(join(SRC, 'repository', name)), name).not.toMatch(/\b(GetCommand|QueryCommand|BatchGetCommand|TransactGetCommand)\b/);
    }
    const existing = read(join(SRC, 'repository', 'existing-aggregates.ts'));
    expect(existing).toMatch(/#aggregates/);
    expect(existing).not.toMatch(/\bget (aggregates|rankings|items)\b/);
    // Nothing in repository/ except aggregate-read.ts (and the schema decoder, which index.ts does not export) hands a decoded aggregate item to a caller.
    const exported = all
      .filter((f) => rel(f).startsWith('repository/') && rel(f) !== 'repository/aggregate-read.ts' && rel(f) !== 'repository/aggregate-schemas.ts')
      .filter((f) => /export (async )?function [a-zA-Z]+\([^)]*\)[^{]*: (Promise<)?(readonly )?(AggregateItem|ServedAggregate|AggregateRead)/.test(read(f)))
      .map(rel);
    expect(exported).toEqual([]);
  });

  it('(b) only aggregate-repository.ts imports aggregate-read.ts and its free function (callers use the repository method)', () => {
    const importers = all.filter((f) => /^(import|export) (?!type\b)[^;]*from '[^']*aggregate-read(\.ts)?'/m.test(read(f))).map(rel);
    expect(importers).toEqual(['repository/aggregate-repository.ts']);
    const defined = all.filter((f) => /export async function readAggregate\b/.test(read(f))).map(rel);
    expect(defined).toEqual(['repository/aggregate-read.ts']);
  });

  it('keys.ts has no rater marker', () => {
    const keys = read(join(SRC, 'repository', 'keys.ts'));
    expect(keys).not.toMatch(/RATER#|raterMarkerKey|rater:/);
    expect(keys).not.toMatch(/written by the aggregator/);
  });

  it('the origin ranking facet is in keys.ts', () => {
    expect(read(join(SRC, 'repository', 'keys.ts'))).toContain("`${tag}#${parsed.data}`");
    expect(read(join(SRC, 'repository', 'keys.ts'))).toContain("pick(OriginSchema, 'ORIGIN')");
  });
});

describe('reference recipes are never read (ADR 0034, ADR 0035 point 11)', () => {
  const scope = [
    ...sourceFiles(join(SRC, 'aggregation')),
    ...['aggregate-read.ts', 'aggregate-write.ts', 'aggregate-repository.ts', 'aggregate-schemas.ts', 'existing-aggregates.ts', 'scan.ts'].map((n) => join(SRC, 'repository', n)),
    ...['nightly-aggregates.ts'].map((n) => join(SRC, 'handlers', n)).filter((f) => existsSync(f)),
  ];

  it('nothing under src/aggregation, the aggregate repository files or the job handler imports or reads contracts/reference', () => {
    expect(scope.length).toBeGreaterThan(15);
    for (const file of scope) {
      const text = read(file)
        // Comments may name the rule; code may not use the path.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text, rel(file)).not.toMatch(/contracts\/reference|\/reference\/|recipes\.v1|readFile|readdir|node:fs|require\(/);
      for (const match of text.matchAll(/from '([^']+)'/g)) {
        expect(match[1], rel(file)).not.toMatch(/reference/);
      }
    }
  });

  it('no generated module that the aggregation code imports holds reference recipes', () => {
    for (const name of readdirSync(join(SRC, 'generated'))) {
      expect(read(join(SRC, 'generated', name)), name).not.toMatch(/reference recipe|recipes\.v1|contracts\/reference/i);
    }
  });
});
