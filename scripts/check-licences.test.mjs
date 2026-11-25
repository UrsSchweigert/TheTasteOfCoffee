// Tests for scripts/check-licences.mjs (backlog M0-T10). No dependencies.
// Run: node --test scripts/check-licences.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, judgeLicence, licenceExpression, loadPolicy, parseSpdx } from './check-licences.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-licences.mjs');
const policy = loadPolicy();

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-licences-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A fake project: a lockfile with `packages` and a node_modules tree with the
 * `installed` package.json files (keyed by lockfile path).
 */
function project(t, { packages = {}, installed = {} }) {
  const dir = tempDir(t);
  writeJson(join(dir, 'package-lock.json'), {
    name: 'fixture',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '0.0.0', license: 'UNLICENSED' }, ...packages },
  });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const [key, pkg] of Object.entries(installed)) writeJson(join(dir, key, 'package.json'), pkg);
  return dir;
}

/** One installed package, with the same licence in the lockfile entry and package.json. */
function single(t, name, licence, entryExtra = {}) {
  const key = `node_modules/${name}`;
  return project(t, {
    packages: { [key]: { version: '1.0.0', license: licence, ...entryExtra } },
    installed: { [key]: { name, version: '1.0.0', license: licence } },
  });
}

const check = (dir) => checkProject(dir, policy, { label: 'fixture', platform: 'linux', arch: 'x64' });

test('the real policy loads and allows only the permissive list, with MPL-2.0 dev-only', () => {
  assert.deepEqual([...policy.allowed].sort(), ['0bsd', 'apache-2.0', 'blueoak-1.0.0', 'bsd-2-clause', 'bsd-3-clause', 'cc0-1.0', 'isc', 'mit', 'unlicense']);
  assert.deepEqual([...policy.devOnly.keys()], ['mpl-2.0']);
  assert.equal(policy.devOnly.get('mpl-2.0').adr, 'docs/decisions/0008-mpl-licensed-dev-tooling.md');
  assert.deepEqual(policy.exceptions, []);
});

test('permissive packages pass', (t) => {
  for (const licence of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']) {
    const r = check(single(t, 'ok-pkg', licence));
    assert.deepEqual(r.failures, [], licence);
    assert.equal(r.installed, 1);
  }
});

test('a GPL-3.0 package fails, with name, version, licence and path in the failure', (t) => {
  const r = check(single(t, 'gpl-pkg', 'GPL-3.0'));
  assert.equal(r.failures.length, 1);
  const [f] = r.failures;
  assert.equal(f.name, 'gpl-pkg');
  assert.equal(f.version, '1.0.0');
  assert.equal(f.licence, 'GPL-3.0');
  assert.equal(f.path, 'fixture/node_modules/gpl-pkg');
  assert.match(f.reason, /GPL-3\.0 is not on the allowlist/);
  // GPL fails as a dev dependency too.
  assert.equal(check(single(t, 'gpl-dev', 'GPL-3.0-only', { dev: true })).failures.length, 1);
});

test('a missing, unknown, UNLICENSED or custom licence fails', (t) => {
  const missing = project(t, {
    packages: { 'node_modules/nolic': { version: '1.0.0' } },
    installed: { 'node_modules/nolic': { name: 'nolic', version: '1.0.0' } },
  });
  assert.match(check(missing).failures[0].reason, /no licence/);
  for (const [licence, reason] of [
    ['WTFPL', /not on the allowlist/],
    ['Custom', /not on the allowlist/],
    ['LicenseRef-Proprietary', /not on the allowlist/],
    ['UNLICENSED', /UNLICENSED/],
    ['SEE LICENSE IN LICENSE.txt', /SEE LICENSE IN/],
    ['MIT OR', /unparseable/],
    ['(MIT', /unparseable/],
    ['MIT/Apache', /unparseable/],
    ['', /unparseable|no licence|malformed/],
  ]) {
    const r = check(single(t, 'weird', licence));
    assert.equal(r.failures.length, 1, `${licence} should fail`);
    assert.match(r.failures[0].reason, reason, licence);
  }
});

test('MPL-2.0 passes as a dev dependency and fails otherwise (ADR 0008)', (t) => {
  assert.deepEqual(check(single(t, 'lightningcss', 'MPL-2.0', { dev: true })).failures, []);
  const prod = check(single(t, 'lightningcss', 'MPL-2.0'));
  assert.equal(prod.failures.length, 1);
  assert.match(prod.failures[0].reason, /only for dev dependencies.*0008/);
  // devOptional: dev on one path, but optional in the production tree.
  assert.equal(check(single(t, 'lightningcss', 'MPL-2.0', { devOptional: true })).failures.length, 1);
});

test('SPDX: OR passes if any branch is allowed, AND needs every part', (t) => {
  assert.deepEqual(check(single(t, 'dual', 'MIT OR GPL-3.0')).failures, []);
  assert.deepEqual(check(single(t, 'case', '(MIT OR GPL-3.0-or-later)')).failures, []);
  assert.deepEqual(check(single(t, 'both', 'MIT AND ISC')).failures, []);
  const and = check(single(t, 'both', 'MIT AND GPL-3.0'));
  assert.equal(and.failures.length, 1);
  assert.match(and.failures[0].reason, /AND: GPL-3\.0/);
  assert.equal(check(single(t, 'none', 'GPL-2.0 OR AGPL-3.0')).failures.length, 1);
  assert.deepEqual(check(single(t, 'nested', '(GPL-3.0 AND MIT) OR (Apache-2.0 AND BSD-3-Clause)')).failures, []);
  // MPL in an OR with nothing else allowed is still dev-only.
  assert.equal(check(single(t, 'mpl-or', 'MPL-2.0 OR GPL-3.0')).failures.length, 1);
  assert.deepEqual(check(single(t, 'mpl-or', 'MPL-2.0 OR GPL-3.0', { dev: true })).failures, []);
});

test('SPDX: WITH exceptions and "or later" are treated conservatively', (t) => {
  assert.match(check(single(t, 'llvm', 'Apache-2.0 WITH LLVM-exception')).failures[0].reason, /WITH/);
  assert.match(check(single(t, 'plus', 'Apache-2.0+')).failures[0].reason, /or later/);
  // but an OR branch without them still passes
  assert.deepEqual(check(single(t, 'dual', 'MIT OR Apache-2.0 WITH LLVM-exception')).failures, []);
  assert.throws(() => parseSpdx('MIT WITH'));
  assert.throws(() => parseSpdx('MIT or ISC'), /unexpected/);
  assert.deepEqual(parseSpdx('MIT OR ISC AND BSD-2-Clause'), {
    type: 'or',
    parts: [{ type: 'id', id: 'MIT', plus: false }, { type: 'and', parts: [{ type: 'id', id: 'ISC', plus: false }, { type: 'id', id: 'BSD-2-Clause', plus: false }] }],
  });
});

test('a lockfile entry missing from node_modules fails', (t) => {
  const dir = project(t, {
    packages: {
      'node_modules/present': { version: '1.0.0', license: 'MIT' },
      'node_modules/absent': { version: '2.0.0', license: 'MIT' },
      'node_modules/present/node_modules/nested-absent': { version: '3.0.0', license: 'MIT', dev: true },
    },
    installed: { 'node_modules/present': { name: 'present', version: '1.0.0', license: 'MIT' } },
  });
  const r = check(dir);
  assert.deepEqual(
    r.failures.map((f) => [`${f.name}@${f.version}`, f.path]),
    [
      ['absent@2.0.0', 'fixture/node_modules/absent'],
      ['nested-absent@3.0.0', 'fixture/node_modules/present/node_modules/nested-absent'],
    ],
  );
  for (const f of r.failures) assert.match(f.reason, /not in node_modules/);
});

test('optional packages skipped on this platform are reported and checked from the lockfile', (t) => {
  const dir = project(t, {
    packages: {
      'node_modules/bin-darwin': { version: '1.0.0', license: 'MIT', optional: true, os: ['darwin'], cpu: ['arm64'] },
      'node_modules/mpl-darwin': { version: '1.0.0', license: 'MPL-2.0', dev: true, optional: true, os: ['darwin'] },
      'node_modules/mpl-prod-darwin': { version: '1.0.0', license: 'MPL-2.0', optional: true, os: ['darwin'] },
      'node_modules/gpl-win': { version: '1.0.0', license: 'GPL-3.0', optional: true, os: ['win32'] },
      'node_modules/nolic-win': { version: '1.0.0', optional: true, os: ['win32'] },
      'node_modules/opt-peer': { version: '1.0.0', license: 'MIT', optional: true, peer: true, dev: true },
    },
  });
  const r = check(dir);
  assert.equal(r.optionalSkipped.length, 6);
  assert.match(r.optionalSkipped.find((s) => s.name === 'bin-darwin').reason, /os darwin, cpu arm64/);
  assert.match(r.optionalSkipped.find((s) => s.name === 'opt-peer').reason, /optional peer/);
  assert.deepEqual(r.failures.map((f) => f.name).sort(), ['gpl-win', 'mpl-prod-darwin', 'nolic-win']);
  assert.match(r.failures.find((f) => f.name === 'nolic-win').reason, /checked from the lockfile entry: no licence/);
});

test('the deprecated licenses array and license object forms work', (t) => {
  const forms = [
    [{ licenses: [{ type: 'MIT', url: 'https://example.invalid/mit' }] }, 'MIT', true],
    [{ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }, 'MIT OR Apache-2.0', true],
    [{ licenses: [{ type: 'GPL-3.0' }, { type: 'MIT' }] }, 'GPL-3.0 OR MIT', true],
    [{ licenses: ['BSD-3-Clause'] }, 'BSD-3-Clause', true],
    [{ licenses: [{ type: 'GPL-2.0' }] }, 'GPL-2.0', false],
    [{ licenses: [{ url: 'https://example.invalid' }] }, null, false],
    [{ licenses: [] }, null, false],
    [{ license: { type: 'ISC', url: 'https://example.invalid/isc' } }, 'ISC', true],
  ];
  for (const [fields, expression, ok] of forms) {
    assert.equal(licenceExpression(fields).expression, expression, JSON.stringify(fields));
    const dir = project(t, {
      packages: { 'node_modules/old': { version: '1.0.0' } },
      installed: { 'node_modules/old': { name: 'old', version: '1.0.0', ...fields } },
    });
    assert.equal(check(dir).failures.length, ok ? 0 : 1, JSON.stringify(fields));
  }
});

test('bundled packages on disk but not in the lockfile are walked and checked', (t) => {
  const dir = project(t, {
    packages: {
      'node_modules/aws-cdk-lib': { version: '2.0.0', license: 'Apache-2.0', bundleDependencies: ['listed', 'unlisted'] },
      'node_modules/aws-cdk-lib/node_modules/listed': { version: '1.0.0', license: 'MIT', inBundle: true },
      'node_modules/devtool': { version: '1.0.0', license: 'MIT', dev: true },
    },
    installed: {
      'node_modules/aws-cdk-lib': { name: 'aws-cdk-lib', version: '2.0.0', license: 'Apache-2.0' },
      'node_modules/aws-cdk-lib/node_modules/listed': { name: 'listed', version: '1.0.0', license: 'MIT' },
      'node_modules/aws-cdk-lib/node_modules/unlisted': { name: 'unlisted', version: '4.0.0', license: 'ISC' },
      'node_modules/aws-cdk-lib/node_modules/@scope/gpl-inside': { name: '@scope/gpl-inside', version: '5.0.0', license: 'GPL-3.0' },
      'node_modules/aws-cdk-lib/node_modules/@scope/mpl-inside': { name: '@scope/mpl-inside', version: '6.0.0', license: 'MPL-2.0' },
      'node_modules/devtool': { name: 'devtool', version: '1.0.0', license: 'MIT' },
      // inherits dev from devtool, so MPL-2.0 is fine here
      'node_modules/devtool/node_modules/mpl-dev-inside': { name: 'mpl-dev-inside', version: '7.0.0', license: 'MPL-2.0' },
    },
  });
  const r = check(dir);
  assert.equal(r.bundled, 1);
  assert.deepEqual(r.extras.map((e) => e.path).sort(), [
    'fixture/node_modules/aws-cdk-lib/node_modules/@scope/gpl-inside',
    'fixture/node_modules/aws-cdk-lib/node_modules/@scope/mpl-inside',
    'fixture/node_modules/aws-cdk-lib/node_modules/unlisted',
    'fixture/node_modules/devtool/node_modules/mpl-dev-inside',
  ]);
  assert.deepEqual(r.failures.map((f) => `${f.name}@${f.version}`).sort(), ['@scope/gpl-inside@5.0.0', '@scope/mpl-inside@6.0.0']);
});

test('a stale install (version differs from the lockfile) fails', (t) => {
  const dir = project(t, {
    packages: { 'node_modules/drift': { version: '2.0.0', license: 'MIT' } },
    installed: { 'node_modules/drift': { name: 'drift', version: '1.0.0', license: 'MIT' } },
  });
  assert.match(check(dir).failures[0].reason, /differs from the lockfile/);
});

test('a lockfile licence that differs from the installed one must pass too', (t) => {
  const dir = project(t, {
    packages: { 'node_modules/split': { version: '1.0.0', license: 'GPL-3.0' } },
    installed: { 'node_modules/split': { name: 'split', version: '1.0.0', license: 'MIT' } },
  });
  const r = check(dir);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].reason, /^lockfile licence: GPL-3\.0/);
});

test('missing node_modules or lockfile fails', (t) => {
  const dir = tempDir(t);
  assert.match(check(dir).failures[0].reason, /cannot read package-lock\.json/);
  writeJson(join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: {} });
  assert.match(check(dir).failures[0].reason, /npm ci/);
});

test('policy exceptions need a reason and an existing ADR, and match one exact version', (t) => {
  const repo = tempDir(t);
  writeFileSync(join(repo, 'placeholder'), '');
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', '0099-test-exception.md'), '# test\n');
  const base = { allowed: ['MIT'], devOnly: [], exceptions: [] };
  const write = (p) => {
    const file = join(repo, 'policy.json');
    writeJson(file, p);
    return file;
  };
  const exception = { package: 'odd', version: '1.0.0', licence: 'WTFPL', reason: 'test', adr: 'docs/decisions/0099-test-exception.md' };
  assert.throws(() => loadPolicy(write({ ...base, exceptions: [{ ...exception, reason: '' }] }), repo), /reason/);
  assert.throws(() => loadPolicy(write({ ...base, exceptions: [{ ...exception, adr: undefined }] }), repo), /adr/);
  assert.throws(() => loadPolicy(write({ ...base, exceptions: [{ ...exception, adr: 'docs/decisions/0100-missing.md' }] }), repo), /does not exist/);
  assert.throws(() => loadPolicy(write({ ...base, extra: true }), repo), /unknown key/);
  assert.throws(() => loadPolicy(write({ ...base, allowed: [] }), repo), /allowed/);
  const p = loadPolicy(write({ ...base, exceptions: [exception] }), repo);
  assert.equal(judgeLicence({ name: 'odd', version: '1.0.0', expression: 'WTFPL', dev: false }, p).ok, true);
  assert.equal(judgeLicence({ name: 'odd', version: '1.0.1', expression: 'WTFPL', dev: false }, p).ok, false);
  assert.equal(judgeLicence({ name: 'other', version: '1.0.0', expression: 'WTFPL', dev: false }, p).ok, false);
});

test('CLI: exits 1 and lists package@version licence path on a failure, 0 when clean', (t) => {
  const bad = project(t, {
    packages: {
      'node_modules/good': { version: '1.0.0', license: 'MIT' },
      'node_modules/gpl-pkg': { version: '3.1.4', license: 'GPL-3.0' },
    },
    installed: {
      'node_modules/good': { name: 'good', version: '1.0.0', license: 'MIT' },
      'node_modules/gpl-pkg': { name: 'gpl-pkg', version: '3.1.4', license: 'GPL-3.0' },
    },
  });
  const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  const failed = run(bad);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, new RegExp(`FAIL gpl-pkg@3\\.1\\.4 "GPL-3\\.0" ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node_modules/gpl-pkg: `));
  assert.match(failed.stdout, /summary: 2 lockfile entries; 2 installed and checked .* 1 failure\(s\)/);
  assert.match(failed.stdout, /check-licences: FAILED/);
  const ok = run(single(t, 'fine', 'ISC'));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /check-licences: ok/);
  assert.equal(resolve(script), join(here, 'check-licences.mjs'));
});
