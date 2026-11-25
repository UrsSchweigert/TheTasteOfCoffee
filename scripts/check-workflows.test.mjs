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
  assert.deepEqual([...STRICT_FILES.keys()].sort(), ['aws-oidc-check.yml', 'ci.yml', 'claude.yml', 'deploy.yml']);
  for (const [name, policy] of STRICT_FILES) {
    assert.deepEqual(checkWorkflow(readWorkflow(name), { strict: true, ...policy }), [], name);
  }
});

test('only ci.yml gets the read-only rules', () => {
  assert.equal(STRICT_FILES.get('ci.yml')?.readOnly, true);
  assert.ok(!STRICT_FILES.get('claude.yml')?.readOnly);
  assert.ok(!STRICT_FILES.get('aws-oidc-check.yml')?.readOnly);
  assert.ok(!STRICT_FILES.get('deploy.yml')?.readOnly);
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

test('service and container images must be pinned to a sha256 digest', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const withServices = (image) =>
    good.replace('    timeout-minutes: 5\n', `    timeout-minutes: 5\n    services:\n      db:\n        image: ${image}\n        ports:\n          - 8000:8000\n`);
  const withContainer = (container) => good.replace('    timeout-minutes: 5\n', `    timeout-minutes: 5\n    container: ${container}\n`);
  assert.deepEqual(strict(withServices(`amazon/dynamodb-local:3.3.2@${DIGEST}`)), []);
  assert.deepEqual(strict(withServices(`amazon/dynamodb-local@${DIGEST}`)), []);
  assert.deepEqual(strict(withContainer(`node:22@${DIGEST}`)), []);
  has(strict(withServices('amazon/dynamodb-local:3.3.2')), 'service db: image "amazon/dynamodb-local:3.3.2" is not pinned');
  has(strict(withServices('amazon/dynamodb-local:latest')), 'not pinned to a sha256 digest');
  has(strict(withServices(`amazon/dynamodb-local@sha256:${'a'.repeat(63)}`)), 'not pinned to a sha256 digest');
  has(strict(withContainer('node:22')), 'container: image "node:22" is not pinned');
  has(strict(withContainer('{ options: --cpus 1 }')), 'container: image "undefined" is not pinned');
  has(strict(good.replace('    timeout-minutes: 5\n', '    timeout-minutes: 5\n    services: db\n')), 'services is not a mapping');
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
  const oidc = withJobPerms('      id-token: write\n      contents: read').replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    environment: dev');
  assert.deepEqual(strictWith(oidc, { a: ['id-token'] }), []);
  has(strictWith(oidc, {}), 'job a: permissions grant id-token: write (not in the allowlist');
  has(strictWith(oidc, { b: ['id-token'] }), 'job a: permissions grant id-token: write');
  has(strictWith(withJobPerms('      id-token: write\n      contents: write'), { a: ['id-token'] }), 'contents: write');
  has(strictWith(good.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions: write-all'), { a: ['id-token'] }), 'write-all');
  // Still no top-level write scope, even with a job allowlist.
  has(strictWith(good.replace('contents: read', 'id-token: write'), { a: ['id-token'] }), 'top-level permissions grant id-token: write');
});

test('AWS credentials need the literal environment dev or prod (ADR 0018)', () => {
  const aws = (env) =>
    good
      .replace('    timeout-minutes: 5', `    timeout-minutes: 5${env}\n    permissions:\n      id-token: write`)
      .replace('      - run: echo hi', `      - uses: aws-actions/configure-aws-credentials@${SHA} # v6.3.0\n      - run: echo hi`);
  const policy = { a: ['id-token'] };
  assert.deepEqual(strictWith(aws('\n    environment: dev'), policy), []);
  assert.deepEqual(strictWith(aws('\n    environment: prod'), policy), []);
  assert.deepEqual(strictWith(aws('\n    environment:\n      name: prod\n      url: https://example.com'), policy), []);
  has(strictWith(aws(''), policy), 'configure-aws-credentials needs the literal environment dev or prod');
  has(strictWith(aws('\n    environment: staging'), policy), 'configure-aws-credentials needs');
  has(strictWith(aws('\n    environment: ${{ inputs.env }}'), policy), 'configure-aws-credentials needs');
  // Also in advisory files: a new deploy workflow is caught before it is made strict.
  has(checkWorkflow(aws(''), { strict: false }), 'configure-aws-credentials needs');
});

test('in strict files an OIDC token needs an AWS environment unless the job is listed', () => {
  const oidc = good.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions:\n      id-token: write');
  has(strictWith(oidc, { a: ['id-token'] }), 'job a: requests an OIDC token (id-token: write) without the environment dev or prod');
  assert.deepEqual(checkWorkflow(oidc, { strict: true, jobWrites: { a: ['id-token'] }, oidcWithoutEnvironment: ['a'] }), []);
});

test('the committed AWS OIDC check runs in the dev environment, and claude.yml is the only listed exception', () => {
  const wf = createRequire(join(root, 'contracts', 'package.json'))('yaml').parse(readWorkflow('aws-oidc-check.yml'));
  assert.equal(wf.jobs.check.environment, 'dev');
  const listed = [...STRICT_FILES].filter(([, p]) => (p.oidcWithoutEnvironment ?? []).length > 0).map(([f, p]) => [f, p.oidcWithoutEnvironment]);
  assert.deepEqual(listed, [['claude.yml', ['claude']]]);
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

test('ci.yml: ci-ok needs every job, including changes and ios, and runs unless the run was cancelled', () => {
  const jobs = Object.keys(ci.jobs).filter((id) => id !== 'ci-ok').sort();
  assert.deepEqual([...ci.jobs['ci-ok'].needs].sort(), jobs);
  assert.equal(ci.jobs['ci-ok'].if, '${{ !cancelled() }}');
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

// ---- The deploy workflow (M1-T7, ADR 0019) ----

const deploy = createRequire(join(root, 'contracts', 'package.json'))('yaml').parse(readWorkflow('deploy.yml'));
const DEPLOY_JOBS = { dev: 'deploy-dev', prod: 'deploy-prod' };

test('stage commands: cdk deploy names the stack of the job environment, never --all; no destroy or bootstrap', () => {
  const job = (env, run) => `
name: d
on: workflow_dispatch
permissions: {}
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5${env === undefined ? '' : `\n    environment: ${env}`}
    steps:
      - run: ${run}
`;
  const check = (text) => checkWorkflow(text, { strict: true });
  assert.deepEqual(check(job('dev', 'npx cdk deploy dev/core -c stage=dev')), []);
  assert.deepEqual(check(job('dev', 'npx cdk deploy cupmark-dev-core -c stage=dev')), []);
  has(check(job('dev', 'npx cdk deploy prod/core -c stage=prod')), 'must name exactly the stack');
  has(check(job('dev', 'npx cdk deploy "dev/*"')), 'must name exactly the stack');
  assert.deepEqual(check(job('prod', 'scripts/deploy/deploy-stage.sh prod')), []);
  assert.deepEqual(check(job('dev', 'scripts/smoke/health.sh dev')), []);
  has(check(job('dev', 'npx cdk deploy --all')), 'cdk deploy --all');
  has(check(job('dev', 'npx cdk deploy cupmark-prod-core')), 'must name exactly the stack <environment>/core');
  has(check(job('dev', 'npx cdk deploy cupmark-dev-core cupmark-github-oidc')), 'must name exactly');
  has(check(job('dev', 'npx cdk deploy')), 'must name exactly');
  has(check(job(undefined, 'npx cdk deploy cupmark-dev-core')), 'must name exactly');
  has(check(job('dev', 'npx cdk destroy cupmark-dev-core')), 'runs cdk destroy');
  has(check(job('dev', 'npx cdk bootstrap')), 'runs cdk bootstrap');
  has(check(job('dev', 'scripts/deploy/deploy-stage.sh prod')), 'scripts/deploy/deploy-stage.sh prod must name the job\'s environment (dev)');
  has(check(job('prod', 'scripts/smoke/health.sh dev')), 'must name the job\'s environment (prod)');
  has(check(job('dev', 'scripts/deploy/deploy-stage.sh "$STAGE"')), 'must name the job\'s environment');
  has(check(job(undefined, 'scripts/smoke/health.sh dev')), 'must name the job\'s environment (none)');
  // Advisory files report it too.
  has(checkWorkflow(job('dev', 'npx cdk deploy --all'), { strict: false }), 'cdk deploy --all');
});

test('deploy.yml: dev after CI on main, prod and rollbacks only by hand', () => {
  assert.deepEqual(Object.keys(deploy.on).sort(), ['workflow_dispatch', 'workflow_run']);
  assert.deepEqual(deploy.on.workflow_run, { workflows: ['CI'], types: ['completed'], branches: ['main'] });
  assert.deepEqual(deploy.on.workflow_dispatch.inputs.stage.options, ['dev', 'prod']);
  assert.equal(deploy.on.workflow_dispatch.inputs.stage.type, 'choice');
  assert.equal(deploy.on.workflow_dispatch.inputs.commit.type, 'string');
  // The CI workflow it waits for is ci.yml.
  assert.match(readWorkflow('ci.yml'), /^name: CI$/m);
  assert.deepEqual(deploy.permissions, {});
  assert.deepEqual(Object.keys(deploy.jobs).sort(), ['deploy-dev', 'deploy-prod', 'gate']);
  const gate = deploy.jobs.gate;
  assert.deepEqual(gate.permissions, { actions: 'read', contents: 'read' });
  assert.match(gate.if, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(gate.if, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.ok(!(gate.steps ?? []).some((st) => typeof st.uses === 'string'), 'the gate job uses no action and checks out nothing');
  assert.match(deploy.jobs['deploy-prod'].if, /^github\.event_name == 'workflow_dispatch' && /);
});

for (const [stage, id] of Object.entries(DEPLOY_JOBS)) {
  test(`deploy.yml: ${id} runs in the literal environment ${stage}, with only id-token: write and contents: read`, () => {
    const job = deploy.jobs[id];
    assert.equal(job.environment, stage);
    assert.deepEqual(job.permissions, { 'id-token': 'write', contents: 'read' });
    assert.deepEqual(job.needs, 'gate');
    assert.match(job.if, new RegExp(`needs\\.gate\\.outputs\\.deploy == 'true' && needs\\.gate\\.outputs\\.stage == '${stage}'$`));
    assert.deepEqual(job.concurrency, { group: `deploy-${stage}`, 'cancel-in-progress': false });
    const steps = job.steps;
    const uses = (prefix) => steps.findIndex((st) => typeof st.uses === 'string' && st.uses.startsWith(prefix));
    const runs = (text) => steps.findIndex((st) => typeof st.run === 'string' && st.run.includes(text));
    const checkout = steps[uses('actions/checkout@')];
    assert.deepEqual(checkout.with, { ref: '${{ needs.gate.outputs.sha }}', 'persist-credentials': false });
    const node = steps[uses('actions/setup-node@')];
    assert.deepEqual(node.with, { 'node-version-file': '.nvmrc' }, 'no npm cache in a deploy');
    assert.match(readFileSync(join(root, '.nvmrc'), 'utf8'), /^22\./);
    const aws = steps[uses('aws-actions/configure-aws-credentials@')];
    assert.deepEqual(aws.with, {
      'role-to-assume': '${{ secrets.AWS_DEPLOY_ROLE_ARN }}',
      'aws-region': 'eu-central-1',
      'role-session-name': `cupmark-deploy-${stage}`,
    });
    // Order: install and build before any credentials, then deploy, then the smoke test.
    const order = [steps.findIndex((st) => st.name === 'Re-check the gate'), uses('actions/checkout@'), uses('actions/setup-node@'), runs('npm ci'), runs('npm run build'), uses('aws-actions/configure-aws-credentials@'), runs('scripts/deploy/deploy-stage.sh'), runs('scripts/smoke/health.sh')];
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.equal(steps.filter((st) => typeof st.run === 'string' && st.run.includes('npm ci')).length, 2);
    assert.deepEqual(steps.filter((st) => st['working-directory'] !== undefined).map((st) => st['working-directory']), ['backend', 'backend', 'infra']);
    const deployStep = steps[runs('scripts/deploy/deploy-stage.sh')];
    assert.equal(deployStep.run, `scripts/deploy/deploy-stage.sh ${stage}`);
    // The mailbox is an environment secret (masked); a variable would be printed in clear.
    assert.deepEqual(deployStep.env, { OFF_CONTACT: '${{ secrets.OFF_CONTACT }}', OFF_LOOKUP_CAP: '${{ vars.OFF_LOOKUP_CAP }}' });
    assert.equal(steps[0].name, 'Re-check the gate', 'the re-check is the first step');
    assert.deepEqual(steps[0].env, {
      DEPLOY_ENABLED: '${{ vars.CUPMARK_DEPLOY_ENABLED }}',
      GH_TOKEN: '${{ github.token }}',
      REPO: '${{ github.repository }}',
      EVENT_NAME: '${{ github.event_name }}',
      SHA: '${{ needs.gate.outputs.sha }}',
    });
    assert.equal(steps[runs('scripts/smoke/health.sh')].run, `scripts/smoke/health.sh ${stage}`);
    // No secret or variable other than these reaches the job.
    const text = JSON.stringify(job);
    assert.deepEqual([...new Set(text.match(/\b(?:secrets|vars)\.[A-Z_]+/g))].sort(), [
      'secrets.AWS_DEPLOY_ROLE_ARN',
      'secrets.OFF_CONTACT',
      'vars.CUPMARK_DEPLOY_ENABLED',
      'vars.OFF_LOOKUP_CAP',
    ]);
  });
}

test('deploy.yml: the prod job is the dev job with dev replaced by prod (they cannot drift apart)', () => {
  const asProd = JSON.stringify(deploy.jobs['deploy-dev'].steps).replaceAll('dev', 'prod');
  assert.equal(JSON.stringify(deploy.jobs['deploy-prod'].steps), asProd);
  const { if: devIf, ...devRest } = deploy.jobs['deploy-dev'];
  const { if: prodIf, ...prodRest } = deploy.jobs['deploy-prod'];
  assert.equal(JSON.stringify(prodRest), JSON.stringify(devRest).replaceAll('dev', 'prod'));
  assert.equal(prodIf, `github.event_name == 'workflow_dispatch' && ${devIf.replace("'dev'", "'prod'")}`);
});

// The gate step, run as GitHub runs it, against a fake `gh` (no network).
const gateStep = deploy.jobs.gate.steps.find((s) => s.name === 'Decide what to deploy');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function runGate(env, gh = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'gh.log');
    const { tip = HEAD, compare = 'ahead', ciRuns = '1' } = gh;
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
case "$*" in
  "api repos/o/r/git/ref/heads/main --jq .object.sha") echo "${tip}" ;;
  "api repos/o/r/compare/"*"...main --jq .status") echo "${compare}" ;;
  "api repos/o/r/actions/workflows/ci.yml/runs?head_sha="*"&event=push&status=success&per_page=1 --jq .total_count") echo "${ciRuns}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const base = { DEPLOY_ENABLED: 'true', GH_TOKEN: 'x', REPO: 'o/r', PATH: `${bin}:${process.env.PATH}` };
    // A key set to undefined is left out (an unset variable).
    const merged = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined));
    const r = runShell(gateStep.run, merged, dir);
    let calls = '';
    try {
      calls = readFileSync(log, 'utf8');
    } catch {
      calls = '';
    }
    const out = Object.fromEntries(r.output.trim().split('\n').filter(Boolean).map((l) => l.split('=')));
    return { ...r, out, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUN_OK = {
  EVENT_NAME: 'workflow_run',
  REF: 'refs/heads/main',
  RUN_CONCLUSION: 'success',
  RUN_EVENT: 'push',
  RUN_BRANCH: 'main',
  RUN_REPO: 'o/r',
  RUN_PATH: '.github/workflows/ci.yml',
  RUN_SHA: HEAD,
};
const DISPATCH = { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main', INPUT_STAGE: 'prod', INPUT_COMMIT: '', DISPATCH_SHA: HEAD };

test('gate: a successful CI run of a push to main deploys exactly its head_sha to dev', () => {
  const r = runGate(RUN_OK);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.out, { deploy: 'true', stage: 'dev', sha: HEAD });
});

test('gate: a CI run that is not a successful push to main of this repository, from ci.yml, never deploys', () => {
  for (const [key, value] of [
    ['RUN_BRANCH', 'feature'],
    ['RUN_REPO', 'fork/r'],
    ['RUN_PATH', '.github/workflows/other.yml'],
    ['RUN_CONCLUSION', 'failure'],
    ['RUN_SHA', 'main'],
  ]) {
    const r = runGate({ ...RUN_OK, [key]: value });
    assert.equal(r.status, 1, `${key}=${value}: ${r.stdout}`);
    assert.match(r.stdout, /Not deploying/);
    assert.deepEqual(r.out, {}, `${key}=${value}`);
  }
});

test('gate: a CI run of a commit that main has moved past is skipped, not deployed over the newer one', () => {
  const r = runGate(RUN_OK, { tip: OLD });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.out, { deploy: 'false', stage: 'dev', sha: HEAD });
  assert.match(r.stdout, /superseded/);
});

test('gate: a dispatch deploys the tip of main, or an earlier commit of main that passed CI (rollback)', () => {
  assert.deepEqual(runGate(DISPATCH).out, { deploy: 'true', stage: 'prod', sha: HEAD });
  const back = runGate({ ...DISPATCH, INPUT_STAGE: 'dev', INPUT_COMMIT: OLD });
  assert.deepEqual(back.out, { deploy: 'true', stage: 'dev', sha: OLD });
  assert.match(back.calls, new RegExp(`compare/${OLD}\\.\\.\\.main`));
  assert.match(back.calls, new RegExp(`head_sha=${OLD}&event=push&status=success`));
  assert.deepEqual(runGate(DISPATCH, { compare: 'identical' }).out.deploy, 'true');
});

test('gate: a dispatch from another branch, of an unknown stage, a bad SHA, a commit off main or without CI is refused', () => {
  const cases = [
    [{ ...DISPATCH, REF: 'refs/heads/feature' }, {}],
    [{ ...DISPATCH, INPUT_STAGE: 'staging' }, {}],
    [{ ...DISPATCH, INPUT_STAGE: '' }, {}],
    [{ ...DISPATCH, INPUT_COMMIT: 'abc123' }, {}],
    [{ ...DISPATCH, INPUT_COMMIT: HEAD.toUpperCase() }, {}],
    [{ ...DISPATCH, INPUT_COMMIT: `${HEAD};rm -rf /` }, {}],
    [DISPATCH, { compare: 'diverged' }],
    [DISPATCH, { compare: 'behind' }],
    [DISPATCH, { ciRuns: '0' }],
    [{ ...DISPATCH, EVENT_NAME: 'push' }, {}],
  ];
  for (const [env, gh] of cases) {
    const r = runGate(env, gh);
    assert.equal(r.status, 1, `${JSON.stringify(env)} ${JSON.stringify(gh)}: ${r.stdout}`);
    assert.deepEqual(r.out, {});
  }
});

test('gate: without CUPMARK_DEPLOY_ENABLED exactly true, nothing deploys and the gate succeeds with a notice', () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes']) {
    for (const event of [RUN_OK, DISPATCH]) {
      const env = { ...event, DEPLOY_ENABLED: value };
      const r = runGate(env);
      assert.equal(r.status, 0, `${String(value)}: ${r.stdout}`);
      assert.deepEqual(r.out, { deploy: 'false' }, String(value));
      assert.match(r.stdout, /::notice title=Deploys are off::.*CUPMARK_DEPLOY_ENABLED.*set it to true/);
      assert.equal(r.calls, '', 'no GitHub API call while deploys are off');
    }
  }
  // Even an invalid dispatch is not looked at while off.
  assert.deepEqual(runGate({ ...DISPATCH, DEPLOY_ENABLED: 'false', REF: 'refs/heads/feature' }).out, { deploy: 'false' });
});

test('deploy.yml: the switch is read from vars only, and every deploy job needs the gate to say deploy=true', () => {
  assert.equal(gateStep.env.DEPLOY_ENABLED, '${{ vars.CUPMARK_DEPLOY_ENABLED }}');
  const text = readWorkflow('deploy.yml');
  // The gate and the re-check step of each deploy job: always vars.
  assert.deepEqual(text.match(/[^\s]*CUPMARK_DEPLOY_ENABLED\b[^\n]*\}\}/g), Array(3).fill('vars.CUPMARK_DEPLOY_ENABLED }}'));
  assert.doesNotMatch(text, /vars\.OFF_CONTACT/, 'the mailbox is a secret, never a variable');
  assert.doesNotMatch(text, /inputs\.[A-Za-z_]*(deploy|enable)/i);
  assert.deepEqual(Object.keys(deploy.on.workflow_dispatch.inputs).sort(), ['commit', 'stage']);
  // The off check comes before any other decision in the gate script.
  const run = gateStep.run;
  assert.ok(run.indexOf('DEPLOY_ENABLED') < run.indexOf('case "$EVENT_NAME"'));
  assert.match(run, /if \[ "\$\{DEPLOY_ENABLED:-\}" != "true" \]; then/);
  for (const [id, job] of Object.entries(deploy.jobs)) {
    if (id === 'gate') continue;
    assert.equal(job.needs, 'gate', id);
    assert.match(job.if, /needs\.gate\.outputs\.deploy == 'true'/, id);
    assert.ok(job.environment === 'dev' || job.environment === 'prod', id);
  }
});

test('gate: a CI run of a pull request (a fork branch may be called main) is skipped quietly, not failed', () => {
  for (const event of ['pull_request', 'pull_request_review', 'workflow_dispatch']) {
    const r = runGate({ ...RUN_OK, RUN_EVENT: event, RUN_REPO: 'fork/r' });
    assert.equal(r.status, 0, `${event}: ${r.stdout}`);
    assert.deepEqual(r.out, { deploy: 'false' });
    assert.doesNotMatch(r.stdout, /Not deploying/);
    assert.equal(r.calls, '');
  }
});

// The re-check at the start of each deploy job: "Re-run failed jobs" reuses old gate outputs.
function runRecheck(job, env, tip = HEAD) {
  const step = deploy.jobs[job].steps.find((st) => st.name === 'Re-check the gate');
  const dir = mkdtempSync(join(tmpdir(), 'deploy-recheck-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'gh.log');
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
case "$*" in
  "api repos/o/r/git/ref/heads/main --jq .object.sha") echo "${tip}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const merged = Object.fromEntries(
      Object.entries({ DEPLOY_ENABLED: 'true', GH_TOKEN: 'x', REPO: 'o/r', SHA: HEAD, PATH: `${bin}:${process.env.PATH}`, ...env }).filter(([, v]) => v !== undefined),
    );
    const r = runShell(step.run, merged, dir);
    let calls = '';
    try {
      calls = readFileSync(log, 'utf8');
    } catch {
      calls = '';
    }
    return { ...r, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const job of Object.values(DEPLOY_JOBS)) {
  test(`${job}: the re-check passes for the tip of main, and fails a re-run once deploys are off or main moved on`, () => {
    assert.equal(runRecheck(job, { EVENT_NAME: 'workflow_run' }).status, 0);
    assert.equal(runRecheck(job, { EVENT_NAME: 'workflow_dispatch', SHA: OLD }).status, 0, 'a rollback is not a tip');
    for (const value of [undefined, 'false', 'TRUE']) {
      const off = runRecheck(job, { EVENT_NAME: 'workflow_run', DEPLOY_ENABLED: value });
      assert.equal(off.status, 1, String(value));
      assert.match(off.stdout, /Deploys are off/);
      assert.equal(off.calls, '');
    }
    const moved = runRecheck(job, { EVENT_NAME: 'workflow_run' }, OLD);
    assert.equal(moved.status, 1);
    assert.match(moved.stdout, /Superseded.*Re-run all jobs/);
    assert.equal(runRecheck(job, { EVENT_NAME: 'workflow_run', SHA: '' }).status, 1);
  });
}

test('stage commands: cdk is found with options before the verb, npx cdk@version, npm run cdk -- and continuations', () => {
  const job = (env, run) => `
name: d
on: workflow_dispatch
permissions: {}
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: ${env}
    steps:
      - run: |
${run.split('\n').map((l) => `          ${l}`).join('\n')}
`;
  const check = (env, run) => checkWorkflow(job(env, run), { strict: true });
  has(check('dev', 'npx cdk -c stage=dev deploy --all'), 'cdk deploy --all');
  has(check('dev', 'npx cdk --app "node x" -c stage=prod deploy prod/core'), 'must name exactly the stack');
  has(check('dev', 'npx cdk@2.1149.0 destroy dev/core'), 'runs cdk destroy');
  has(check('dev', 'npm run cdk -- deploy cupmark-prod-core'), 'must name exactly the stack');
  has(check('dev', 'npm run cdk -- bootstrap'), 'runs cdk bootstrap');
  has(check('dev', './node_modules/.bin/cdk deploy --all'), 'cdk deploy --all');
  has(check('dev', 'npx cdk \\\n  deploy \\\n  --all'), 'cdk deploy --all');
  has(check('dev', 'cd infra && npx cdk -v "deploy" "prod/core"'), 'must name exactly the stack');
  has(check('dev', 'npx aws-cdk deploy --all'), 'cdk deploy --all');
  has(check('dev', 'npx aws-cdk@2 destroy dev/core'), 'runs cdk destroy');
  has(check('dev', 'npx cdk deploy dev/core; npx cdk destroy'), 'runs cdk destroy');
  has(check('dev', 'npx cdk deploy dev/core && npx cdk deploy prod/core'), 'must name exactly the stack');
  has(check('dev', 'npx cdk diff dev/core || npx cdk deploy --all'), 'cdk deploy --all');
  has(check('dev', 'npx cdk deploy dev/core | tee log; npx aws-cdk bootstrap'), 'runs cdk bootstrap');
  has(check('dev', '(cd infra && npx cdk destroy)'), 'runs cdk destroy');
  has(check('dev', 'x=$(npx cdk bootstrap)'), 'runs cdk bootstrap');
  has(check('dev', 'echo `npx cdk destroy`'), 'runs cdk destroy');
  has(check('dev', '(cd infra && npx cdk deploy --all)'), 'cdk deploy --all');
  assert.deepEqual(check('dev', '(cd infra && npx cdk deploy dev/core)'), []);
  assert.deepEqual(check('dev', 'npx cdk diff dev/core; npx cdk deploy dev/core | tee deploy.log'), []);
  assert.deepEqual(check('dev', 'npx cdk -c stage=dev deploy dev/core --require-approval never'), []);
  assert.deepEqual(check('dev', 'npx cdk@2.1149.0 \\\n  deploy dev/core'), []);
  // Not cdk invocations: no finding.
  assert.deepEqual(check('dev', 'npm i aws-cdk-lib\ncat cdk.json\nnpx cdk synth -c x=deploy\necho cdk-deploy'), []);
});
