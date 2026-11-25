import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLock,
  canonicalHash,
  checkLock,
  checkOrphanLocks,
  compareLock,
  hashVersion,
  lockPath,
  writeLock,
} from '../lib/lock.mjs';
import { VOCABULARY_DIR, checkVersionEntries, listVersions, loadVocabulary } from '../lib/vocabulary.mjs';

const versions = listVersions();

// ---- The real files. ----

for (const version of versions) {
  test(`v${version}: matches its lock if it has one, and has one if it is published`, () => {
    assert.deepEqual(checkLock(version), []);
  });
}

test('no lock file is left without its version directory', () => {
  assert.deepEqual(checkOrphanLocks(versions), []);
});

test('v2 is published and locked (owner-approved on 2026-11-25, ADR 0011)', () => {
  assert.ok(versions.includes(2));
  assert.deepEqual(Object.values(loadVocabulary(2)).map((file) => file.status).filter((s) => s !== 'published'), []);
  const lock = JSON.parse(readFileSync(lockPath(2), 'utf8'));
  assert.deepEqual(Object.keys(lock.files), Object.keys(loadVocabulary(2)).map((name) => `${name}.json`));
});

test('v1 is published and locked', () => {
  const lock = JSON.parse(readFileSync(lockPath(1), 'utf8'));
  assert.deepEqual(Object.keys(lock.files), Object.keys(loadVocabulary(1)).map((name) => `${name}.json`));
});

// ---- The checks themselves must be able to fail. ----

/** A temp copy of the real vocabulary directory (v<N>/ and locks). */
function tempVocabulary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cupmark-vocabulary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(VOCABULARY_DIR, dir, { recursive: true });
  return dir;
}

test('temp copy of the real vocabulary passes, so the failures below are caused by the change', (t) => {
  const dir = tempVocabulary(t);
  assert.deepEqual(checkLock(1, dir), []);
});

test('lock check fails: a file of a published version is changed', (t) => {
  const dir = tempVocabulary(t);
  const file = join(dir, 'v1', 'bean.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"washed"', '"wet_processed"'));
  assert.deepEqual(checkLock(1, dir), ['v1/bean.json: changed in a published version']);
});

test('lock check fails: whitespace-only edit is still a change', (t) => {
  const dir = tempVocabulary(t);
  const file = join(dir, 'v1', 'shelf.json');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
  assert.deepEqual(checkLock(1, dir), ['v1/shelf.json: changed in a published version']);
});

test('lock check fails: a file is added to a published version', (t) => {
  const dir = tempVocabulary(t);
  writeFileSync(join(dir, 'v1', 'zz_test_fixture.json'), '{ "version": 1, "status": "published" }\n');
  assert.deepEqual(checkLock(1, dir), ['v1/zz_test_fixture.json: added to a published version']);
});

test('lock check fails: a file is removed from a published version', (t) => {
  const dir = tempVocabulary(t);
  rmSync(join(dir, 'v1', 'criteria.json'));
  assert.deepEqual(checkLock(1, dir), ['v1/criteria.json: removed from a published version']);
});

test('lock check fails: a published version is set back to draft', (t) => {
  const dir = tempVocabulary(t);
  for (const name of ['bean', 'brew', 'criteria', 'flavour_notes', 'shelf']) {
    const file = join(dir, 'v1', `${name}.json`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"status": "published"', '"status": "draft"'));
  }
  const problems = checkLock(1, dir);
  assert.ok(problems.includes('v1: has v1.lock.json but is not marked published'));
  assert.ok(problems.includes('v1/bean.json: changed in a published version'));
});

test('lock check fails: a published version has no lock', (t) => {
  const dir = tempVocabulary(t);
  rmSync(lockPath(1, dir));
  assert.deepEqual(checkLock(1, dir), ['v1: marked published but has no v1.lock.json']);
});

test('lock check fails: one published file in a draft version still needs a lock', () => {
  assert.deepEqual(compareLock(2, { published: true, hashes: { 'a.json': 'x' }, lock: undefined }), [
    'v2: marked published but has no v2.lock.json',
  ]);
});

test('lock check passes: a draft version needs no lock', () => {
  assert.deepEqual(compareLock(2, { published: false, hashes: { 'a.json': 'x' }, lock: undefined }), []);
});

test('lock check fails: the lock itself is edited or malformed', () => {
  const hashes = hashVersion(1);
  const good = buildLock(1, hashes);
  const check = (lock) => compareLock(1, { published: true, hashes, lock });
  assert.deepEqual(check(good), []);
  assert.deepEqual(check({ ...good, version: 2 }), ['v1.lock.json: version 2 is not 1']);
  assert.deepEqual(check({ ...good, algorithm: 'md5' }), ['v1.lock.json: algorithm is not sha256']);
  assert.deepEqual(check({ ...good, files: {} }), ['v1.lock.json: "files" is missing or empty']);
  assert.deepEqual(check({ ...good, note: 'x' }), ['v1.lock.json: unknown key note']);
  assert.deepEqual(check({ ...good, files: { ...hashes, 'bean.json': 'abc' } }), ['v1.lock.json: hash of bean.json is malformed']);
  assert.deepEqual(check([]), ['v1.lock.json: not an object']);
  // A file dropped from the lock reads as a file added to the version.
  const { 'bean.json': _bean, ...withoutBean } = hashes;
  assert.deepEqual(check({ ...good, files: withoutBean }), ['v1/bean.json: added to a published version']);
});

test('lock check fails: a lock whose version directory was removed', (t) => {
  const dir = tempVocabulary(t);
  rmSync(join(dir, 'v1'), { recursive: true });
  assert.deepEqual(checkOrphanLocks(listVersions(dir), dir), ['v1.lock.json: version v1 was removed']);
});

test('line endings: CRLF hashes like LF, so a Windows checkout does not fail the lock', (t) => {
  assert.equal(canonicalHash(Buffer.from('{\r\n  "a": 1\r\n}\r\n')), canonicalHash(Buffer.from('{\n  "a": 1\n}\n')));
  assert.notEqual(canonicalHash(Buffer.from('{"a": 1}\n')), canonicalHash(Buffer.from('{"a": 2}\n')));
  const dir = tempVocabulary(t);
  const file = join(dir, 'v1', 'brew.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(checkLock(1, dir), []);
});

test('writeLock refuses to overwrite a lock and to lock a draft version', (t) => {
  const dir = tempVocabulary(t);
  assert.throws(() => writeLock(1, dir), /exists; a published version is never edited/);
  const next = Math.max(...listVersions(dir)) + 1;
  mkdirSync(join(dir, `v${next}`));
  writeFileSync(join(dir, `v${next}`, 'bean.json'), `{ "version": ${next}, "status": "draft" }\n`);
  assert.throws(() => writeLock(next, dir), /set "status": "published" in every file first/);
  writeFileSync(join(dir, `v${next}`, 'bean.json'), `{ "version": ${next}, "status": "published" }\n`);
  writeLock(next, dir);
  assert.deepEqual(checkLock(next, dir), []);
});

test('writeLock refuses a version with one file still draft', (t) => {
  // A next version copied from the latest one, as "Publishing a version" step 1 says.
  const dir = tempVocabulary(t);
  const latest = Math.max(...listVersions(dir));
  const next = latest + 1;
  cpSync(join(dir, `v${latest}`), join(dir, `v${next}`), { recursive: true });
  for (const name of Object.keys(loadVocabulary(next, dir))) {
    const file = join(dir, `v${next}`, `${name}.json`);
    writeFileSync(file, readFileSync(file, 'utf8')
      .replace(`"version": ${latest}`, `"version": ${next}`)
      .replace('"status": "published"', '"status": "draft"'));
  }
  assert.deepEqual(checkLock(next, dir), [], 'a draft needs no lock');
  const file = join(dir, `v${next}`, 'bean.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"status": "draft"', '"status": "published"'));
  assert.throws(() => writeLock(next, dir), /set "status": "published" in every file first/);
  // And the half-published state is itself a failure until it is locked.
  assert.deepEqual(checkLock(next, dir), [`v${next}: marked published but has no v${next}.lock.json`]);
});

test('lock check fails: a file of v2 is changed after publishing', (t) => {
  const dir = tempVocabulary(t);
  const file = join(dir, 'v2', 'bean.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"country": "usa"', '"country": "mexico"'));
  assert.deepEqual(checkLock(2, dir), ['v2/bean.json: changed in a published version']);
});

// ---- Unexpected entries in a version directory. ----

test('directory check fails: subdirectory, non-.json file, hidden file, bad name, symlink', (t) => {
  const dir = tempVocabulary(t);
  const v1 = join(dir, 'v1');
  mkdirSync(join(v1, 'zz_test_fixture'));
  writeFileSync(join(v1, 'zz_test_fixture.yaml'), 'x: 1\n');
  writeFileSync(join(v1, '.DS_Store'), '');
  writeFileSync(join(v1, 'Bad-Name.json'), '{}\n');
  symlinkSync(join(v1, 'bean.json'), join(v1, 'zz_link.json'));
  assert.deepEqual(checkVersionEntries(1, dir), [
    'v1/.DS_Store: unexpected entry, only <name>.json files belong here',
    'v1/Bad-Name.json: unexpected entry, only <name>.json files belong here',
    'v1/zz_link.json: unexpected entry, only <name>.json files belong here',
    'v1/zz_test_fixture.yaml: unexpected entry, only <name>.json files belong here',
    'v1/zz_test_fixture: unexpected entry, only <name>.json files belong here',
  ]);
  assert.throws(() => loadVocabulary(1, dir), /unexpected entry/);
});
