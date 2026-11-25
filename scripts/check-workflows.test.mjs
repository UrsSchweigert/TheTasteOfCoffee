// Tests for scripts/check-workflows.mjs. Run: node --test scripts/check-workflows.test.mjs
// (needs `npm ci` in contracts/ for the yaml package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

// The path filter (M0-T9). These tests run the committed shell of ci.yml, as
// GitHub runs it (bash --noprofile --norc -eo pipefail), against throwaway git
// repositories, so what is tested is exactly what CI executes.
const ci = createRequire(join(root, 'contracts', 'package.json'))('yaml').parse(readWorkflow('ci.yml'));
const stepOf = (job, name) => {
  const step = ci.jobs[job].steps.find((s) => s.name === name);
  assert.ok(step, `${job} has no step "${name}"`);
  return step;
};
const changesStep = stepOf('changes', 'Paths that affect the app');
const ciOkStep = stepOf('ci-ok', 'All jobs passed');

function runShell(script, env, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-step-'));
  try {
    const file = join(dir, 'step.sh');
    const output = join(dir, 'output');
    writeFileSync(file, script);
    writeFileSync(output, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      cwd: cwd ?? dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
    });
    return { status: result.status, stdout: result.stdout + result.stderr, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'ci-test',
  GIT_AUTHOR_EMAIL: 'ci-test@example.invalid',
  GIT_COMMITTER_NAME: 'ci-test',
  GIT_COMMITTER_EMAIL: 'ci-test@example.invalid',
};
const BASE_FILES = [
  'ios/Cupmark/RootView.swift',
  'backend/src/a.ts',
  'docs/README.md',
  'contracts/openapi.yaml',
  'contracts/vocabulary/v1/brew.json',
  'contracts/i18n/de.json',
  'scripts/check-ios-strings.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/claude.yml',
];

/**
 * Makes a repository with BASE_FILES committed, then applies `change` (a
 * function of the repo dir that edits files) as a second commit, and runs the
 * changes step there. Returns the step's stdout, exit status and ios output.
 */
function filterAfter(change, { event = 'pull_request', base } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ci-repo-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    for (const f of BASE_FILES) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), `${f}\n`);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    change(repo, git);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
    const run = runShell(changesStep.run, { ...GIT_ENV, ...changesStep.env, EVENT_NAME: event, BASE_SHA: base ?? baseSha }, repo);
    assert.equal(run.status, 0, run.stdout);
    const ios = /^ios=(true|false)$/m.exec(run.output)?.[1];
    assert.ok(ios, `no ios output: ${run.output}`);
    return { ios, log: run.stdout };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
const editing = (...paths) => (repo) => {
  for (const f of paths) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), 'changed\n', { flag: 'a' });
  }
};

test('ci.yml: the ios job needs the changes job and runs only when it says ios=true', () => {
  assert.equal(ci.jobs.ios.needs, 'changes');
  assert.equal(ci.jobs.ios.if, "needs.changes.outputs.ios == 'true'");
  assert.equal(ci.jobs.changes.outputs.ios, '${{ steps.diff.outputs.ios }}');
  assert.equal(changesStep.id, 'diff');
  const checkout = ci.jobs.changes.steps[0];
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(changesStep.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  // No expression is spliced into the shell itself; values arrive through env.
  assert.doesNotMatch(changesStep.run, /\$\{\{/);
  assert.doesNotMatch(ciOkStep.run, /\$\{\{/);
});

test('ci.yml: ci-ok needs every job, including changes and ios, and always runs', () => {
  const jobs = Object.keys(ci.jobs).filter((id) => id !== 'ci-ok').sort();
  assert.deepEqual([...ci.jobs['ci-ok'].needs].sort(), jobs);
  assert.equal(ci.jobs['ci-ok'].if, 'always()');
  // Every job except ios is listed in OTHER_RESULTS, so each must be success.
  const text = ciOkStep.env.OTHER_RESULTS;
  const others = [...text.matchAll(/(\S+)=(\$\{\{[^}]*\}\})/g)];
  assert.equal(others.map((m) => m[0]).join(' '), text.trim(), 'only id=${{ ... }} pairs');
  assert.deepEqual(
    others.map((m) => m[1]).sort(),
    jobs.filter((id) => id !== 'ios'),
  );
  for (const [, id, expr] of others) assert.equal(expr, `\${{ needs.${id}.result }}`);
  assert.equal(ciOkStep.env.IOS_RESULT, '${{ needs.ios.result }}');
  assert.equal(ciOkStep.env.CHANGES_IOS, '${{ needs.changes.outputs.ios }}');
});

test('path filter: changes that cannot affect the app give ios=false', () => {
  assert.equal(filterAfter(editing('backend/src/a.ts')).ios, 'false');
  assert.equal(filterAfter(editing('docs/README.md', 'backlog/BACKLOG.md')).ios, 'false');
  assert.equal(filterAfter(editing('contracts/openapi.yaml')).ios, 'false');
  assert.equal(filterAfter(editing('.github/workflows/claude.yml')).ios, 'false');
  assert.equal(filterAfter(editing('iosx/a.swift', 'scripts/check-ios-strings.mjs.bak')).ios, 'false');
  assert.equal(filterAfter(() => {}).ios, 'false', 'an empty diff');
});

test('path filter: changes under each app path give ios=true', () => {
  for (const path of [
    'ios/Cupmark/RootView.swift',
    'ios/New Folder/Été.swift',
    'contracts/vocabulary/v2/brew.json',
    'contracts/i18n/de.json',
    'scripts/generate-ios-vocabulary.mjs',
    'scripts/check-ios-strings.mjs',
    '.github/workflows/ci.yml',
  ]) {
    const { ios, log } = filterAfter(editing('docs/README.md', path));
    assert.equal(ios, 'true', `${path}: ${log}`);
  }
});

test('path filter: deleting or moving a file out of ios/ gives ios=true', () => {
  assert.equal(filterAfter((repo, git) => git('rm', '-q', 'ios/Cupmark/RootView.swift')).ios, 'true');
  assert.equal(filterAfter((repo, git) => git('mv', 'ios/Cupmark/RootView.swift', 'docs/RootView.swift')).ios, 'true');
});

test('path filter: pushes and unknown events always run ios, and any doubt fails safe to ios=true', () => {
  assert.equal(filterAfter(editing('docs/README.md'), { event: 'push' }).ios, 'true');
  assert.equal(filterAfter(editing('docs/README.md'), { event: 'workflow_dispatch' }).ios, 'true');
  assert.equal(filterAfter(editing('docs/README.md'), { base: '' }).ios, 'true');
  const missing = filterAfter(editing('docs/README.md'), { base: '0123456789abcdef0123456789abcdef01234567' });
  assert.equal(missing.ios, 'true');
  assert.match(missing.log, /not available/);
  assert.equal(filterAfter(editing('docs/README.md'), { base: '--output=/dev/null' }).ios, 'true');
});

function ciOk({ ios, changesIos, others = 'success' }) {
  const otherResults = ['changes', 'workflow-lint', 'contracts', 'backend', 'infra']
    .map((id) => `${id}=${typeof others === 'string' ? others : (others[id] ?? 'success')}`)
    .join(' ');
  return runShell(ciOkStep.run, { CHANGES_IOS: changesIos, IOS_RESULT: ios, OTHER_RESULTS: otherResults }).status;
}

test('ci-ok: passes when all succeed, or when ios is skipped because changes said ios=false', () => {
  assert.equal(ciOk({ ios: 'success', changesIos: 'true' }), 0);
  assert.equal(ciOk({ ios: 'skipped', changesIos: 'false' }), 0);
});

test('ci-ok: fails on a failed, cancelled or unexpectedly skipped ios', () => {
  assert.equal(ciOk({ ios: 'failure', changesIos: 'true' }), 1);
  assert.equal(ciOk({ ios: 'cancelled', changesIos: 'true' }), 1);
  assert.equal(ciOk({ ios: 'failure', changesIos: 'false' }), 1);
  assert.equal(ciOk({ ios: 'skipped', changesIos: 'true' }), 1);
  assert.equal(ciOk({ ios: 'skipped', changesIos: '' }), 1, 'changes produced no output');
  assert.equal(ciOk({ ios: 'skipped', changesIos: 'false', others: { changes: 'failure' } }), 1);
});

test('ci-ok: fails when any other job is not success, also when ios was rightly skipped', () => {
  for (const id of ['changes', 'workflow-lint', 'contracts', 'backend', 'infra']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(ciOk({ ios: 'skipped', changesIos: 'false', others: { [id]: result } }), 1, `${id}=${result}`);
      assert.equal(ciOk({ ios: 'success', changesIos: 'true', others: { [id]: result } }), 1, `${id}=${result}`);
    }
  }
});
