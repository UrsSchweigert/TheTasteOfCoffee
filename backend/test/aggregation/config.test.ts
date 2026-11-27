import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKEND_DIR } from '../../scripts/codegen/paths.ts';
import * as config from '../../src/aggregation/config.ts';

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

describe('rebuild configuration (ADR 0035)', () => {
  it('holds the starting values of the ADR', () => {
    expect(config.WEIGHT_DENOMINATOR).toBe(2520);
    expect(config.DAILY_CAP).toBe(10);
    expect(config.MIN_RATERS).toBe(5);
    expect(config.FUTURE_SKEW_MS).toBe(300_000);
    expect(config.BURST_WINDOW_MS).toBe(60_000);
    expect(config.BURST_COUNT).toBe(5);
    expect(config.BAG_DOSE_MARGIN_PERCENT).toBe(110);
    expect(config.STRAIGHT_LINING_MIN_BREWS).toBe(10);
    expect(config.MIN_HALF_POINTS).toBe(2);
    expect(config.MAX_HALF_POINTS).toBe(20);
    expect(config.MAX_AGE_DAYS).toBe(3);
    expect(config.REFRESH_AFTER_DAYS).toBe(2);
  });

  it('L is the least common multiple of 1 to the cap', () => {
    let lcm = 1;
    for (let n = 1; n <= config.DAILY_CAP; n += 1) lcm = (lcm * n) / gcd(lcm, n);
    expect(config.WEIGHT_DENOMINATOR).toBe(lcm);
  });

  it('derives the per-cup bounds of the ADR', () => {
    expect(config.MAX_SUM_PER_CUP).toBe(50_400);
    expect(config.MAX_SUM_OF_SQUARES_PER_CUP).toBe(1_008_000);
  });

  it('the exactness bound is about 8.9e9 counted cups', () => {
    expect(config.MAX_EXACT_CUPS).toBe(8_935_713_546);
    expect(config.MAX_EXACT_CUPS * config.MAX_SUM_OF_SQUARES_PER_CUP).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect((config.MAX_EXACT_CUPS + 1) * config.MAX_SUM_OF_SQUARES_PER_CUP).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it('the test size (200 users x 10 cups x 20 half-points x L) is far below the bound', () => {
    const sum = 200 * config.DAILY_CAP * config.MAX_HALF_POINTS * config.WEIGHT_DENOMINATOR;
    expect(sum).toBe(100_800_000);
    expect(Number.isSafeInteger(sum)).toBe(true);
  });
});

describe('no threshold outside the config', () => {
  const dir = join(BACKEND_DIR, 'src', 'aggregation');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && f !== 'config.ts')
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // The weight denominator, the per-cup bounds, the margin and the skew in any common spelling.
  const forbidden = /\b(2520|2_520|2,520|50400|50_400|50,400|1008000|1_008_000|1,008,000|1\.10?|300000|300_000|60000|60_000)\b/;

  it.each(files)('$name writes none of the threshold numbers', ({ text }) => {
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(forbidden.test(code)).toBe(false);
  });

  it('the other thresholds are imported by name, not assigned', () => {
    for (const { text } of files) {
      expect(/\b(MIN_RATERS|DAILY_CAP|MAX_AGE_DAYS|BURST_COUNT)\s*=\s*\d/.test(text)).toBe(false);
    }
  });
});
