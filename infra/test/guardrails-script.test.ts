// scripts/aws/apply-guardrails.sh (ADR 0002), after M1-T9: the stack cupmark-github-oidc
// owns CupmarkGitHubDeploy, so the script must never write, tag or delete that role
// again. The script runs here against fake `aws` and `npx` commands that only record
// their arguments; PATH holds nothing else that could reach AWS.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FAKE_ACCOUNT } from './helpers.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/aws/apply-guardrails.sh', import.meta.url));
const source = readFileSync(SCRIPT, 'utf8');
const work = mkdtempSync(join(tmpdir(), 'cupmark-guardrails-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const BASH = execFileSync('/usr/bin/env', ['bash', '-c', 'command -v bash'], { encoding: 'utf8' }).trim();

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** One line per call of the fake `aws` or `npx`: `aws <args>`. */
  readonly calls: string[];
}

function runScript(args: string[]): Run {
  const dir = mkdtempSync(join(work, 'run-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  execFileSync('mkdir', [bin]);
  // The fake aws answers the read-only calls the script makes and records every call.
  writeFileSync(
    join(bin, 'aws'),
    `#!${BASH}
echo "aws $*" >> "${log}"
case "$*" in
  "sts get-caller-identity --query Account --output text") echo "${FAKE_ACCOUNT}" ;;
  "sts get-caller-identity --query Arn --output text") echo "arn:aws:iam::${FAKE_ACCOUNT}:user/owner" ;;
  "iam list-policy-versions "*) echo "None" ;;
esac
exit 0
`,
  );
  writeFileSync(join(bin, 'npx'), `#!${BASH}\necho "npx $*" >> "${log}"\nexit 0\n`);
  chmodSync(join(bin, 'aws'), 0o755);
  chmodSync(join(bin, 'npx'), 0o755);
  // Only the fakes and the basic tools the script uses (sed, mktemp, cat, dirname).
  const PATH = `${bin}:/usr/bin:/bin`;
  const resolved = execFileSync(BASH, ['-c', 'command -v aws; command -v npx'], { env: { PATH }, encoding: 'utf8' });
  expect(resolved.trim().split('\n')).toEqual([join(bin, 'aws'), join(bin, 'npx')]);
  const result = spawnSync(BASH, [SCRIPT, ...args], {
    env: { PATH, HOME: dir, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    encoding: 'utf8',
  });
  let calls: string[];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l !== '');
  } catch {
    // No call at all: the fakes never wrote the log.
    calls = [];
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

const READ_ONLY = /^aws (sts get-caller-identity|iam get-policy|iam list-policy-versions) /;

describe('apply-guardrails.sh', () => {
  it('has no command that writes, tags or deletes CupmarkGitHubDeploy', () => {
    const code = source.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/put-role-policy|delete-role-policy|update-assume-role-policy|create-role|delete-role|tag-role|untag-role|attach-role-policy/);
    expect(code).not.toMatch(/--role-name/);
  });

  it('is a dry run by default: only read-only calls, and it says so', () => {
    const run = runScript([]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.filter((c) => !READ_ONLY.test(c))).toEqual([]);
    expect(run.stdout).toContain('Dry run only.');
    // It still prints what --apply would do.
    expect(run.stdout).toContain('+ aws iam create-policy-version --policy-arn arn:aws:iam::123456789012:policy/CupmarkBoundary');
    expect(run.stdout).toContain('+ npx cdk bootstrap aws://123456789012/eu-central-1 --qualifier cupmark --toolkit-stack-name CDKToolkit-cupmark');
  });

  it('says the stack owns the deploy role, and never touches it, also with --apply', () => {
    for (const args of [[], ['--apply']]) {
      const run = runScript(args);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('= CupmarkGitHubDeploy: owned by the stack cupmark-github-oidc');
      expect(run.stdout).not.toContain('put-role-policy');
      expect(run.calls.filter((c) => c.includes('CupmarkGitHubDeploy') || c.includes('role-policy'))).toEqual([]);
    }
  });

  it('with --apply, changes only the two policies and the cupmark bootstrap', () => {
    const run = runScript(['--apply']);
    expect(run.status, run.stderr).toBe(0);
    const changes = run.calls.filter((c) => !READ_ONLY.test(c));
    expect(changes.map((c) => c.split(' --policy-document')[0])).toEqual([
      'aws iam create-policy-version --policy-arn arn:aws:iam::123456789012:policy/CupmarkBoundary',
      'aws iam create-policy-version --policy-arn arn:aws:iam::123456789012:policy/CupmarkCfnExecution',
      expect.stringMatching(/^npx cdk bootstrap aws:\/\/123456789012\/eu-central-1 --qualifier cupmark --toolkit-stack-name CDKToolkit-cupmark /),
    ]);
    expect(run.stdout).toContain('Applied.');
  });

  it('rejects an unknown argument instead of guessing', () => {
    const run = runScript(['--aply']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage:');
    expect(run.calls).toEqual([]);
  });

  it('stops when a change fails under --apply, instead of reporting success', () => {
    // A failing fake npx (the bootstrap) must fail the script.
    const dir = mkdtempSync(join(work, 'fail-'));
    const bin = join(dir, 'bin');
    execFileSync('mkdir', [bin]);
    writeFileSync(
      join(bin, 'aws'),
      `#!${BASH}\ncase "$*" in\n  *"--query Account"*) echo "${FAKE_ACCOUNT}" ;;\n  *"--query Arn"*) echo "arn:aws:iam::${FAKE_ACCOUNT}:user/owner" ;;\n  "iam list-policy-versions "*) echo "None" ;;\nesac\nexit 0\n`,
    );
    writeFileSync(join(bin, 'npx'), `#!${BASH}\nexit 7\n`);
    chmodSync(join(bin, 'aws'), 0o755);
    chmodSync(join(bin, 'npx'), 0o755);
    const failed = spawnSync(BASH, [SCRIPT, '--apply'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
      encoding: 'utf8',
    });
    expect(failed.status).toBe(7);
    expect(failed.stdout).not.toContain('Applied.');
  });
});
