// Tests for scripts/check-workflows.mjs. Run: node --test scripts/check-workflows.test.mjs
// (needs `npm ci` in contracts/ for the yaml package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow } from './check-workflows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';

const good = `
name: ok
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA} # v6.1.0
        with:
          persist-credentials: false
      - run: echo hi
`;

const strict = (text) => checkWorkflow(text, { strict: true });

function has(findings, fragment) {
  assert.ok(findings.some((f) => f.includes(fragment)), `expected a finding with "${fragment}", got ${JSON.stringify(findings)}`);
}

test('the committed ci.yml passes the strict check', () => {
  const text = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.deepEqual(strict(text), []);
});

test('a minimal safe workflow passes', () => {
  assert.deepEqual(strict(good), []);
});

test('a tag or branch ref is rejected', () => {
  has(strict(good.replace(`@${SHA} # v6.1.0`, '@v6')), 'not pinned to a full 40-character commit SHA');
  has(strict(good.replace(`@${SHA} # v6.1.0`, '@main')), 'not pinned');
  has(strict(good.replace(`@${SHA}`, `@${SHA.slice(0, 7)}`)), 'not pinned');
});

test('a SHA without a version comment is rejected', () => {
  has(strict(good.replace(' # v6.1.0', '')), 'no trailing version comment');
});

test('pull_request_target is rejected in any trigger form', () => {
  has(strict(good.replace('  pull_request:', '  pull_request_target:')), 'pull_request_target');
  has(strict(good.replace('on:\n  pull_request:', 'on: pull_request_target')), 'pull_request_target');
  has(strict(good.replace('on:\n  pull_request:', 'on: [push, pull_request_target]')), 'pull_request_target');
});

test('permissions other than exactly contents: read are rejected', () => {
  has(strict(good.replace('contents: read', 'contents: write')), 'grant contents: write');
  has(strict(good.replace('contents: read', 'contents: read\n  id-token: write')), 'exactly "contents: read"');
  has(strict(good.replace('permissions:\n  contents: read', 'permissions: write-all')), 'write-all');
  has(strict(good.replace('permissions:\n  contents: read\n', '')), 'no top-level permissions');
  has(strict(good.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions:\n      contents: read')), 'job-level permissions');
});

test('secrets, missing timeouts and persisted checkout credentials are rejected', () => {
  has(strict(good.replace('echo hi', 'echo ${{ secrets.TOKEN }}')), 'references secrets');
  has(strict(good.replace('    timeout-minutes: 5\n', '')), 'no timeout-minutes');
  has(strict(good.replace('persist-credentials: false', 'persist-credentials: true')), 'persist-credentials');
  has(strict(good.replace('        with:\n          persist-credentials: false\n', '')), 'persist-credentials');
});

test('advisory mode still reports unpinned actions and write scopes, but allows job permissions and secrets', () => {
  const text = good
    .replace(`@${SHA} # v6.1.0`, '@v6')
    .replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions:\n      issues: write')
    .replace('echo hi', 'echo ${{ secrets.TOKEN }}');
  const findings = checkWorkflow(text, { strict: false });
  has(findings, 'not pinned');
  has(findings, 'issues: write');
  assert.ok(!findings.some((f) => f.includes('references secrets')));
});
