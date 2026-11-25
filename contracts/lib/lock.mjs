// Immutability lock for published vocabulary versions.
//
// A published version `v<N>/` has a committed lock file `v<N>.lock.json`
// next to it, holding the sha256 of every file in the directory. The tests
// compare the lock with the files on disk, so any edit, addition or removal
// in a published version fails, and so does a published version without a
// lock. Comparison is split from file access so tests can feed in-memory
// fixtures to the same code.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOCABULARY_DIR, loadVocabulary } from './vocabulary.mjs';

export const LOCK_ALGORITHM = 'sha256';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_FILE_PATTERN = /^v([1-9][0-9]*)\.lock\.json$/;

export const lockFileName = (version) => `v${version}.lock.json`;
export const lockPath = (version, vocabularyDir = VOCABULARY_DIR) => join(vocabularyDir, lockFileName(version));

/**
 * sha256 of the canonical bytes of a file: the raw bytes with every CRLF
 * turned into LF, so a checkout with Windows line endings hashes the same.
 * No other normalisation: a changed space or key order is a change.
 */
export function canonicalHash(bytes) {
  const canonical = Buffer.from(Buffer.from(bytes).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash(LOCK_ALGORITHM).update(canonical).digest('hex');
}

/** `{ <file name>: hash }` for every entry of one version directory, sorted. */
export function hashVersion(version, vocabularyDir = VOCABULARY_DIR) {
  const dir = join(vocabularyDir, `v${version}`);
  const hashes = {};
  for (const name of readdirSync(dir).sort()) hashes[name] = canonicalHash(readFileSync(join(dir, name)));
  return hashes;
}

/** True if any file of the version says `published`. */
export function isPublished(files) {
  return Object.values(files).some((file) => file?.status === 'published');
}

/** The lock object for a version as it is on disk now. */
export function buildLock(version, hashes) {
  return { version, algorithm: LOCK_ALGORITHM, files: hashes };
}

/**
 * Compares one version with its lock. `lock` is the parsed lock file or
 * `undefined` if there is none; `hashes` comes from `hashVersion`.
 * Problems: a published version without a lock, a malformed lock, and every
 * file that was changed, added or removed since the lock was written.
 */
export function compareLock(version, { published, hashes, lock }) {
  const name = lockFileName(version);
  if (lock === undefined) {
    return published ? [`v${version}: marked published but has no ${name}`] : [];
  }
  const problems = [];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return [`${name}: not an object`];
  if (lock.version !== version) problems.push(`${name}: version ${JSON.stringify(lock.version)} is not ${version}`);
  if (lock.algorithm !== LOCK_ALGORITHM) problems.push(`${name}: algorithm is not ${LOCK_ALGORITHM}`);
  const locked = lock.files;
  if (locked === null || typeof locked !== 'object' || Array.isArray(locked) || Object.keys(locked).length === 0) {
    problems.push(`${name}: "files" is missing or empty`);
    return problems;
  }
  for (const key of Object.keys(lock)) {
    if (!['version', 'algorithm', 'files'].includes(key)) problems.push(`${name}: unknown key ${key}`);
  }
  if (!published) problems.push(`v${version}: has ${name} but is not marked published`);
  for (const [file, hash] of Object.entries(locked)) {
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) problems.push(`${name}: hash of ${file} is malformed`);
    else if (!(file in hashes)) problems.push(`v${version}/${file}: removed from a published version`);
    else if (hashes[file] !== hash) problems.push(`v${version}/${file}: changed in a published version`);
  }
  for (const file of Object.keys(hashes)) {
    if (!(file in locked)) problems.push(`v${version}/${file}: added to a published version`);
  }
  return problems;
}

function readLock(version, vocabularyDir) {
  const path = lockPath(version, vocabularyDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** Checks one version directory on disk against its lock file. */
export function checkLock(version, vocabularyDir = VOCABULARY_DIR) {
  return compareLock(version, {
    published: isPublished(loadVocabulary(version, vocabularyDir)),
    hashes: hashVersion(version, vocabularyDir),
    lock: readLock(version, vocabularyDir),
  });
}

/** A lock file whose version directory is gone: the whole version was removed. */
export function checkOrphanLocks(versions, vocabularyDir = VOCABULARY_DIR) {
  const problems = [];
  for (const name of readdirSync(vocabularyDir).sort()) {
    const match = LOCK_FILE_PATTERN.exec(name);
    if (match && !versions.includes(Number(match[1]))) problems.push(`${name}: version v${match[1]} was removed`);
  }
  return problems;
}

/**
 * Writes the lock for a version. Used once, when a version is published.
 * Refuses if a lock already exists (a published version is immutable) or
 * if the version is not marked published in every file.
 */
export function writeLock(version, vocabularyDir = VOCABULARY_DIR) {
  const path = lockPath(version, vocabularyDir);
  if (existsSync(path)) throw new Error(`${lockFileName(version)} exists; a published version is never edited`);
  const files = loadVocabulary(version, vocabularyDir);
  if (!Object.values(files).every((file) => file?.status === 'published')) {
    throw new Error(`v${version}: set "status": "published" in every file first`);
  }
  writeFileSync(path, `${JSON.stringify(buildLock(version, hashVersion(version, vocabularyDir)), null, 2)}\n`);
  return path;
}
