// scripts/aws/check-github-deploy-role.sh (ADR 0018): the owner's mechanical step-2 check
// before `cdk import`. It runs here against a fake `aws` that answers from fixture files;
// PATH holds nothing else that could reach AWS. A role equal to the import template
// passes; each kind of difference fails with exit 1.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { FAKE_ACCOUNT, githubOidcApp } from './helpers.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/aws/check-github-deploy-role.sh', import.meta.url));
const BASH = execFileSync('/usr/bin/env', ['bash', '-c', 'command -v bash'], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'cupmark-role-check-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

/** The template with `Ref AWS::AccountId` filled in, as IAM returns the documents. */
function render(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(render);
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Json;
  const join = obj['Fn::Join'];
  if (Array.isArray(join)) {
    const [sep, parts] = join as [string, unknown[]];
    return parts.map((p) => (typeof p === 'string' ? p : FAKE_ACCOUNT)).join(sep);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, render(v)]));
}

function writeTemplate(importMode: boolean): string {
  const file = join(mkdtempSync(join(work, 'tpl-')), 'cupmark-github-oidc.template.json');
  writeFileSync(file, JSON.stringify(Template.fromStack(githubOidcApp({ importMode }).stack).toJSON()));
  return file;
}

const importTemplate = writeTemplate(true);
const role = (render(JSON.parse(readFileSync(importTemplate, 'utf8'))) as { Resources: { DeployRole: { Properties: Json } } }).Resources
  .DeployRole.Properties;
const policies = role.Policies as { PolicyName: string; PolicyDocument: Json }[];

interface Fixture {
  providers: string[];
  /** The provider's ClientIDList (audiences). */
  audiences: string[];
  trust: unknown;
  policyNames: string[];
  policy: unknown;
  attached: unknown[];
  role: Json;
}

function matching(): Fixture {
  return {
    providers: [`arn:aws:iam::${FAKE_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`, `arn:aws:iam::${FAKE_ACCOUNT}:oidc-provider/example.com`],
    // IAM keeps the list order the owner used; the check ignores the order of string lists.
    // Shared with other projects: it may list other audiences as well.
    audiences: ['sigstore', 'sts.amazonaws.com'],
    trust: JSON.parse(JSON.stringify(role.AssumeRolePolicyDocument).replace(/("[^"]*:environment:dev"),("[^"]*:environment:prod")/, '$2,$1')) as unknown,
    policyNames: [policies[0]?.PolicyName ?? ''],
    policy: policies[0]?.PolicyDocument,
    attached: [],
    // No Description and no PermissionsBoundary key at all, as IAM answers for a bare role.
    role: { RoleName: 'CupmarkGitHubDeploy', Path: '/', MaxSessionDuration: 3600, Description: null, PermissionsBoundary: null, Tags: null },
  };
}

function runCheck(fixture: Fixture, template = importTemplate): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(work, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const f = (name: string, value: unknown): string => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  writeFileSync(
    join(bin, 'aws'),
    `#!${BASH}
case "$*" in
  "sts get-caller-identity --query Account --output text") echo "${FAKE_ACCOUNT}" ;;
  "iam list-open-id-connect-providers "*) cat "${f('providers', fixture.providers)}" ;;
  "iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::${FAKE_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com --query ClientIDList --output json") cat "${f('audiences', fixture.audiences)}" ;;
  *"get-role --role-name CupmarkGitHubDeploy --query Role.AssumeRolePolicyDocument "*) cat "${f('trust', fixture.trust)}" ;;
  *"get-role --role-name CupmarkGitHubDeploy --query Role.{"*) cat "${f('role', fixture.role)}" ;;
  *"list-role-policies --role-name CupmarkGitHubDeploy "*) cat "${f('names', fixture.policyNames)}" ;;
  *"get-role-policy --role-name CupmarkGitHubDeploy --policy-name AssumeCdkBootstrapRoles "*) cat "${f('policy', fixture.policy)}" ;;
  *"list-attached-role-policies --role-name CupmarkGitHubDeploy "*) cat "${f('attached', fixture.attached)}" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(join(bin, 'aws'), 0o755);
  const PATH = `${bin}:/usr/bin:/bin`;
  expect(execFileSync(BASH, ['-c', 'command -v aws'], { env: { PATH }, encoding: 'utf8' }).trim()).toBe(join(bin, 'aws'));
  const r = spawnSync(BASH, [SCRIPT, template], {
    env: { PATH, HOME: dir, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('check-github-deploy-role.sh', () => {
  it('only reads: every aws call is sts get-caller-identity or iam get-/list-', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'));
    const calls = code.flatMap((l) => [...l.matchAll(/\baws (\S+) (\S+)/g)].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`));
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) expect(call).toMatch(/^(sts get-caller-identity|iam (get|list)-[a-z-]+)$/);
  });

  it('passes a role that matches the import template, with the subjects in another order', () => {
    const run = runCheck(matching());
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('The role matches the import template.');
    expect(run.stdout).not.toContain('DIFFERENT');
    expect(run.stdout).toContain('OK         GitHub OIDC provider audience (ClientIDList contains sts.amazonaws.com)');
  });

  it('a missing provider also fails the audience check, without asking IAM for it', () => {
    const fixture = matching();
    fixture.providers = [];
    const run = runCheck(fixture);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('DIFFERENT  GitHub OIDC provider audience');
    expect(run.stderr).not.toContain('unexpected aws call');
  });

  it.each<[string, (f: Fixture) => void, string]>([
    ['the old ref:refs/heads/main subject', (f) => {
      f.trust = JSON.parse(JSON.stringify(f.trust).replace(':environment:prod', ':ref:refs/heads/main')) as unknown;
    }, 'trust policy'],
    ['the live immutable subjects in StringLike (the setup script rewrites that, this check stays strict)', (f) => {
      const doc = f.trust as { Statement: { Condition: Record<string, Record<string, unknown>> }[] };
      const statement = doc.Statement[0];
      if (statement?.Condition.StringEquals === undefined) throw new Error('no condition');
      const { 'token.actions.githubusercontent.com:sub': sub, ...rest } = statement.Condition.StringEquals;
      statement.Condition = { StringEquals: rest, StringLike: { 'token.actions.githubusercontent.com:sub': sub } };
    }, 'trust policy'],
    ['StringLike instead of StringEquals', (f) => {
      f.trust = JSON.parse(JSON.stringify(f.trust).replace('StringEquals', 'StringLike')) as unknown;
    }, 'trust policy'],
    ['an extra subject', (f) => {
      f.trust = JSON.parse(JSON.stringify(f.trust).replace(':environment:dev"', ':environment:dev","repo:x/y:pull_request"')) as unknown;
    }, 'trust policy'],
    ['a missing provider', (f) => {
      f.providers = [];
    }, 'GitHub OIDC provider exists'],
    ['a provider without the audience sts.amazonaws.com', (f) => {
      f.audiences = ['sigstore'];
    }, 'GitHub OIDC provider audience (ClientIDList contains sts.amazonaws.com)'],
    ['a provider with no audience at all', (f) => {
      f.audiences = [];
    }, 'GitHub OIDC provider audience'],
    ['an audience that only resembles sts.amazonaws.com', (f) => {
      f.audiences = ['sts.amazonaws.com.example.com', 'STS.amazonaws.com'];
    }, 'GitHub OIDC provider audience'],
    ['a wildcard bootstrap role in the policy', (f) => {
      f.policy = JSON.parse(JSON.stringify(f.policy).replace(/cdk-cupmark-lookup-role-[^"]*/, 'cdk-cupmark-*')) as unknown;
    }, 'inline policy AssumeCdkBootstrapRoles'],
    ['a second inline policy', (f) => {
      f.policyNames = [...f.policyNames, 'Extra'];
    }, 'inline policy names'],
    ['a managed policy', (f) => {
      f.attached = [{ PolicyName: 'AdministratorAccess', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }];
    }, 'no managed policies'],
    ['a boundary', (f) => {
      f.role = { ...f.role, PermissionsBoundary: { PermissionsBoundaryType: 'Policy', PermissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/CupmarkBoundary' } };
    }, 'name, path, session, description, boundary, tags'],
    ['a tag', (f) => {
      f.role = { ...f.role, Tags: [{ Key: 'project', Value: 'cupmark' }] };
    }, 'name, path, session, description, boundary, tags'],
    ['a description', (f) => {
      f.role = { ...f.role, Description: 'made by hand' };
    }, 'name, path, session, description, boundary, tags'],
    ['a longer session', (f) => {
      f.role = { ...f.role, MaxSessionDuration: 7200 };
    }, 'name, path, session, description, boundary, tags'],
  ])('fails with exit 1 on %s', (_label, change, item) => {
    const fixture = matching();
    change(fixture);
    const run = runCheck(fixture);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`DIFFERENT +${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(run.stderr).toContain('Do not import');
  });

  it('refuses a template synthesised without the import flag (exit 2)', () => {
    const run = runCheck(matching(), writeTemplate(false));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('-c cupmark:githubOidcImport=true');
  });
});
