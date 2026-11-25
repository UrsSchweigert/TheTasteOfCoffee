#!/usr/bin/env node
// Checks the licence of every npm package in the contracts, backend and infra
// lockfiles against scripts/licence-policy.json (backlog M0-T10). It guards
// the Dependabot npm updates (M0-T8), which can bring in new transitive
// dependencies. A licence that is not permissive needs the owner (CLAUDE.md).
//
// Run it after `npm ci` in each project. For every package entry in
// package-lock.json:
// - the licence is read from the installed package.json in node_modules
//   (`license`, the deprecated `license` object, or the deprecated `licenses`
//   array, which npm documents as an OR of its items). If the lockfile entry
//   also names a licence and it differs, that one must pass as well;
// - an entry that is not installed fails, with one documented exception:
//   `optional: true` entries npm skipped on this machine (another os or cpu,
//   or an optional peer dependency nobody asked for). They are reported, and
//   their licence comes from the lockfile entry; without one they fail;
// - the installed version must match the lockfile (a stale install fails).
// Packages on disk that the lockfile does not list (for example bundled
// dependencies a lockfile might omit, such as aws-cdk-lib/node_modules/*) are
// found by walking every nested node_modules and checked the same way.
//
// Policy: an SPDX id on the allowlist passes. A `devOnly` licence (MPL-2.0,
// ADR 0008) passes only when the lockfile entry is `dev: true`; `devOptional`
// does not count as dev, because the package is in the production tree.
// SPDX expressions: OR passes if any branch passes, AND needs every part,
// `WITH` exceptions and `+` (or later) fail until reviewed. Missing, unknown,
// UNLICENSED, `SEE LICENSE IN` and unparseable licences fail. A per-package
// exception lives only in the policy file, for one exact version, with a
// reason and an ADR.
//
// No dependencies; needs Node 22.
// Usage: node scripts/check-licences.mjs [--policy <file>] [project-dir ...]
//   default projects: contracts backend infra
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_POLICY = join(root, 'scripts', 'licence-policy.json');
export const DEFAULT_PROJECTS = ['contracts', 'backend', 'infra'];

const ADR_PATH = /^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
}

/**
 * Reads and validates the policy. Throws on anything malformed, so a typo
 * cannot quietly widen it.
 * @param {string} file
 * @param {string} repoRoot ADR paths are resolved against this directory
 */
export function loadPolicy(file = DEFAULT_POLICY, repoRoot = root) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`policy ${file}: cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw)) throw new Error(`policy ${file}: top level is not an object`);
  checkKeys(raw, ['$comment', 'allowed', 'devOnly', 'exceptions'], `policy ${file}`);
  const { allowed, devOnly = [], exceptions = [] } = raw;
  if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(nonEmptyString)) {
    throw new Error(`policy ${file}: "allowed" must be a non-empty list of SPDX ids`);
  }
  const adrExists = (adr, where) => {
    if (!nonEmptyString(adr) || !ADR_PATH.test(adr)) throw new Error(`${where}: "adr" must be a path like docs/decisions/0008-name.md`);
    if (!existsSync(join(repoRoot, adr))) throw new Error(`${where}: ADR ${adr} does not exist`);
  };
  if (!Array.isArray(devOnly)) throw new Error(`policy ${file}: "devOnly" must be a list`);
  devOnly.forEach((d, i) => {
    const where = `policy ${file}: devOnly[${i}]`;
    if (!isObject(d)) throw new Error(`${where}: not an object`);
    checkKeys(d, ['licence', 'adr', 'reason'], where);
    if (!nonEmptyString(d.licence) || !nonEmptyString(d.reason)) throw new Error(`${where}: needs "licence" and "reason"`);
    adrExists(d.adr, where);
  });
  if (!Array.isArray(exceptions)) throw new Error(`policy ${file}: "exceptions" must be a list`);
  exceptions.forEach((e, i) => {
    const where = `policy ${file}: exceptions[${i}]`;
    if (!isObject(e)) throw new Error(`${where}: not an object`);
    checkKeys(e, ['package', 'version', 'licence', 'reason', 'adr'], where);
    for (const key of ['package', 'version', 'licence', 'reason']) {
      if (!nonEmptyString(e[key])) throw new Error(`${where}: needs a non-empty "${key}"`);
    }
    adrExists(e.adr, where);
  });
  return {
    allowed: new Set(allowed.map((id) => id.toLowerCase())),
    devOnly: new Map(devOnly.map((d) => [d.licence.toLowerCase(), d])),
    exceptions,
  };
}

// ---------------------------------------------------------------------------
// SPDX expressions

/**
 * Parses an SPDX licence expression into a tree. Throws when unparseable.
 * Operators are case-sensitive (SPDX 2.3, annex D); ids are compared
 * case-insensitively.
 * @param {string} text
 */
export function parseSpdx(text) {
  const tokens = [];
  const re = /\s*(\(|\)|[A-Za-z0-9.:+-]+)\s*/y;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) throw new Error(`unexpected character at ${pos}`);
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  if (tokens.length === 0) throw new Error('empty expression');
  let i = 0;
  const peek = () => tokens[i];
  const operator = (t) => t === 'AND' || t === 'OR' || t === 'WITH';

  function atom() {
    const t = tokens[i++];
    if (t === undefined) throw new Error('expression ends early');
    if (t === '(') {
      const inner = orExpr();
      if (tokens[i++] !== ')') throw new Error('missing ")"');
      return inner;
    }
    if (t === ')' || operator(t)) throw new Error(`unexpected "${t}"`);
    const plus = t.endsWith('+');
    const id = plus ? t.slice(0, -1) : t;
    if (!/^[A-Za-z0-9.:-]+$/.test(id)) throw new Error(`bad licence id "${t}"`);
    if (peek() === 'WITH') {
      i++;
      const exception = tokens[i++];
      if (exception === undefined || exception === '(' || exception === ')' || operator(exception)) {
        throw new Error('WITH needs an exception id');
      }
      return { type: 'with', id, plus, exception };
    }
    return { type: 'id', id, plus };
  }
  function andExpr() {
    const parts = [atom()];
    while (peek() === 'AND') {
      i++;
      parts.push(atom());
    }
    return parts.length === 1 ? parts[0] : { type: 'and', parts };
  }
  function orExpr() {
    const parts = [andExpr()];
    while (peek() === 'OR') {
      i++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { type: 'or', parts };
  }
  const tree = orExpr();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return tree;
}

/**
 * @param {ReturnType<typeof parseSpdx>} node
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {{ dev: boolean }} ctx
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateSpdx(node, policy, ctx) {
  switch (node.type) {
    case 'id': {
      const key = node.id.toLowerCase();
      if (node.plus) return { ok: false, reason: `${node.id}+ ("or later") is not on the allowlist` };
      if (policy.allowed.has(key)) return { ok: true, reason: `${node.id} is allowed` };
      const devRule = policy.devOnly.get(key);
      if (devRule) {
        return ctx.dev
          ? { ok: true, reason: `${node.id} is allowed for dev dependencies (${devRule.adr})` }
          : { ok: false, reason: `${node.id} is allowed only for dev dependencies (${devRule.adr}); this one is not dev` };
      }
      return { ok: false, reason: `${node.id} is not on the allowlist` };
    }
    case 'with':
      return { ok: false, reason: `"${node.id} WITH ${node.exception}" needs review (WITH exceptions are not allowed by default)` };
    case 'and': {
      const results = node.parts.map((p) => evaluateSpdx(p, policy, ctx));
      const bad = results.find((r) => !r.ok);
      return bad ? { ok: false, reason: `AND: ${bad.reason}` } : { ok: true, reason: results.map((r) => r.reason).join('; ') };
    }
    case 'or': {
      const results = node.parts.map((p) => evaluateSpdx(p, policy, ctx));
      const good = results.find((r) => r.ok);
      return good ? { ok: true, reason: `OR: ${good.reason}` } : { ok: false, reason: `no OR branch is allowed (${results.map((r) => r.reason).join('; ')})` };
    }
    default:
      return { ok: false, reason: 'unparseable' };
  }
}

// ---------------------------------------------------------------------------
// Licence fields

function typeOf(item) {
  if (nonEmptyString(item)) return item.trim();
  if (isObject(item) && nonEmptyString(item.type)) return item.type.trim();
  return null;
}

/**
 * Turns a package.json (or lockfile entry) licence into one expression string.
 * Returns null when there is none; `problem` is set when it is malformed.
 * @param {{ license?: unknown, licenses?: unknown }} pkg
 * @returns {{ expression: string | null, problem?: string }}
 */
export function licenceExpression(pkg) {
  if (pkg.license !== undefined && pkg.license !== null) {
    const t = typeOf(pkg.license);
    return t === null ? { expression: null, problem: `malformed "license" field ${JSON.stringify(pkg.license)}` } : { expression: t };
  }
  if (pkg.licenses !== undefined && pkg.licenses !== null) {
    const items = Array.isArray(pkg.licenses) ? pkg.licenses : [pkg.licenses];
    const types = items.map(typeOf);
    if (types.length === 0 || types.includes(null)) {
      return { expression: null, problem: `malformed "licenses" field ${JSON.stringify(pkg.licenses)}` };
    }
    // npm documents the deprecated array as dual licensing: an OR of its items.
    const parts = types.map((t) => (/\s/.test(t) ? `(${t})` : t));
    return { expression: parts.length === 1 ? types[0] : parts.join(' OR ') };
  }
  return { expression: null };
}

/**
 * Judges one licence expression for one package.
 * @param {{ name: string, version: string, expression: string | null, problem?: string, dev: boolean }} p
 * @param {ReturnType<typeof loadPolicy>} policy
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeLicence({ name, version, expression, problem, dev }, policy) {
  const exception = policy.exceptions.find((e) => e.package === name && e.version === version && e.licence === expression);
  if (exception) return { ok: true, reason: `policy exception: ${exception.reason} (${exception.adr})` };
  if (problem) return { ok: false, reason: problem };
  if (expression === null) return { ok: false, reason: 'no licence' };
  if (/^SEE LICEN[CS]E IN\b/i.test(expression)) return { ok: false, reason: 'custom licence ("SEE LICENSE IN"), needs review' };
  if (/^UNLICENSED$/i.test(expression)) return { ok: false, reason: 'UNLICENSED: no licence is granted' };
  let tree;
  try {
    tree = parseSpdx(expression);
  } catch (err) {
    return { ok: false, reason: `unparseable SPDX expression (${err instanceof Error ? err.message : String(err)})` };
  }
  return evaluateSpdx(tree, policy, { dev });
}

// ---------------------------------------------------------------------------
// Lockfile and node_modules

function nameFromKey(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function platformMatches(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const negated = list.filter((x) => typeof x === 'string' && x.startsWith('!')).map((x) => x.slice(1));
  const positive = list.filter((x) => typeof x === 'string' && !x.startsWith('!'));
  if (negated.includes(value)) return false;
  return positive.length === 0 || positive.includes(value);
}

function skipReason(entry, platform, arch) {
  const why = [];
  if (!platformMatches(entry.os, platform)) why.push(`os ${entry.os.join(',')}`);
  if (!platformMatches(entry.cpu, arch)) why.push(`cpu ${entry.cpu.join(',')}`);
  if (why.length > 0) return `not for this platform (${why.join(', ')})`;
  return entry.peer === true ? 'optional peer dependency, not installed' : 'optional dependency, not installed';
}

/** Keys (lockfile style, `node_modules/a/node_modules/@s/b`) of every package directory on disk. */
function installedKeys(projectDir) {
  const found = new Set();
  const visit = (abs, key) => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      found.add(key); // a workspace link; never followed
      return;
    }
    if (!st.isDirectory()) return;
    if (existsSync(join(abs, 'package.json'))) found.add(key);
    walk(abs, `${key}/`);
  };
  const walk = (dir, prefix) => {
    const nm = join(dir, 'node_modules');
    let names;
    try {
      names = readdirSync(nm);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue; // .bin, .package-lock.json, caches
      if (name.startsWith('@')) {
        let subs;
        try {
          subs = readdirSync(join(nm, name));
        } catch {
          continue;
        }
        for (const sub of subs.sort()) {
          if (!sub.startsWith('.')) visit(join(nm, name, sub), `${prefix}node_modules/${name}/${sub}`);
        }
      } else {
        visit(join(nm, name), `${prefix}node_modules/${name}`);
      }
    }
  };
  walk(projectDir, '');
  return found;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Checks one project directory (with package-lock.json and node_modules).
 * @param {string} projectDir
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {{ label?: string, platform?: string, arch?: string }} [options]
 */
export function checkProject(projectDir, policy, { label = projectDir, platform = process.platform, arch = process.arch } = {}) {
  const result = {
    lockfile: `${label}/package-lock.json`,
    entries: 0,
    installed: 0,
    bundled: 0,
    links: 0,
    /** @type {{ name: string, version: string, licence: string, path: string, reason: string }[]} */
    optionalSkipped: [],
    /** @type {{ name: string, version: string, licence: string, path: string }[]} */
    extras: [],
    /** @type {{ name: string, version: string, licence: string, path: string, reason: string }[]} */
    failures: [],
    /** @type {string[]} */
    notes: [],
  };
  const fail = (name, version, licence, key, reason) =>
    result.failures.push({ name, version, licence: licence ?? '(none)', path: key ? `${label}/${key}` : label, reason });

  const lockPath = join(projectDir, 'package-lock.json');
  let lock;
  try {
    lock = readJson(lockPath);
  } catch (err) {
    fail('(lockfile)', '-', null, '', `cannot read package-lock.json: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (!isObject(lock.packages)) {
    fail('(lockfile)', '-', null, 'package-lock.json', 'no "packages" section (lockfile v2 or v3 needed)');
    return result;
  }
  if (!existsSync(join(projectDir, 'node_modules'))) {
    fail('(node_modules)', '-', null, 'node_modules', "node_modules is missing: run 'npm ci' first");
    return result;
  }
  const packages = lock.packages;

  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue; // the project itself
    if (!isObject(entry)) {
      fail(key, '-', null, key, 'lockfile entry is not an object');
      continue;
    }
    result.entries++;
    if (!key.split('/').includes('node_modules')) {
      result.notes.push(`${label}/${key}: workspace source in this repository, not a dependency; skipped`);
      continue;
    }
    const name = nonEmptyString(entry.name) ? entry.name : nameFromKey(key);
    const version = nonEmptyString(entry.version) ? entry.version : '(no version)';
    const dev = entry.dev === true;
    const lockLicence = licenceExpression(entry);

    if (entry.link === true) {
      result.links++;
      if (!nonEmptyString(entry.resolved) || !isObject(packages[entry.resolved])) {
        fail(name, version, null, key, `link target ${entry.resolved ?? '(none)'} is not in the lockfile`);
      }
      continue; // the target is checked as its own entry
    }

    const pkgFile = join(projectDir, key, 'package.json');
    if (existsSync(pkgFile)) {
      result.installed++;
      if (entry.inBundle === true) result.bundled++;
      let pkg;
      try {
        pkg = readJson(pkgFile);
      } catch (err) {
        fail(name, version, null, key, `cannot read installed package.json: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (nonEmptyString(entry.version) && pkg.version !== entry.version) {
        fail(name, version, lockLicence.expression, key, `installed version ${pkg.version} differs from the lockfile: run 'npm ci'`);
        continue;
      }
      const installed = licenceExpression(pkg);
      const verdict = judgeLicence({ name, version, ...installed, dev }, policy);
      if (!verdict.ok) {
        fail(name, version, installed.expression, key, verdict.reason);
        continue;
      }
      if (lockLicence.expression !== null && lockLicence.expression !== installed.expression) {
        result.notes.push(`${label}/${key}: lockfile licence "${lockLicence.expression}" differs from installed "${installed.expression}"; both checked`);
        const lockVerdict = judgeLicence({ name, version, ...lockLicence, dev }, policy);
        if (!lockVerdict.ok) fail(name, version, lockLicence.expression, key, `lockfile licence: ${lockVerdict.reason}`);
      }
      continue;
    }

    if (entry.optional === true) {
      const skipped = { name, version, licence: lockLicence.expression ?? '(none)', path: `${label}/${key}`, reason: skipReason(entry, platform, arch) };
      result.optionalSkipped.push(skipped);
      const verdict = judgeLicence({ name, version, ...lockLicence, dev }, policy);
      if (!verdict.ok) {
        fail(name, version, lockLicence.expression, key, `${skipped.reason}, so checked from the lockfile entry: ${verdict.reason}`);
      }
      continue;
    }

    fail(name, version, lockLicence.expression, key, "in the lockfile but not in node_modules: run 'npm ci'");
  }

  // Anything on disk that the lockfile does not list, for example a bundled
  // dependency an older lockfile omitted. Dev status comes from the nearest
  // enclosing lockfile entry; with none it counts as not dev.
  for (const key of installedKeys(projectDir)) {
    if (Object.hasOwn(packages, key)) continue;
    let dev = false;
    for (let parent = key; parent.includes('/node_modules/'); ) {
      parent = parent.slice(0, parent.lastIndexOf('/node_modules/'));
      if (isObject(packages[parent])) {
        dev = packages[parent].dev === true;
        break;
      }
    }
    let pkg;
    try {
      pkg = readJson(join(projectDir, key, 'package.json'));
    } catch (err) {
      fail(nameFromKey(key), '-', null, key, `on disk but not in the lockfile, and package.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const name = nonEmptyString(pkg.name) ? pkg.name : nameFromKey(key);
    const version = nonEmptyString(pkg.version) ? pkg.version : '(no version)';
    const lic = licenceExpression(pkg);
    result.extras.push({ name, version, licence: lic.expression ?? '(none)', path: `${label}/${key}` });
    const verdict = judgeLicence({ name, version, ...lic, dev }, policy);
    if (!verdict.ok) fail(name, version, lic.expression, key, `on disk but not in the lockfile: ${verdict.reason}`);
  }
  return result;
}

/** Human-readable report lines for one project result. */
export function formatResult(r) {
  const lines = [`check-licences: ${r.lockfile}`];
  for (const f of r.failures) lines.push(`  FAIL ${f.name}@${f.version} "${f.licence}" ${f.path}: ${f.reason}`);
  for (const s of r.optionalSkipped) lines.push(`  optional, not installed here (${s.reason}), licence from lockfile: ${s.name}@${s.version} "${s.licence}" ${s.path}`);
  for (const e of r.extras) lines.push(`  on disk, not in the lockfile: ${e.name}@${e.version} "${e.licence}" ${e.path}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  lines.push(
    `  summary: ${r.entries} lockfile entries; ${r.installed} installed and checked (${r.bundled} bundled), ` +
      `${r.optionalSkipped.length} optional not installed (checked from lockfile), ${r.links} links, ` +
      `${r.extras.length} on disk but not in the lockfile; ${r.failures.length} failure(s)`,
  );
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  let policyFile = DEFAULT_POLICY;
  const projects = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--policy') {
      policyFile = args[++i];
      if (!policyFile) {
        console.error('check-licences: --policy needs a file');
        process.exit(1);
      }
    } else {
      projects.push(args[i]);
    }
  }
  let policy;
  try {
    policy = loadPolicy(policyFile);
  } catch (err) {
    console.error(`check-licences: FAILED. ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const targets = projects.length > 0 ? projects.map((p) => ({ dir: resolve(p), label: p.replace(/\/+$/, '') || '.' })) : DEFAULT_PROJECTS.map((p) => ({ dir: join(root, p), label: p }));
  const inGitHub = process.env.GITHUB_ACTIONS === 'true';
  let failures = 0;
  for (const { dir, label } of targets) {
    const r = checkProject(dir, policy, { label });
    for (const line of formatResult(r)) console.log(line);
    failures += r.failures.length;
    if (inGitHub) {
      for (const f of r.failures) console.log(`::error title=Licence check::${f.name}@${f.version} "${f.licence}" ${f.path}: ${f.reason}`);
    }
  }
  console.log(failures === 0 ? 'check-licences: ok' : `check-licences: FAILED (${failures} failure(s)). A licence outside the policy needs the owner (CLAUDE.md); do not add an exception without an ADR.`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
