// scripts/aws/first-deploy-setup.sh (M1-T7): the owner's one script for the AWS steps of
// issues #45, #46 (trust) and #48. It runs here against fake `aws`, `npx`, `node` and `git`
// that answer from a state file and record every call; PATH holds nothing else that could
// reach AWS. apply-guardrails.sh and check-github-deploy-role.sh are the real scripts.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { FAKE_ACCOUNT, githubOidcApp } from './helpers.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/aws/first-deploy-setup.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const BASH = execFileSync('/usr/bin/env', ['bash', '-c', 'command -v bash'], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'cupmark-first-deploy-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
const IMPORT_TEMPLATE = Template.fromStack(githubOidcApp({ importMode: true }).stack).toJSON();
const COMMITTED_TEMPLATE = Template.fromStack(githubOidcApp({ importMode: false }).stack).toJSON();

function render(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(render);
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Json;
  const joined = obj['Fn::Join'];
  if (Array.isArray(joined)) {
    const [sep, parts] = joined as [string, unknown[]];
    return parts.map((p) => (typeof p === 'string' ? p : FAKE_ACCOUNT)).join(sep);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, render(v)]));
}
const ROLE = (render(IMPORT_TEMPLATE) as { Resources: { DeployRole: { Properties: Json } } }).Resources.DeployRole.Properties;
const TARGET_TRUST = ROLE.AssumeRolePolicyDocument as Json;
const SUB = 'token.actions.githubusercontent.com:sub';
const REPO = 'repo:UrsSchweigert/TheTasteOfCoffee';

function trustWith(subs: string[], operator = 'StringEquals'): Json {
  const doc = JSON.parse(JSON.stringify(TARGET_TRUST)) as { Statement: { Condition: Record<string, Json> }[] };
  const statement = doc.Statement[0];
  if (statement === undefined) throw new Error('no statement');
  const condition = { ...statement.Condition.StringEquals, [SUB]: subs };
  statement.Condition = { [operator]: condition };
  return doc;
}
/** The trust docs/07 describes: the old subjects, in the order the owner wrote them. */
const OLD_TRUST = trustWith([`${REPO}:environment:dev`, `${REPO}:ref:refs/heads/main`]);

interface State {
  arn: string;
  trust: unknown;
  stack: string | null;
  tagged: boolean;
  drift: string;
}

function defaults(): State {
  return { arn: `arn:aws:iam::${FAKE_ACCOUNT}:user/owner`, trust: OLD_TRUST, stack: null, tagged: false, drift: 'IN_SYNC' };
}

const FAKE_AWS = `
const fs = require('node:fs');
const dir = process.env.FAKE_DIR;
const statePath = dir + '/state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(dir + '/fixtures.json', 'utf8'));
const args = process.argv.slice(2);
const line = args.join(' ');
fs.appendFileSync(dir + '/calls.log', 'aws ' + line + '\\n');
const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\\n');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const has = (s) => line.includes(s);
const ACCOUNT = '${FAKE_ACCOUNT}';
if (line === 'sts get-caller-identity --output json') out({ Account: ACCOUNT, Arn: state.arn, UserId: 'AIDA' });
else if (has('sts get-caller-identity --query Account')) out(ACCOUNT);
else if (has('sts get-caller-identity --query Arn')) out(state.arn);
else if (has('iam get-policy ')) out('{}');
else if (has('iam list-policy-versions ')) out('None');
else if (has('iam create-policy-version ') || has('iam delete-policy-version ')) out('{}');
else if (has('iam list-open-id-connect-providers ')) out(['arn:aws:iam::' + ACCOUNT + ':oidc-provider/token.actions.githubusercontent.com']);
else if (has('iam get-open-id-connect-provider ')) out(['sts.amazonaws.com']);
else if (has('iam get-role ') && has('Role.AssumeRolePolicyDocument')) out(state.trust);
else if (has('iam get-role ') && has('Role.{')) out({ RoleName: 'CupmarkGitHubDeploy', Path: '/', MaxSessionDuration: 3600, Description: null, PermissionsBoundary: null, Tags: state.tagged ? [{ Key: 'project', Value: 'cupmark' }] : null });
else if (has('iam list-role-policies ')) out([fixtures.policyName]);
else if (has('iam get-role-policy ')) out(fixtures.policy);
else if (has('iam list-attached-role-policies ')) out([]);
else if (has('iam update-assume-role-policy ')) {
  const file = args[args.indexOf('--policy-document') + 1].replace(/^file:\\/\\//, '');
  state.trust = JSON.parse(fs.readFileSync(file, 'utf8'));
  save();
}
else if (has('iam list-role-tags ')) out(state.tagged ? 'cupmark' : 'None');
else if (has('cloudformation describe-stacks ') && has('StackStatus')) {
  if (state.stack === null) { process.stderr.write('An error occurred (ValidationError): Stack with id cupmark-github-oidc does not exist\\n'); process.exit(254); }
  out(state.stack);
}
else if (has('cloudformation describe-stacks ') && has('EnableTerminationProtection')) out('True');
else if (has('cloudformation detect-stack-drift ')) out('drift-1');
else if (has('cloudformation describe-stack-drift-detection-status ')) out('DETECTION_COMPLETE\\t' + state.drift);
else if (has('cloudformation describe-stack-resource-drifts ')) out({ StackResourceDrifts: [{ PhysicalResourceId: 'arn:aws:iam::' + ACCOUNT + ':role/CupmarkGitHubDeploy' }] });
else { process.stderr.write('unexpected aws call: ' + line + '\\n'); process.exit(99); }
`;

const FAKE_NPX = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const statePath = dir + '/state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.log', 'npx ' + args.join(' ') + '\\n');
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const importMode = args.includes('cupmark:githubOidcImport=true');
if (args[1] === 'synth' && output) {
  fs.mkdirSync(output, { recursive: true });
  const t = fs.readFileSync(dir + (importMode ? '/import.json' : '/committed.json'), 'utf8');
  fs.writeFileSync(path.join(output, 'cupmark-github-oidc.template.json'), t);
}
if (args[1] === 'import') state.stack = 'IMPORT_COMPLETE';
if (args[1] === 'deploy') { state.stack = 'UPDATE_COMPLETE'; state.tagged = true; }
if (args[1] === 'diff') console.log('Stack cupmark-github-oidc arn:aws:iam::${FAKE_ACCOUNT}:role/CupmarkGitHubDeploy');
fs.writeFileSync(statePath, JSON.stringify(state));
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string[];
  readonly state: State;
}

function runScript(args: string[], change: (s: State) => void = () => undefined, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(work, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'tmp'));
  const state = defaults();
  change(state);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const policies = ROLE.Policies as { PolicyName: string; PolicyDocument: unknown }[];
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ policyName: policies[0]?.PolicyName, policy: policies[0]?.PolicyDocument }));
  writeFileSync(join(dir, 'import.json'), JSON.stringify(IMPORT_TEMPLATE));
  writeFileSync(join(dir, 'committed.json'), JSON.stringify(COMMITTED_TEMPLATE));
  writeFileSync(join(bin, 'aws'), `#!${process.execPath}\n${FAKE_AWS}`);
  writeFileSync(join(bin, 'npx'), `#!${process.execPath}\n${FAKE_NPX}`);
  writeFileSync(
    join(bin, 'node'),
    `#!${BASH}\nif [ "$1" = "--version" ]; then echo "\${FAKE_NODE_VERSION:-v22.23.5}"; else exec "${process.execPath}" "$@"; fi\n`,
  );
  // The repository as a clean main checkout.
  writeFileSync(
    join(bin, 'git'),
    `#!${BASH}
echo "git $*" >> "${join(dir, 'calls.log')}"
case "$*" in
  "rev-parse --show-toplevel") echo "${ROOT}" ;;
  "rev-parse --abbrev-ref HEAD") echo "\${FAKE_BRANCH:-main}" ;;
  "status --porcelain") printf '%s' "\${FAKE_DIRTY:-}" ;;
  "log -1 --format="*) echo "abc1234 M1-T7" ;;
  *) echo "unexpected git call: $*" >&2; exit 99 ;;
esac
`,
  );
  for (const name of ['aws', 'npx', 'node', 'git']) chmodSync(join(bin, name), 0o755);
  const PATH = `${bin}:/usr/bin:/bin`;
  const resolved = execFileSync(BASH, ['-c', 'command -v aws npx node git'], { env: { PATH }, encoding: 'utf8' });
  expect(resolved.trim().split('\n')).toEqual(['aws', 'npx', 'node', 'git'].map((n) => join(bin, n)));
  const r = spawnSync(BASH, [SCRIPT, ...args], {
    cwd: ROOT,
    env: {
      PATH,
      HOME: dir,
      FAKE_DIR: dir,
      TMPDIR: join(dir, 'tmp'),
      AWS_REGION: 'eu-central-1',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      FIRST_DEPLOY_POLL_S: '0',
      ...env,
    },
    encoding: 'utf8',
  });
  const log = join(dir, 'calls.log');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : [],
    state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as State,
  };
}

/** Calls that change something in AWS. */
const WRITES = /^aws (iam (update-|create-|delete-|put-|tag-|untag-|attach-|detach-)|cloudformation (create-|update-|delete-|execute-))|^npx cdk (import|deploy|bootstrap|destroy)/;

describe('first-deploy-setup.sh', () => {
  it('needs the backend bundle and infra/node_modules of this checkout (CI builds them first)', () => {
    expect(existsSync(join(ROOT, 'backend', 'dist', 'api', 'index.mjs'))).toBe(true);
    expect(existsSync(join(ROOT, 'infra', 'node_modules'))).toBe(true);
  });

  it('dry run: shows every step, changes nothing', () => {
    const r = runScript([]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const n of [0, 1, 2, 3, 4]) expect(r.stdout).toContain(`Step ${String(n)}: `);
    expect(r.calls.filter((c) => WRITES.test(c))).toEqual([]);
    expect(r.state).toEqual(defaults());
    expect(r.stdout).toContain('+ aws iam update-assume-role-policy --role-name CupmarkGitHubDeploy');
    expect(r.stdout).toContain('npx cdk import cupmark-github-oidc -c cupmark:githubOidcImport=true --resource-mapping import/cupmark-github-oidc.json --toolkit-stack-name CDKToolkit-cupmark');
    expect(r.stdout).toContain('Dry run only: nothing was changed.');
    // The diff shows only the sub list changing.
    expect(r.stdout).toMatch(/-\s+"repo:UrsSchweigert\/TheTasteOfCoffee:ref:refs\/heads\/main"/);
    expect(r.stdout).toMatch(/\+\s+"repo:UrsSchweigert\/TheTasteOfCoffee:environment:prod"/);
  });

  it('apply: updates the expected old trust, imports, checks drift, deploys the tag and verifies', () => {
    const r = runScript(['--apply']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.state.trust).toEqual(trustWith([`${REPO}:environment:dev`, `${REPO}:environment:prod`]));
    expect(r.state).toMatchObject({ stack: 'UPDATE_COMPLETE', tagged: true });
    const order = ['aws iam create-policy-version', 'npx cdk bootstrap', 'aws iam update-assume-role-policy', 'aws iam list-open-id-connect-providers', 'npx cdk import', 'aws cloudformation detect-stack-drift', 'npx cdk diff', 'npx cdk deploy', 'aws iam list-role-tags'];
    const at = order.map((p) => r.calls.findIndex((c) => c.startsWith(p)));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(r.calls.find((c) => c.startsWith('npx cdk import'))).toContain('--resource-mapping import/cupmark-github-oidc.json --toolkit-stack-name CDKToolkit-cupmark');
    expect(r.calls.filter((c) => /delete-(role|stack|policy |open-id)|cdk destroy/.test(c))).toEqual([]);
    expect(r.stdout).toContain('Comment "done" on the GitHub issues #45, #46 and #48');
  });

  it('never prints the account id, except in the assumed identity line', () => {
    const r = runScript(['--apply']);
    const lines = (r.stdout + r.stderr).split('\n').filter((l) => l.includes(FAKE_ACCOUNT));
    expect(lines).toEqual([`  Assumed identity: arn:aws:iam::${FAKE_ACCOUNT}:user/owner`]);
    expect(r.stdout).toContain('<account>');
  });

  it('is idempotent: a second apply skips the trust and the import and deploys nothing new', () => {
    const first = runScript(['--apply']);
    const r = runScript(['--apply'], (s) => Object.assign(s, { trust: first.state.trust, stack: first.state.stack, tagged: true }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('the trust already lists exactly environment:dev and environment:prod; skipped');
    expect(r.stdout).toContain('already exists (UPDATE_COMPLETE); import skipped');
    expect(r.calls.some((c) => c.startsWith('aws iam update-assume-role-policy'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('npx cdk import'))).toBe(false);
  });

  it('skips the trust step when the trust is already right (subjects in any order)', () => {
    const r = runScript([], (s) => {
      s.trust = trustWith([`${REPO}:environment:prod`, `${REPO}:environment:dev`]);
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('skipped');
    expect(r.stdout).not.toContain('update-assume-role-policy');
    // With the trust right, the dry run runs the read-only role check for real.
    expect(r.calls.some((c) => c.startsWith('aws iam list-attached-role-policies'))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['StringLike', trustWith([`${REPO}:environment:dev`, `${REPO}:ref:refs/heads/main`], 'StringLike')],
    ['another subject', trustWith([`${REPO}:environment:dev`, `${REPO}:pull_request`])],
    ['an extra subject', trustWith([`${REPO}:environment:dev`, `${REPO}:ref:refs/heads/main`, 'repo:x/y:ref:refs/heads/main'])],
    ['an extra statement', { ...OLD_TRUST, Statement: [...(OLD_TRUST.Statement as unknown[]), { Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }] }],
  ])('stops on an unexpected trust (%s) and never overwrites it', (_label, trust) => {
    const r = runScript(['--apply'], (s) => {
      s.trust = trust;
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('STOP: unexpected trust on CupmarkGitHubDeploy; it is not overwritten');
    expect(r.calls.some((c) => c.startsWith('aws iam update-assume-role-policy'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('npx cdk import'))).toBe(false);
    expect(r.state.trust).toEqual(trust);
  });

  it('stops on drift and does not deploy', () => {
    const r = runScript(['--apply'], (s) => {
      s.drift = 'DRIFTED';
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/drift detection \(after the import\) reports 'DETECTION_COMPLETE\tDRIFTED', not IN_SYNC/);
    expect(r.stderr).toContain('<account>');
    expect(r.stderr).not.toContain(FAKE_ACCOUNT);
    expect(r.calls.some((c) => c.startsWith('npx cdk deploy'))).toBe(false);
  });

  it('stops on a stack in any other state, changing nothing in it', () => {
    const r = runScript(['--apply'], (s) => {
      s.stack = 'REVIEW_IN_PROGRESS';
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is in REVIEW_IN_PROGRESS');
    expect(r.calls.some((c) => /^npx cdk (import|deploy)/.test(c))).toBe(false);
  });

  it('refuses root without ALLOW_ROOT, before anything else', () => {
    const r = runScript(['--apply'], (s) => {
      s.arn = `arn:aws:iam::${FAKE_ACCOUNT}:root`;
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('running as the account root user');
    expect(r.calls).toEqual(['aws sts get-caller-identity --output json']);
  });

  it('allows root with ALLOW_ROOT=1, with a warning', () => {
    const r = runScript([], (s) => {
      s.arn = `arn:aws:iam::${FAKE_ACCOUNT}:root`;
    }, { ALLOW_ROOT: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('WARNING: running as root');
  });

  it.each([['--force'], ['--apply', '--yes'], ['apply']])('rejects the arguments %j with exit 2', (...args) => {
    const r = runScript(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage');
    expect(r.calls).toEqual([]);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['another region', { AWS_REGION: 'eu-west-1' }, /the region is 'eu-west-1', not eu-central-1/],
    ['an old Node', { FAKE_NODE_VERSION: 'v20.11.0' }, /nvm install 22/],
    ['Node 22 before 22.18', { FAKE_NODE_VERSION: 'v22.17.1' }, /nvm install 22/],
    ['another branch', { FAKE_BRANCH: 'feature' }, /not main/],
    ['a dirty checkout', { FAKE_DIRTY: ' M infra/src/api.ts\n' }, /uncommitted changes/],
  ])('preflight stops on %s, before any change', (_label, env, message) => {
    const r = runScript(['--apply'], () => undefined, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(r.calls.filter((c) => WRITES.test(c))).toEqual([]);
  });
});
