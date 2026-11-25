#!/usr/bin/env node
// Checks that the GitHub Actions workflows stay safe (backlog M0-T5).
//
// Rules, per workflow file:
// - every `uses:` is pinned to a full 40-hex commit SHA (local `./` actions and
//   `docker://...@sha256:<digest>` images are allowed), with the version in a
//   trailing comment (`# v6.1.0`);
// - no `pull_request_target` trigger;
// - top-level `permissions` is present and grants no write scope;
// - every job has `timeout-minutes` (reusable-workflow call jobs excepted);
// - `actions/checkout` runs with `persist-credentials: false`.
// Strict files (ci.yml) additionally must have top-level permissions of exactly
// `contents: read`, no job-level permissions, and no reference to secrets.
//
// Strict files fail the run (exit 1). Every other workflow file is reported as
// advisory only (exit 0), so pre-existing workflows are listed as follow-ups.
//
// Needs Node 22 and `npm ci` in contracts/ (for the `yaml` package).
// Usage: node scripts/check-workflows.mjs [workflow-dir]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STRICT_FILES = new Set(['ci.yml']);

function loadYaml() {
  const contractsPkg = join(root, 'contracts', 'package.json');
  try {
    return createRequire(contractsPkg)('yaml');
  } catch {
    console.error("check-workflows: FAILED. Run 'npm ci' in contracts/ first (needs the yaml package)");
    process.exit(1);
  }
}

const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const SECRETS_EXPR = /\$\{\{[^}]*\bsecrets\b[^}]*\}\}/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function triggers(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isObject(on)) return Object.keys(on);
  return [];
}

function writeScopes(permissions) {
  if (permissions === 'write-all') return ['write-all'];
  if (!isObject(permissions)) return [];
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => `${scope}: write`);
}

function checkUses(ref, where, lines, findings) {
  if (typeof ref !== 'string') {
    findings.push(`${where}: uses is not a string`);
    return;
  }
  if (ref.startsWith('./')) return;
  if (ref.startsWith('docker://')) {
    if (!DOCKER_DIGEST.test(ref)) findings.push(`${where}: docker image "${ref}" is not pinned to a sha256 digest`);
    return;
  }
  if (!SHA_REF.test(ref)) {
    findings.push(`${where}: "${ref}" is not pinned to a full 40-character commit SHA`);
    return;
  }
  const line = lines.find((l) => l.includes(`uses: ${ref}`) || l.includes(`uses: "${ref}"`) || l.includes(`uses: '${ref}'`));
  if (!line || !/#\s*v?\d/.test(line)) {
    findings.push(`${where}: "${ref}" has no trailing version comment (for example "# v1.2.3")`);
  }
}

/**
 * Returns the findings for one workflow file. An empty array means it is safe.
 * @param {string} text workflow YAML
 * @param {{ strict: boolean, yaml?: { parse(text: string): unknown } }} options
 */
export function checkWorkflow(text, { strict, yaml = loadYaml() }) {
  const findings = [];
  let wf;
  try {
    wf = yaml.parse(text);
  } catch (err) {
    return [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!isObject(wf)) return ['not a workflow (top level is not a mapping)'];
  const lines = text.split(/\r?\n/);

  if (triggers(wf.on).includes('pull_request_target')) {
    findings.push('uses the pull_request_target trigger');
  }

  if (wf.permissions === undefined) {
    findings.push('no top-level permissions (the token defaults to the repository setting, often write)');
  } else {
    for (const scope of writeScopes(wf.permissions)) findings.push(`top-level permissions grant ${scope}`);
    if (strict) {
      const p = wf.permissions;
      const exact = isObject(p) && Object.keys(p).length === 1 && p.contents === 'read';
      if (!exact) findings.push('top-level permissions must be exactly "contents: read"');
    }
  }

  if (strict && SECRETS_EXPR.test(text)) findings.push('references secrets');

  const jobs = isObject(wf.jobs) ? wf.jobs : {};
  if (Object.keys(jobs).length === 0) findings.push('has no jobs');
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      findings.push(`job ${id}: not a mapping`);
      continue;
    }
    if (job.permissions !== undefined) {
      if (strict) findings.push(`job ${id}: sets job-level permissions (only the top-level contents: read is allowed)`);
      else for (const scope of writeScopes(job.permissions)) findings.push(`job ${id}: permissions grant ${scope}`);
    }
    if (strict && job.secrets !== undefined) findings.push(`job ${id}: passes secrets to a reusable workflow`);
    if (job.uses !== undefined) {
      checkUses(job.uses, `job ${id}`, lines, findings);
      continue;
    }
    if (job['timeout-minutes'] === undefined) findings.push(`job ${id}: no timeout-minutes`);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!isObject(step) || step.uses === undefined) return;
      const where = `job ${id}, step ${i + 1}`;
      checkUses(step.uses, where, lines, findings);
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
        const persist = isObject(step.with) ? step.with['persist-credentials'] : undefined;
        if (persist !== false && persist !== 'false') {
          findings.push(`${where}: actions/checkout without persist-credentials: false`);
        }
      }
    });
  }
  return findings;
}

function main() {
  const dir = resolve(process.argv[2] ?? join(root, '.github', 'workflows'));
  const yaml = loadYaml();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const inGitHub = process.env.GITHUB_ACTIONS === 'true';
  let failed = false;

  for (const name of STRICT_FILES) {
    if (!files.includes(name)) {
      console.log(`check-workflows: FAILED. ${name} is missing from ${dir}`);
      failed = true;
    }
  }

  for (const file of files) {
    const strict = STRICT_FILES.has(file);
    const findings = checkWorkflow(readFileSync(join(dir, file), 'utf8'), { strict, yaml });
    if (findings.length === 0) {
      console.log(`check-workflows: ${file} ok${strict ? ' (strict)' : ''}`);
      continue;
    }
    const label = strict ? 'FAILED' : 'advisory (not enforced, follow-up)';
    console.log(`check-workflows: ${file} ${label}:`);
    for (const f of findings) {
      console.log(`  - ${f}`);
      if (inGitHub) console.log(`::${strict ? 'error' : 'warning'} file=.github/workflows/${file}::${f}`);
    }
    if (strict) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
