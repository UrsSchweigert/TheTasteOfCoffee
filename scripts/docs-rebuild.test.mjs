// Doc-grep test for ADR 0035 (M3-T12): the product docs and agent files no longer describe the
// retired incremental aggregator. Run: node --test scripts/docs-rebuild.test.mjs
// docs/decisions/ is excluded on purpose: ADR text is history (ADR 0034 says deleted brews
// "are subtracted (D2)"). The file list and the phrase list are here; add a phrase when a
// retired idea comes back in a doc. Patterns are checked per line, case-insensitively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'docs/01-personas.md',
  'docs/02-usp.md',
  'docs/03-project-brief.md',
  'docs/04-specification.md',
  'docs/05-system-design.md',
  'docs/06-cost-estimate.md',
  'docs/07-open-questions.md',
  '.claude/agents/backend-engineer.md',
  '.claude/agents/infra-engineer.md',
  '.claude/agents/reviewer.md',
  '.claude/agents/planner.md',
  '.claude/agents/contract-keeper.md',
];

const STALE = [
  { pattern: /RATER#/, why: 'the rater marker item is gone' },
  { pattern: /rater marker/i, why: 'the rater marker item is gone' },
  { pattern: /day[- ]slot/i, why: 'no day-slot items exist' },
  { pattern: /stream aggregator/i, why: 'the stream aggregator is not built' },
  { pattern: /aggregator (subtracts|adds|applies|ignores|keeps|counts)/i, why: 'there is no aggregator on the stream' },
  { pattern: /\bsubtract/i, why: 'nothing is subtracted; the nightly rebuild no longer counts deleted brews' },
  { pattern: /running totals/i, why: 'aggregates are rebuilt nightly, not kept as running totals' },
  { pattern: /atomic counters?/i, why: 'no atomic counters on aggregates' },
  { pattern: /apply the difference|applies the difference|difference-apply/i, why: 'no difference-apply logic' },
  { pattern: /counts only brews whose author had consent at write time/i, why: 'consent is read at run time' },
  { pattern: /one rating per user,? bean,? and day/i, why: 'every cup counts, with one vote per bean per day' },
  { pattern: /one rating per user-bean-day/i, why: 'every cup counts, with one vote per bean per day' },
  { pattern: /\bthree small workers\b(?!:)/i, why: 'the workers must be named (health, apple-idp, nightly-aggregates)' },
];

function read(file) {
  try {
    return readFileSync(join(ROOT, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined; // a listed file that does not exist (yet) has nothing stale
    throw error;
  }
}

test('no stale aggregator wording in docs and agent files', () => {
  const found = [];
  let checked = 0;
  for (const file of FILES) {
    const text = read(file);
    if (text === undefined) continue;
    checked += 1;
    text.split('\n').forEach((line, index) => {
      for (const { pattern, why } of STALE) {
        if (pattern.test(line)) {
          found.push(`${file}:${String(index + 1)}: ${pattern} (${why})`);
        }
      }
    });
  }
  assert.ok(checked >= 8, 'the file list must point at real files');
  assert.deepEqual(found, []);
});

test('the file list never includes the ADRs', () => {
  for (const file of FILES) assert.ok(!file.startsWith('docs/decisions/'), file);
});

test('docs/05 names the three workers and the run log keys', () => {
  const text = read('docs/05-system-design.md') ?? '';
  for (const phrase of ['nightly-aggregates', 'apple-idp', 'health check']) assert.ok(text.includes(phrase), phrase);
  for (const key of ['operation', 'status', 'dry_run', 'items_written', 'items_deleted', 'users_seen', 'brews_orphaned', 'FAILED', 'stage', 'error']) {
    assert.ok(text.includes('`' + key) || text.includes(key), key);
  }
});
