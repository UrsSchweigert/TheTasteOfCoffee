// Tests for scripts/check-workflows.mjs. Run: node --test scripts/check-workflows.test.mjs
// (needs `npm ci` in contracts/ for the yaml package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow, STRICT_FILES } from './check-workflows.mjs';

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

// ci.yml's profile: strict plus read-only.
const strict = (text) => checkWorkflow(text, { strict: true, readOnly: true });
// claude.yml / aws-oidc-check.yml profile: strict, with a job write allowlist.
const strictWith = (text, jobWrites) => checkWorkflow(text, { strict: true, jobWrites });
const readWorkflow = (name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8');

function has(findings, fragment) {
  assert.ok(findings.some((f) => f.includes(fragment)), `expected a finding with "${fragment}", got ${JSON.stringify(findings)}`);
}

test('the committed ci.yml passes the strict check', () => {
  assert.deepEqual(strict(readWorkflow('ci.yml')), []);
});

test('every strict file is committed and passes with its own policy', () => {
  assert.deepEqual([...STRICT_FILES.keys()].sort(), ['aws-oidc-check.yml', 'ci.yml', 'claude.yml']);
  for (const [name, policy] of STRICT_FILES) {
    assert.deepEqual(checkWorkflow(readWorkflow(name), { strict: true, ...policy }), [], name);
  }
});

test('only ci.yml gets the read-only rules', () => {
  assert.equal(STRICT_FILES.get('ci.yml')?.readOnly, true);
  assert.ok(!STRICT_FILES.get('claude.yml')?.readOnly);
  assert.ok(!STRICT_FILES.get('aws-oidc-check.yml')?.readOnly);
});

test('ci.yml gives each push its own concurrency group, so no push to main is dropped while pending', () => {
  const group = /^\s+group:\s*(.+)$/m.exec(readWorkflow('ci.yml'))?.[1] ?? '';
  assert.match(group, /github\.sha/);
  assert.match(group, /github\.event\.pull_request\.number/);
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
  has(strict(good.replace(' # v6.1.0', ' # pinned')), 'no trailing version comment');
});

test('every uses line needs its own version comment, not only the first occurrence', () => {
  const second = `      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
`;
  const twice = good.replace('      - run: echo hi\n', `${second}      - run: echo hi\n`);
  assert.deepEqual(strict(twice.replace(`${SHA}\n`, `${SHA} # v6.1.0\n`)), [], 'both commented');
  const findings = strict(twice);
  has(findings, 'no trailing version comment');
  assert.equal(findings.filter((f) => f.includes('version comment')).length, 1);
  has(findings, 'line 15:');
});

test('a quoted ref with a version comment passes', () => {
  assert.deepEqual(strict(good.replace(`actions/checkout@${SHA}`, `"actions/checkout@${SHA}"`)), []);
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

test('strict files without the read-only rules allow only allowlisted job write scopes', () => {
  const withJobPerms = (perms) =>
    good.replace('    timeout-minutes: 5', `    timeout-minutes: 5\n    permissions:\n${perms}`);
  const oidc = withJobPerms('      id-token: write\n      contents: read');
  assert.deepEqual(strictWith(oidc, { a: ['id-token'] }), []);
  has(strictWith(oidc, {}), 'job a: permissions grant id-token: write (not in the allowlist');
  has(strictWith(oidc, { b: ['id-token'] }), 'job a: permissions grant id-token: write');
  has(strictWith(withJobPerms('      id-token: write\n      contents: write'), { a: ['id-token'] }), 'contents: write');
  has(strictWith(good.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions: write-all'), { a: ['id-token'] }), 'write-all');
  // Still no top-level write scope, even with a job allowlist.
  has(strictWith(good.replace('contents: read', 'id-token: write'), { a: ['id-token'] }), 'top-level permissions grant id-token: write');
});

test('strict files without the read-only rules may use secrets and an empty top-level permissions block', () => {
  const text = good
    .replace('permissions:\n  contents: read', 'permissions: {}')
    .replace('echo hi', 'echo ${{ secrets.TOKEN }}');
  assert.deepEqual(strictWith(text, {}), []);
  has(strict(text), 'references secrets');
  has(strict(text), 'exactly "contents: read"');
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
