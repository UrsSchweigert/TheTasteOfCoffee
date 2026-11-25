#!/usr/bin/env node
// Checks that the GitHub Actions workflows stay safe (backlog M0-T5).
//
// Rules, per workflow file:
// - every `uses:` is pinned to a full 40-hex commit SHA (local `./` actions and
//   `docker://...@sha256:<digest>` images are allowed), and every `uses:` line
//   that names a SHA carries the version in a trailing comment (`# v6.1.0`);
// - no `pull_request_target` trigger;
// - top-level `permissions` is present and grants no write scope;
// - every job has `timeout-minutes` (reusable-workflow call jobs excepted);
// - `actions/checkout` runs with `persist-credentials: false`;
// - every job `container` and `services` image is pinned to a sha256 digest
//   (`name:tag@sha256:<digest>` or `name@sha256:<digest>`).
//
// Strict files (STRICT_FILES) fail the run (exit 1). In a strict file a job may
// only grant the write scopes listed for that job in its policy (`jobWrites`);
// anything else is a finding. A policy with `readOnly: true` (ci.yml)
// additionally needs top-level permissions of exactly `contents: read`, no
// job-level permissions at all, and no reference to secrets.
// Every other workflow file is reported as advisory only (exit 0).
//
// AWS deploy role (M1-T9, ADR 0018): CupmarkGitHubDeploy trusts only the `sub`
// values `environment:dev` and `environment:prod`, and those environments are
// limited to `main`. So:
// - a job that runs aws-actions/configure-aws-credentials must declare the
//   literal environment `dev` or `prod`. This fails the run in strict files
//   and is reported as advisory elsewhere, like every other finding; the
//   deploy workflow (M1-T7) is added to STRICT_FILES. The trust and the
//   environments' branch limits are the real control;
// - in a strict file, every job that grants `id-token: write` must declare one
//   too, unless its policy lists it in `oidcWithoutEnvironment` (with a reason).
//
// Stage commands (M1-T7, ADR 0019), in every file (enforced in strict files):
// - `cdk destroy` and `cdk bootstrap` never run in a workflow;
// - `cdk deploy` never uses `--all` and names exactly one stack, `<env>/core` (or
//   `cupmark-<env>-core`), where <env> is the job's literal environment;
// - `scripts/deploy/*.sh <stage>` and `scripts/smoke/*.sh <stage>` name the job's
//   literal environment, so a job in `dev` can never deploy or test prod.
//
// Needs Node 22 and `npm ci` in contracts/ (for the `yaml` package).
// Usage: node scripts/check-workflows.mjs [workflow-dir]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Strict workflow files and the narrow exceptions each one needs.
 * jobWrites: job id -> write scopes that job may grant. Each entry is justified
 * in a comment in the workflow file itself.
 * oidcWithoutEnvironment: jobs that may request a GitHub OIDC token without
 * declaring an AWS environment, because they never assume the AWS role.
 * @type {Map<string, { readOnly?: boolean, jobWrites?: Record<string, string[]>, oidcWithoutEnvironment?: string[] }>}
 */
export const STRICT_FILES = new Map([
  // Untrusted PR code runs here: read-only token, no secrets.
  ['ci.yml', { readOnly: true }],
  // claude-code-action fetches a GitHub OIDC token and exchanges it for the
  // Claude GitHub App token, which does all of its writes.
  // It declares no environment; its `sub` (issue_comment runs on the default
  // branch) is `ref:refs/heads/main`, which the AWS deploy role does not trust
  // (ADR 0018), so it cannot assume that role.
  ['claude.yml', { jobWrites: { claude: ['id-token'] }, oidcWithoutEnvironment: ['claude'] }],
  // configure-aws-credentials assumes the deploy role through GitHub OIDC,
  // in the `dev` environment (its sub is environment:dev).
  ['aws-oidc-check.yml', { jobWrites: { check: ['id-token'] } }],
  // M1-T7: the two deploy jobs assume the deploy role through GitHub OIDC, each in its
  // own environment (dev, prod). The gate job grants only read scopes.
  ['deploy.yml', { jobWrites: { 'deploy-dev': ['id-token'], 'deploy-prod': ['id-token'] } }],
]);

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
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
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

// Names of the scopes granted write; `write-all` is reported as itself.
function writeScopes(permissions) {
  if (permissions === 'write-all') return ['write-all'];
  if (!isObject(permissions)) return [];
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

/** The environments the AWS deploy role trusts (infra/src/github-oidc.ts). */
export const AWS_ENVIRONMENTS = ['dev', 'prod'];
const AWS_CREDENTIALS_ACTION = 'aws-actions/configure-aws-credentials@';

/** A job's literal environment name, or undefined (none, or an expression). */
function environmentName(job) {
  const env = isObject(job.environment) ? job.environment.name : job.environment;
  return typeof env === 'string' && !env.includes('${{') ? env : undefined;
}

const STAGE_SCRIPT = /\bscripts\/(?:deploy|smoke)\/[A-Za-z0-9_.-]+\.sh(?:[ \t]+([^\s;&|]+))?/g;
const CDK_COMMAND = /\bcdk[ \t]+(deploy|destroy|bootstrap)\b[^\n]*/g;

/** Findings for the stage commands of one `run` script in a job with literal environment `env`. */
function checkStageCommands(run, env, where, findings) {
  for (const m of run.matchAll(CDK_COMMAND)) {
    const [line, verb] = m;
    if (verb !== 'deploy') {
      findings.push(`${where}: runs cdk ${verb}, which never runs in a workflow`);
      continue;
    }
    if (/(^|\s)--all\b/.test(line)) findings.push(`${where}: cdk deploy --all (name the stage stack)`);
    // A stage stack is selected by its hierarchical id, `<stage>/core` (the CLI does not
    // match stack names inside a Stage); `cupmark-<stage>-core` is counted too.
    const stacks = [...line.matchAll(/(?:\bcupmark-[a-z0-9-]+|\b[a-z0-9-]+\/[a-z0-9-]+)/g)].map((s) => s[0]);
    const ok = env !== undefined && stacks.length === 1 && [`${env}/core`, `cupmark-${env}-core`].includes(stacks[0]);
    if (!ok) {
      findings.push(`${where}: cdk deploy must name exactly the stack <environment>/core of the job's environment (${env ?? 'none'})`);
    }
  }
  for (const m of run.matchAll(STAGE_SCRIPT)) {
    if (m[1] === undefined || m[1] !== env) {
      findings.push(`${where}: ${m[0]} must name the job's environment (${env ?? 'none'})`);
    }
  }
}

function describe(scope) {
  return scope === 'write-all' ? 'write-all' : `${scope}: write`;
}

function checkUses(ref, where, findings) {
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
  }
}

/** A job's `container` or one of its `services`: a string image or a mapping with `image`. */
function checkImage(spec, where, findings) {
  const image = isObject(spec) ? spec.image : spec;
  if (typeof image !== 'string' || !IMAGE_DIGEST.test(image)) {
    findings.push(`${where}: image "${String(image)}" is not pinned to a sha256 digest`);
  }
}

/**
 * Checks the version comment on every `uses:` value in the document, each at
 * its own position, so a repeated ref cannot borrow the comment of an earlier
 * line. Refs that are not SHA-pinned are reported by checkUses instead.
 */
function checkVersionComments(doc, text, yaml, findings) {
  yaml.visit(doc, {
    Pair(_, pair) {
      if (!yaml.isScalar(pair.key) || pair.key.value !== 'uses') return;
      if (!yaml.isScalar(pair.value) || !Array.isArray(pair.value.range)) return;
      const ref = pair.value.value;
      if (typeof ref !== 'string' || !SHA_REF.test(ref)) return;
      const end = pair.value.range[1];
      const eol = text.indexOf('\n', end);
      const rest = text.slice(end, eol === -1 ? text.length : eol);
      if (!/^\s*#\s*v?\d/.test(rest)) {
        const line = text.slice(0, end).split('\n').length;
        findings.push(`line ${line}: "${ref}" has no trailing version comment (for example "# v1.2.3")`);
      }
    },
  });
}

/**
 * Returns the findings for one workflow file. An empty array means it is safe.
 * @param {string} text workflow YAML
 * @param {{ strict: boolean, readOnly?: boolean, jobWrites?: Record<string, string[]>, oidcWithoutEnvironment?: string[], yaml?: typeof import('yaml') }} options
 */
export function checkWorkflow(text, { strict, readOnly = false, jobWrites = {}, oidcWithoutEnvironment = [], yaml = loadYaml() }) {
  const findings = [];
  let wf;
  let doc;
  try {
    doc = yaml.parseDocument(text);
    if (doc.errors.length > 0) throw doc.errors[0];
    wf = doc.toJS();
  } catch (err) {
    return [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!isObject(wf)) return ['not a workflow (top level is not a mapping)'];
  checkVersionComments(doc, text, yaml, findings);
  const ciRules = strict && readOnly;

  if (triggers(wf.on).includes('pull_request_target')) {
    findings.push('uses the pull_request_target trigger');
  }

  if (wf.permissions === undefined) {
    findings.push('no top-level permissions (the token defaults to the repository setting, often write)');
  } else {
    for (const scope of writeScopes(wf.permissions)) findings.push(`top-level permissions grant ${describe(scope)}`);
    if (ciRules) {
      const p = wf.permissions;
      const exact = isObject(p) && Object.keys(p).length === 1 && p.contents === 'read';
      if (!exact) findings.push('top-level permissions must be exactly "contents: read"');
    }
  }

  if (ciRules && SECRETS_EXPR.test(text)) findings.push('references secrets');

  const jobs = isObject(wf.jobs) ? wf.jobs : {};
  if (Object.keys(jobs).length === 0) findings.push('has no jobs');
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      findings.push(`job ${id}: not a mapping`);
      continue;
    }
    if (job.permissions !== undefined) {
      if (ciRules) {
        findings.push(`job ${id}: sets job-level permissions (only the top-level contents: read is allowed)`);
      } else {
        const allowed = strict && Array.isArray(jobWrites[id]) ? jobWrites[id] : [];
        for (const scope of writeScopes(job.permissions)) {
          if (!allowed.includes(scope)) {
            findings.push(`job ${id}: permissions grant ${describe(scope)}${strict ? ' (not in the allowlist for this file)' : ''}`);
          }
        }
      }
    }
    if (ciRules && job.secrets !== undefined) findings.push(`job ${id}: passes secrets to a reusable workflow`);
    if (job.uses !== undefined) {
      checkUses(job.uses, `job ${id}`, findings);
      continue;
    }
    if (job['timeout-minutes'] === undefined) findings.push(`job ${id}: no timeout-minutes`);
    if (job.container !== undefined) checkImage(job.container, `job ${id}, container`, findings);
    if (job.services !== undefined) {
      if (!isObject(job.services)) findings.push(`job ${id}: services is not a mapping`);
      else for (const [name, spec] of Object.entries(job.services)) checkImage(spec, `job ${id}, service ${name}`, findings);
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const env = environmentName(job);
    const awsEnv = env !== undefined && AWS_ENVIRONMENTS.includes(env);
    const usesAws = steps.some((st) => isObject(st) && typeof st.uses === 'string' && st.uses.startsWith(AWS_CREDENTIALS_ACTION));
    if (usesAws && !awsEnv) {
      findings.push(`job ${id}: configure-aws-credentials needs the literal environment ${AWS_ENVIRONMENTS.join(' or ')} (the deploy role trusts only those)`);
    }
    const oidc = writeScopes(job.permissions).some((sc) => sc === 'id-token' || sc === 'write-all');
    if (strict && oidc && !awsEnv && !oidcWithoutEnvironment.includes(id)) {
      findings.push(`job ${id}: requests an OIDC token (id-token: write) without the environment ${AWS_ENVIRONMENTS.join(' or ')}`);
    }
    steps.forEach((step, i) => {
      if (isObject(step) && typeof step.run === 'string') checkStageCommands(step.run, env, `job ${id}, step ${i + 1}`, findings);
      if (!isObject(step) || step.uses === undefined) return;
      const where = `job ${id}, step ${i + 1}`;
      checkUses(step.uses, where, findings);
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

  for (const name of STRICT_FILES.keys()) {
    if (!files.includes(name)) {
      console.log(`check-workflows: FAILED. ${name} is missing from ${dir}`);
      failed = true;
    }
  }

  for (const file of files) {
    const policy = STRICT_FILES.get(file);
    const strict = policy !== undefined;
    const findings = checkWorkflow(readFileSync(join(dir, file), 'utf8'), { strict, ...policy, yaml });
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
