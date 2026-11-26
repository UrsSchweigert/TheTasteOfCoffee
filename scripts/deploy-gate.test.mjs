// Tests for the gate step "Skip when nothing deployable changed" of
// .github/workflows/deploy.yml (ADR 0019, addendum). The step's own shell script is
// taken out of the workflow and run with a fake `gh` that answers from canned JSON,
// so what is tested is what runs. Run: node --test scripts/deploy-gate.test.mjs
// (needs `npm ci` in contracts/ for the yaml package, and jq on PATH for the fake gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = createRequire(join(root, 'contracts', 'package.json'))('yaml');
const wf = yaml.parse(readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'));
const step = wf.jobs.gate.steps.find((s) => s.id === 'changes');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const opts = { skip: hasJq ? false : 'jq is not installed' };

const sha = (n) => n.toString(16).padStart(40, '0');
const H = 'b'.repeat(40); // head of the CI run
const B1 = 'c'.repeat(40);
const B2 = 'd'.repeat(40);

// Fake gh: reads FIXTURES (a JSON file) and applies the --jq filter with real jq.
// FIXTURES: { runs: {"1": [...], "2": [...]}, jobs: {"<run id>": [...]}, compare: {...} | null,
// failRuns?: true }. Every call is logged to CALLS.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
url="$2"; shift 2
jq_filter=""
while [ $# -gt 0 ]; do case "$1" in --jq) jq_filter="$2"; shift 2;; *) shift;; esac; done
case "$url" in
  repos/o/r/actions/workflows/deploy.yml/runs\\?*)
    [ "$(jq -r '.failRuns // false' "$FIXTURES")" = false ] || exit 1
    page="\${url##*page=}"
    jq -c --arg p "$page" '{workflow_runs: (.runs[$p] // [])}' "$FIXTURES" | jq -r "$jq_filter" ;;
  repos/o/r/actions/runs/*/jobs\\?*)
    id="\${url#repos/o/r/actions/runs/}"; id="\${id%%/*}"
    jq -c --arg i "$id" '{jobs: (.jobs[$i] // [])}' "$FIXTURES" | jq -r "$jq_filter" ;;
  repos/o/r/compare/*)
    [ "$(jq -c '.compare' "$FIXTURES")" != null ] || exit 1
    jq -c '.compare' "$FIXTURES" | jq -r "$jq_filter" ;;
  *) echo "unexpected gh call: $url" >&2; exit 1 ;;
esac
`;

const dir = mkdtempSync(join(tmpdir(), 'cupmark-gate-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, 'bin'));
writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH);
chmodSync(join(dir, 'bin', 'gh'), 0o755);
writeFileSync(join(dir, 'script.sh'), step.run);

let n = 0;
/** Runs the step; returns { deploy, out, calls }. deploy is 'true', 'false' or undefined (no output). */
function gate(fixtures, { head = H } = {}) {
  n += 1;
  const fx = join(dir, `fx${n}.json`);
  const output = join(dir, `out${n}`);
  const calls = join(dir, `calls${n}`);
  writeFileSync(fx, JSON.stringify(fixtures));
  writeFileSync(output, '');
  writeFileSync(calls, '');
  const r = spawnSync('bash', [join(dir, 'script.sh')], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'x', REPO: 'o/r', HEAD_SHA: head, GITHUB_OUTPUT: output, FIXTURES: fx, CALLS: calls },
  });
  const m = /^deploy=(.*)$/m.exec(readFileSync(output, 'utf8'));
  return { status: r.status, deploy: m?.[1], out: r.stdout + r.stderr, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
}

const run = (id, head) => ({ id, head_sha: head });
const job = (name, conclusion) => ({ name, conclusion });
const compare = (files, status = 'ahead') => ({ status, files: files.map((f) => (typeof f === 'string' ? { filename: f } : f)) });
const deployedBase = { runs: { 1: [run(10, B1)] }, jobs: { 10: [job('gate', 'success'), job('deploy dev', 'success')] } };

test('the step is wired: workflow_run only, after a positive decision, output wins over decide', () => {
  assert.equal(step.if, "github.event_name == 'workflow_run' && steps.decide.outputs.deploy == 'true'");
  assert.equal(wf.jobs.gate.outputs.deploy, '${{ steps.changes.outputs.deploy || steps.decide.outputs.deploy }}');
  assert.ok(!step.uses && !step['working-directory'], 'inline script, no checkout needed');
  assert.deepEqual(Object.keys(step.env).sort(), ['GH_TOKEN', 'HEAD_SHA', 'REPO']);
});

// ---- the path list ----
const DEPLOYABLE = ['backend/src/x.ts', 'infra/lib/a.ts', 'contracts/openapi.yaml', 'scripts/deploy/deploy-stage.sh', '.nvmrc', '.github/workflows/deploy.yml', 'backend/a/b/c/d.json'];
const NOT_DEPLOYABLE = ['ios/App/A.swift', 'docs/05.md', 'backlog/BACKLOG.md', 'scripts/aws/x.sh', 'scripts/smoke/health.sh', 'scripts/check-workflows.mjs', '.claude/agents/a.md', '.github/workflows/ci.yml', '.github/workflows/claude.yml', 'README.md', '.nvmrc.bak', 'backend', 'infra', 'backendx/a', 'xbackend/a', 'docs/backend/a.md', 'scripts/deploy', 'scripts/deployx/a', '.github/workflows/deploy.yml.bak', '.github/workflows/deploy.yaml', 'sub/.nvmrc'];

for (const p of DEPLOYABLE) {
  test(`deployable path deploys: ${p}`, opts, () => {
    const r = gate({ ...deployedBase, compare: compare(['docs/a.md', p]) });
    assert.equal(r.deploy, 'true', r.out);
    assert.match(r.out, new RegExp(`deployable path changed.*${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
}
for (const p of NOT_DEPLOYABLE) {
  test(`other path skips: ${p}`, opts, () => {
    const r = gate({ ...deployedBase, compare: compare([p]) });
    assert.equal(r.deploy, 'false', r.out);
    assert.match(r.out, /nothing deployable changed since the last deployed commit/);
  });
}
test('a mix skips only if no path is deployable, and names the first deployable one', opts, () => {
  assert.equal(gate({ ...deployedBase, compare: compare(NOT_DEPLOYABLE) }).deploy, 'false');
  const r = gate({ ...deployedBase, compare: compare(['ios/a', 'docs/b', 'infra/first.ts', 'backend/second.ts']) });
  assert.equal(r.deploy, 'true');
  assert.match(r.out, /infra\/first\.ts/);
  assert.doesNotMatch(r.out, /backend\/second\.ts/);
});
test('no changed files (identical) skips', opts, () => {
  assert.equal(gate({ ...deployedBase, compare: compare([], 'identical') }).deploy, 'false');
});
test('odd characters: spaces, quotes, unicode, glob characters and a leading dash stay data', opts, () => {
  const odd = ['docs/a b.md', "docs/it's.md", 'docs/"q".md', 'docs/ünï.md', 'docs/*.md', 'docs/$(touch x).md', '-rf', '--help', 'docs/a;b', 'docs/%0A.md'];
  assert.equal(gate({ ...deployedBase, compare: compare(odd) }).deploy, 'false');
  const r = gate({ ...deployedBase, compare: compare(['backend/a b/$(touch x)::error::.ts']) });
  assert.equal(r.deploy, 'true');
});
test('a path with a newline cannot hide a deployable path or inject a workflow command', opts, () => {
  const r = gate({ ...deployedBase, compare: compare(['docs/x\n::error::pwned\nbackend/y.ts']) });
  assert.equal(r.deploy, 'true');
  assert.ok(!r.out.split('\n').some((l) => l.startsWith('::error::')), r.out);
});
test('a rename out of a deployable path counts (previous_filename)', opts, () => {
  const r = gate({ ...deployedBase, compare: compare([{ filename: 'docs/moved.ts', previous_filename: 'backend/src/moved.ts' }]) });
  assert.equal(r.deploy, 'true');
});

// ---- fail open ----
test('no earlier deploy at all: deploys', opts, () => {
  const r = gate({ runs: {}, jobs: {}, compare: compare(['docs/a.md']) });
  assert.equal(r.deploy, 'true');
  assert.match(r.out, /no earlier successful dev deploy/);
  assert.ok(!r.calls.some((c) => c.includes('/compare/')));
});
test('the runs API fails: deploys', opts, () => {
  assert.equal(gate({ failRuns: true, compare: compare(['docs/a.md']) }).deploy, 'true');
});
test('the compare API fails: deploys', opts, () => {
  assert.equal(gate({ ...deployedBase, compare: null }).deploy, 'true');
});
test('status diverged or behind: deploys', opts, () => {
  for (const s of ['diverged', 'behind']) assert.equal(gate({ ...deployedBase, compare: compare(['docs/a.md'], s) }).deploy, 'true');
});
test('300 files or more may be truncated: deploys', opts, () => {
  const many = Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`);
  assert.equal(gate({ ...deployedBase, compare: compare(many) }).deploy, 'true');
  assert.equal(gate({ ...deployedBase, compare: compare(many.slice(0, 299)) }).deploy, 'false');
});
test('a bad head sha deploys', opts, () => {
  assert.equal(gate({ ...deployedBase, compare: compare(['docs/a.md']) }, { head: 'main; rm -rf /' }).deploy, 'true');
});

// ---- BASE selection ----
test('BASE is the newest run whose `deploy dev` job succeeded; skipped and failed ones are passed over', opts, () => {
  const fx = {
    runs: { 1: [run(30, sha(1)), run(20, B1), run(10, B2)] },
    jobs: {
      30: [job('gate', 'success'), job('deploy dev', 'skipped'), job('deploy prod', 'skipped')],
      20: [job('gate', 'success'), job('deploy dev', 'success')],
      10: [job('gate', 'success'), job('deploy dev', 'success')],
    },
    compare: compare(['docs/a.md']),
  };
  const r = gate(fx);
  assert.equal(r.deploy, 'false');
  assert.ok(r.calls.some((c) => c.includes(`/compare/${B1}...${H}`)), r.calls.join('\n'));
  assert.ok(!r.calls.some((c) => c.includes(B2)));
  assert.ok(!r.calls.some((c) => c.includes('/runs/10/jobs')), 'stops at the first match');
});
test('a skipped dev deploy does not move BASE: an unapproved infra change is not dropped', opts, () => {
  // Run 30 (head X) skipped its deploy; the infra change sits between B1 and H.
  const fx = {
    runs: { 1: [run(30, sha(1)), run(20, B1)] },
    jobs: { 30: [job('deploy dev', 'skipped')], 20: [job('deploy dev', 'success')] },
    compare: compare(['infra/lib/api.ts', 'docs/a.md']),
  };
  assert.equal(gate(fx).deploy, 'true');
});
test('a failed or cancelled dev deploy, and a prod-only run, are not BASE', opts, () => {
  const fx = {
    runs: { 1: [run(40, sha(2)), run(30, sha(3)), run(20, sha(4))] },
    jobs: { 40: [job('deploy dev', 'failure')], 30: [job('deploy dev', 'cancelled')], 20: [job('deploy prod', 'success'), job('deploy dev', 'skipped')] },
    compare: compare(['docs/a.md']),
  };
  const r = gate(fx);
  assert.equal(r.deploy, 'true');
  assert.match(r.out, /no earlier successful dev deploy/);
});
test('BASE equal to the head: nothing to compare, skips', opts, () => {
  const r = gate({ runs: { 1: [run(10, H)] }, jobs: { 10: [job('deploy dev', 'success')] }, compare: null });
  assert.equal(r.deploy, 'false');
  assert.ok(!r.calls.some((c) => c.includes('/compare/')));
});
test('BASE is found on the second page; invalid ids and shas in the API answer are ignored', opts, () => {
  const fx = {
    runs: { 1: [run('1; echo hi', B2), run(11, 'not-a-sha')], 2: [run(10, B1)] },
    jobs: { 10: [job('deploy dev', 'success')] },
    compare: compare(['ios/a.swift']),
  };
  const r = gate(fx);
  assert.equal(r.deploy, 'false');
  assert.ok(r.calls.some((c) => c.includes('page=2')));
  assert.ok(r.calls.every((c) => !c.includes('echo hi')));
});
test('it looks at no more than 40 candidates', opts, () => {
  const list = (from) => Array.from({ length: 50 }, (_, i) => run(from + i, sha(from + i + 100)));
  const r = gate({ runs: { 1: list(1000), 2: list(2000) }, jobs: {}, compare: compare(['docs/a.md']) });
  assert.equal(r.deploy, 'true');
  assert.equal(r.calls.filter((c) => /\/runs\/\d+\/jobs/.test(c)).length, 40);
});
test('only runs of the workflow_run event on main with conclusion success are asked for', opts, () => {
  const r = gate({ runs: {}, jobs: {}, compare: null });
  assert.ok(r.calls[0].includes('event=workflow_run') && r.calls[0].includes('status=success') && r.calls[0].includes('branch=main'), r.calls[0]);
  assert.ok(r.calls.every((c) => c.startsWith('api ')), 'only reads');
});
