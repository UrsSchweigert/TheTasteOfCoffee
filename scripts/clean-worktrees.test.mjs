// Tests for scripts/clean-worktrees.sh. Run: node --test scripts/clean-worktrees.test.mjs
// Each test builds a throwaway repository with a bare "origin" in a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'clean-worktrees.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A repository with a pushed main, and a helper to add a worktree under .claude/worktrees.
function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clean-wt-')));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(dir, 'init', '--bare', '-q', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  const add = (name, branch = `worktree-${name}`) => {
    const path = join(repo, '.claude', 'worktrees', name);
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main');
    return path;
  };
  return { dir, repo, origin, add };
}

function run(repo, ...args) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: repo, env: ENV, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function oldFiles(path) {
  const t = new Date(Date.now() - 3 * 3600 * 1000);
  utimesSync(join(path, 'a.txt'), t, t);
}

test('a clean, pushed, quiet worktree is removed with --apply and listed in a dry run', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-one');
    oldFiles(wt);
    const dry = run(repo, '--min-age', '0');
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /would remove agent-one/);
    assert.ok(existsSync(wt), 'a dry run removes nothing');
    const real = run(repo, '--apply', '--min-age', '0');
    assert.equal(real.status, 0, real.out);
    assert.match(real.out, /remove agent-one/);
    assert.ok(!existsSync(wt));
    assert.ok(!git(repo, 'worktree', 'list').includes('agent-one'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree with uncommitted or untracked changes is kept', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const modified = add('agent-modified');
    const untracked = add('agent-untracked');
    writeFileSync(join(modified, 'a.txt'), 'changed\n');
    writeFileSync(join(untracked, 'new.txt'), 'new\n');
    const r = run(repo, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /keep +agent-modified: uncommitted/);
    assert.match(r.out, /keep +agent-untracked: uncommitted/);
    assert.ok(existsSync(modified) && existsSync(untracked));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree whose commits were never pushed is kept', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-unpushed');
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'unpushed work');
    const r = run(repo, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /keep +agent-unpushed: HEAD [0-9a-f]{7} is not on any origin branch/);
    assert.ok(existsSync(wt));
    // Once pushed, it can go.
    git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/pushed-work');
    const again = run(repo, '--apply', '--min-age', '0');
    assert.match(again.out, /remove agent-unpushed/);
    assert.ok(!existsSync(wt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree with a file changed a minute ago is kept unless --min-age is 0', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-busy');
    // a.txt is fresh (just checked out): an agent may still be working.
    const r = run(repo, '--apply', '--min-age', '30');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /keep +agent-busy: changed in the last 30 minutes/);
    assert.ok(existsSync(wt));
    oldFiles(wt);
    const quiet = run(repo, '--apply', '--min-age', '30');
    assert.match(quiet.out, /remove agent-busy/);
    assert.ok(!existsSync(wt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the main checkout and a worktree outside .claude/worktrees are never touched', () => {
  const { dir, repo } = makeRepo();
  try {
    const outside = join(dir, 'elsewhere');
    git(repo, 'worktree', 'add', '-q', '-b', 'outside-branch', outside, 'main');
    const r = run(repo, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(outside), 'a worktree outside .claude/worktrees stays');
    assert.ok(existsSync(join(repo, 'a.txt')), 'the main checkout stays');
    assert.doesNotMatch(r.out, /outside|elsewhere/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a locked worktree that passes every check is unlocked and removed', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-locked');
    git(repo, 'worktree', 'lock', wt);
    oldFiles(wt);
    const r = run(repo, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /remove agent-locked/);
    assert.ok(!existsSync(wt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree-agent-* branches on origin are deleted, other branches are kept', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-two', 'worktree-agent-two');
    git(repo, 'branch', 'my-feature', 'main');
    oldFiles(wt);
    const r = run(repo, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n');
    assert.ok(!branches.includes('worktree-agent-two'), 'agent branch is deleted');
    assert.ok(branches.includes('my-feature'), 'another branch is kept');
    assert.ok(branches.includes('main'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--quiet prints nothing, a bad argument exits 2, and no .claude/worktrees folder is fine', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const wt = add('agent-q');
    oldFiles(wt);
    const quiet = run(repo, '--apply', '--quiet', '--min-age', '0');
    assert.equal(quiet.status, 0, quiet.out);
    assert.equal(quiet.out.trim(), '');
    assert.ok(!existsSync(wt));
    assert.equal(run(repo, '--nope').status, 2);
    assert.equal(run(repo, '--min-age', 'soon').status, 2);
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    assert.equal(run(repo, '--apply').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it also works when started from inside a worktree', () => {
  const { dir, repo, add } = makeRepo();
  try {
    const a = add('agent-a');
    const b = add('agent-b');
    oldFiles(a);
    oldFiles(b);
    const r = run(a, '--apply', '--min-age', '0');
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(repo), 'the main checkout stays');
    assert.ok(!existsSync(b), 'the other worktree is removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
