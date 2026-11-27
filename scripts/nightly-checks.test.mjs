// Tests for scripts/smoke/nightly-checks.sh (M3-T13), run against a stub `aws` executable
// that answers from fixtures and records every call. PATH holds only the stub and the
// system tools, so nothing can reach AWS. Run: node --test scripts/nightly-checks.test.mjs
// (needs jq and bash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts', 'smoke', 'nightly-checks.sh');
const POST_DEPLOY = join(root, 'scripts', 'smoke', 'post-deploy-checks.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const opts = { skip: hasJq || process.env.CI ? false : 'jq is not installed' };
test('jq is available (required in CI)', () => {
  if (process.env.CI) assert.ok(hasJq, 'jq must be on PATH in CI');
});

const ACCOUNT = '123456789012';
const work = mkdtempSync(join(tmpdir(), 'cupmark-nightly-checks-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'aws.log'), JSON.stringify(args) + '\\n');
const fixtures = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures.json'), 'utf8'));
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const name = flag('--role-name') ?? flag('--name') ?? flag('--function-name') ?? '';
const keys = [args[0] + ' ' + args[1] + ' ' + name, args[0] + ' ' + args[1]];
const key = keys.find((k) => k in fixtures);
if (key === undefined) { process.stderr.write('An error occurred (ResourceNotFoundException): ' + keys[0] + '\\n'); process.exit(254); }
const f = fixtures[key];
if (f === null) { process.stderr.write('An error occurred (ResourceNotFoundException)\\n'); process.exit(254); }
if (args[1] === 'invoke') fs.writeFileSync(args[args.length - 1], JSON.stringify(f.response ?? {}));
process.stdout.write(JSON.stringify(args[1] === 'invoke' ? f.out : f) + '\\n');
`;

const b64 = (text) => Buffer.from(text).toString('base64');
const TABLE_ARN = `arn:aws:dynamodb:eu-central-1:${ACCOUNT}:table/cupmark-dev-main`;
const policyDoc = (stage = 'dev') => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'Logs',
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: `arn:aws:logs:eu-central-1:${ACCOUNT}:log-group:/aws/lambda/cupmark-${stage}-nightly-aggregates:*`,
    },
    { Sid: 'ScanTable', Effect: 'Allow', Action: 'dynamodb:Scan', Resource: TABLE_ARN.replace('dev', stage) },
    {
      Sid: 'WriteAggregates',
      Effect: 'Allow',
      Action: ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem'],
      Resource: TABLE_ARN.replace('dev', stage),
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['BEAN#*', 'RANK#*'] } },
    },
  ],
});
const runLine = (over = {}) =>
  JSON.stringify({
    operation: 'nightly-aggregates',
    status: 'OK',
    dry_run: true,
    duration_ms: 4200,
    share_of_timeout: 0.014,
    items_scanned: 21000,
    users_seen: 200,
    brews_seen: 19599,
    brews_counted: 11527,
    brews_orphaned: 3,
    reasons: { burst: 4, repeat: 2 },
    beans_with_aggregates: 120,
    beans_ranked: 40,
    items_written: 0,
    items_deleted: 0,
    ...over,
  });
const logTail = (line, maxMb = 180) =>
  [
    'START RequestId: 11111111-2222-3333-4444-555555555555 Version: $LATEST',
    `2026-11-28T10:00:00.000Z\t11111111-2222-3333-4444-555555555555\tINFO\t${line}`,
    'END RequestId: 11111111-2222-3333-4444-555555555555',
    `REPORT RequestId: 11111111-2222-3333-4444-555555555555\tDuration: 4310.12 ms\tBilled Duration: 4311 ms\tMemory Size: 512 MB\tMax Memory Used: ${maxMb} MB`,
    '',
  ].join('\n');

function world(stage = 'dev', alarmsOn = false) {
  const p = `cupmark-${stage}`;
  const topic = `arn:aws:sns:eu-central-1:${ACCOUNT}:${p}-alerts`;
  const fixtures = {
    'lambda get-function-configuration': {
      FunctionName: `${p}-nightly-aggregates`,
      Timeout: 300,
      MemorySize: 512,
      Architectures: ['arm64'],
      Role: `arn:aws:iam::${ACCOUNT}:role/${p}-nightly-aggregates`,
      VpcConfig: {},
    },
    'lambda get-function-event-invoke-config': { MaximumRetryAttempts: 0 },
    [`scheduler get-schedule ${p}-nightly-aggregates`]: {
      GroupName: `${p}-jobs`,
      Name: `${p}-nightly-aggregates`,
      ScheduleExpression: 'cron(0 2 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      State: stage === 'dev' ? 'ENABLED' : 'DISABLED',
      Target: { Arn: `arn:aws:lambda:eu-central-1:${ACCOUNT}:function:${p}-nightly-aggregates`, Input: '{}', RetryPolicy: { MaximumRetryAttempts: 1 } },
    },
    [`scheduler get-schedule ${p}-weekly-export`]: {
      GroupName: `${p}-jobs`,
      Name: `${p}-weekly-export`,
      ScheduleExpression: 'cron(0 3 ? * SUN *)',
      ScheduleExpressionTimezone: 'UTC',
      State: 'ENABLED',
      Target: { Arn: 'arn:aws:scheduler:::aws-sdk:dynamodb:exportTableToPointInTime' },
    },
    [`iam list-role-policies ${p}-nightly-aggregates`]: { PolicyNames: [`${p}-nightly-aggregates`] },
    [`iam list-attached-role-policies ${p}-nightly-aggregates`]: { AttachedPolicies: [] },
    [`iam get-role-policy ${p}-nightly-aggregates`]: policyDoc(stage),
    [`iam list-role-policies ${p}-nightly-scheduler`]: { PolicyNames: [`${p}-nightly-scheduler`] },
    [`iam list-attached-role-policies ${p}-nightly-scheduler`]: { AttachedPolicies: [] },
    [`iam get-role-policy ${p}-nightly-scheduler`]: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'InvokeNightlyFunction',
          Effect: 'Allow',
          Action: 'lambda:InvokeFunction',
          Resource: `arn:aws:lambda:eu-central-1:${ACCOUNT}:function:${p}-nightly-aggregates`,
        },
      ],
    },
    'lambda invoke': {
      out: { StatusCode: 200, ExecutedVersion: '$LATEST', LogResult: b64(logTail(runLine())) },
    },
  };
  if (alarmsOn) {
    const alarm = (n, state) => ({ AlarmName: `${p}-nightly-aggregates-${n}`, StateValue: state, AlarmActions: [topic] });
    fixtures['cloudwatch describe-alarms'] = { MetricAlarms: [alarm('errors', 'OK'), alarm('missing-run', 'INSUFFICIENT_DATA')] };
    fixtures['sns get-topic-attributes'] = 1;
  }
  return fixtures;
}

/** Runs a copy of the script in a scratch repo whose infra/src/config.ts has the given flags. */
function run(fixtures, { stage = 'dev', args = [], alarmsOn = false, scheduleOn = stage === 'dev', script = SCRIPT } = {}) {
  const dir = mkdtempSync(join(work, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), STUB);
  chmodSync(join(bin, 'aws'), 0o755);
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures));
  mkdirSync(join(dir, 'repo', 'scripts', 'smoke'), { recursive: true });
  mkdirSync(join(dir, 'repo', 'infra', 'src'), { recursive: true });
  const copy = join(dir, 'repo', 'scripts', 'smoke', 'nightly-checks.sh');
  copyFileSync(SCRIPT, copy);
  copyFileSync(POST_DEPLOY, join(dir, 'repo', 'scripts', 'smoke', 'post-deploy-checks.sh'));
  chmodSync(copy, 0o755);
  const flags = (s) => `  ${s}: { failureAlarms: { enabled: ${s === stage ? alarmsOn : false} }, nightlyScheduleEnabled: ${s === stage ? scheduleOn : s === 'dev'} },`;
  writeFileSync(join(dir, 'repo', 'infra', 'src', 'config.ts'), `export const STAGE_SETTINGS = {\n${flags('dev')}\n${flags('prod')}\n};\n`);
  const target = script === SCRIPT ? copy : join(dir, 'repo', 'scripts', 'smoke', 'post-deploy-checks.sh');
  const r = spawnSync('bash', [target, stage, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_DIR: dir, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', TMPDIR: dir },
    encoding: 'utf8',
  });
  const log = join(dir, 'aws.log');
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, out: r.stdout, err: r.stderr, calls, all: r.stdout + r.stderr };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

test('dev passes: function, schedules, roles; alarms skipped while the flag is off', opts, () => {
  const r = run(world('dev'));
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /All nightly job checks passed\./);
  assert.match(r.out, /PASS {2}function cupmark-dev-nightly-aggregates: timeout 300 s, 512 MB, arm64, no VPC/);
  assert.match(r.out, /PASS {2}function cupmark-dev-nightly-aggregates: asynchronous MaximumRetryAttempts 0/);
  assert.match(r.out, /PASS {2}schedule cupmark-dev-jobs\/cupmark-dev-nightly-aggregates: cron\(0 2 \* \* \? \*\) UTC, ENABLED/);
  assert.match(r.out, /PASS {2}schedule cupmark-dev-jobs\/cupmark-dev-weekly-export: cron\(0 3 \? \* SUN \*\) UTC, ENABLED/);
  assert.match(r.out, /PASS {2}role cupmark-dev-nightly-aggregates: .*LeadingKeys/);
  assert.match(r.out, /SKIP {2}alarms and topic: failureAlarms.enabled is false/);
  assert.ok(!r.calls.some((c) => c[1] === 'invoke'), 'nothing is invoked without --dry-run-job');
  assert.ok(!r.calls.some((c) => c[0] === 'cloudwatch' || c[0] === 'sns'));
});

test('prod expects the schedule DISABLED', opts, () => {
  const ok = run(world('prod'), { stage: 'prod' });
  assert.equal(ok.status, 0, ok.all);
  assert.match(ok.out, /cupmark-prod-nightly-aggregates: cron\(0 2 \* \* \? \*\) UTC, DISABLED/);
  const f = world('prod');
  f['scheduler get-schedule cupmark-prod-nightly-aggregates'].State = 'ENABLED';
  const bad = run(f, { stage: 'prod' });
  assert.equal(bad.status, 1);
  assert.match(bad.err, /FAIL {2}schedule cupmark-prod-jobs\/cupmark-prod-nightly-aggregates: expected .* DISABLED; got .* ENABLED/);
});

const failures = [
  ['a missing function', (f) => { f['lambda get-function-configuration'] = null; }, /FAIL {2}function cupmark-dev-nightly-aggregates: not found/],
  ['a wrong timeout', (f) => { f['lambda get-function-configuration'].Timeout = 900; }, /FAIL {2}function .*timeout 900/],
  ['a wrong memory', (f) => { f['lambda get-function-configuration'].MemorySize = 1024; }, /FAIL {2}function .*memory 1024/],
  ['x86_64', (f) => { f['lambda get-function-configuration'].Architectures = ['x86_64']; }, /FAIL {2}function .*x86_64/],
  ['a VPC', (f) => { f['lambda get-function-configuration'].VpcConfig = { VpcId: 'vpc-0abc' }; }, /FAIL {2}function .*VPC 'vpc-0abc'/],
  ['async retries left at 2', (f) => { f['lambda get-function-event-invoke-config'].MaximumRetryAttempts = 2; }, /FAIL {2}function .*MaximumRetryAttempts 0, got 2/],
  ['no async invoke config', (f) => { f['lambda get-function-event-invoke-config'] = null; }, /FAIL {2}function .*no asynchronous invoke config/],
  ['a missing schedule', (f) => { f['scheduler get-schedule cupmark-dev-nightly-aggregates'] = null; }, /FAIL {2}schedule cupmark-dev-jobs\/cupmark-dev-nightly-aggregates: not found/],
  ['a wrong cron', (f) => { f['scheduler get-schedule cupmark-dev-nightly-aggregates'].ScheduleExpression = 'cron(0 5 * * ? *)'; }, /FAIL {2}schedule .*expected cron\(0 2/],
  ['a disabled dev schedule', (f) => { f['scheduler get-schedule cupmark-dev-nightly-aggregates'].State = 'DISABLED'; }, /FAIL {2}schedule .*ENABLED; got .* DISABLED/],
  ['a schedule input that is a dry run', (f) => { f['scheduler get-schedule cupmark-dev-nightly-aggregates'].Target.Input = '{"dry_run":true}'; }, /FAIL {2}schedule cupmark-dev-nightly-aggregates: expected the target/],
  ['a wrong weekly export cron', (f) => { f['scheduler get-schedule cupmark-dev-weekly-export'].ScheduleExpression = 'cron(0 3 * * ? *)'; }, /FAIL {2}schedule .*weekly-export: expected/],
  ['dynamodb:* on the function role', (f) => { f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement[1].Action = 'dynamodb:*'; }, /FAIL {2}role cupmark-dev-nightly-aggregates: the policy is not the scoped one/],
  ['a wildcard resource', (f) => { f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement[1].Resource = '*'; }, /FAIL {2}role cupmark-dev-nightly-aggregates: the policy is not the scoped one/],
  ['a table wildcard resource', (f) => { f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement[2].Resource = `${TABLE_ARN}/index/*`; }, /FAIL {2}role .*not the scoped one/],
  ['no LeadingKeys condition', (f) => { delete f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement[2].Condition; }, /FAIL {2}role .*not the scoped one/],
  ['a LeadingKeys condition that allows USER#', (f) => { f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement[2].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'].push('USER#*'); }, /FAIL {2}role .*not the scoped one/],
  ['an extra statement', (f) => { f['iam get-role-policy cupmark-dev-nightly-aggregates'].Statement.push({ Sid: 'Extra', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::cupmark-dev-photos-1/x' }); }, /FAIL {2}role .*not the scoped one/],
  ['a managed policy on the role', (f) => { f['iam list-attached-role-policies cupmark-dev-nightly-aggregates'].AttachedPolicies = [{ PolicyName: 'AdministratorAccess' }]; }, /FAIL {2}role cupmark-dev-nightly-aggregates: expected exactly one inline policy/],
  ['a scheduler role that can invoke anything', (f) => { f['iam get-role-policy cupmark-dev-nightly-scheduler'].Statement[0].Resource = '*'; }, /FAIL {2}role cupmark-dev-nightly-scheduler: expected one statement/],
];
for (const [label, mutate, expected] of failures) {
  test(`fails on ${label}`, opts, () => {
    const f = clone(world('dev'));
    mutate(f);
    const r = run(f);
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, expected);
  });
}

test('with the flag on: the alarms are OK or INSUFFICIENT_DATA and the topic exists', opts, () => {
  const r = run(world('dev', true), { alarmsOn: true });
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /PASS {2}alarm cupmark-dev-nightly-aggregates-errors: OK/);
  assert.match(r.out, /PASS {2}alarm cupmark-dev-nightly-aggregates-missing-run: INSUFFICIENT_DATA/);
  assert.match(r.out, /PASS {2}topic cupmark-dev-alerts: exists/);
  assert.match(r.out, /confirmed subscriptions: 1 \(endpoints are not read\)/);
  const sns = r.calls.filter((c) => c[0] === 'sns');
  assert.equal(sns.length, 1);
  assert.equal(sns[0][1], 'get-topic-attributes');
  assert.ok(sns[0].includes('Attributes.SubscriptionsConfirmed'), 'only the count is projected');
  assert.ok(!r.calls.some((c) => c[1] === 'list-subscriptions-by-topic' || c[1] === 'list-subscriptions'));
  assert.ok(!r.all.includes(ACCOUNT), 'the account id is never printed');
});

test('with the flag on: an alarm in ALARM fails, a missing alarm fails, a missing topic fails', opts, () => {
  const inAlarm = world('dev', true);
  inAlarm['cloudwatch describe-alarms'].MetricAlarms[0].StateValue = 'ALARM';
  const a = run(inAlarm, { alarmsOn: true });
  assert.equal(a.status, 1);
  assert.match(a.err, /FAIL {2}alarm cupmark-dev-nightly-aggregates-errors: ALARM/);

  const missing = world('dev', true);
  missing['cloudwatch describe-alarms'].MetricAlarms.pop();
  const m = run(missing, { alarmsOn: true });
  assert.equal(m.status, 1);
  assert.match(m.err, /FAIL {2}alarm cupmark-dev-nightly-aggregates-missing-run: does not exist/);

  const noTopic = world('dev', true);
  noTopic['sns get-topic-attributes'] = null;
  const t = run(noTopic, { alarmsOn: true });
  assert.equal(t.status, 1);
  assert.match(t.err, /FAIL {2}topic cupmark-dev-alerts: not found/);
  assert.ok(!t.all.includes(ACCOUNT));

  const noAlarms = world('dev', true);
  noAlarms['cloudwatch describe-alarms'] = null;
  assert.equal(run(noAlarms, { alarmsOn: true }).status, 1);
});

test('prod with the flag on and the schedule disabled expects only the errors alarm', opts, () => {
  const f = world('prod', true);
  f['cloudwatch describe-alarms'].MetricAlarms.pop();
  const r = run(f, { stage: 'prod', alarmsOn: true });
  assert.equal(r.status, 0, r.all);
  assert.ok(!r.all.includes('missing-run'));
});

test('--dry-run-job invokes once with {"dry_run": true}, prints the figures and passes within the bounds', opts, () => {
  const r = run(world('dev'), { args: ['--dry-run-job'] });
  assert.equal(r.status, 0, r.all);
  const invokes = r.calls.filter((c) => c[1] === 'invoke');
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0][invokes[0].indexOf('--payload') + 1], '{"dry_run": true}');
  assert.equal(invokes[0][invokes[0].indexOf('--function-name') + 1], 'cupmark-dev-nightly-aggregates');
  assert.ok(invokes[0].includes('--log-type') && invokes[0].includes('Tail'));
  assert.match(r.out, /counts: items_scanned=21000 users_seen=200 brews_seen=19599 brews_counted=11527 brews_orphaned=3 /);
  assert.match(r.out, /reasons: burst=4 repeat=2/);
  assert.match(r.out, /NIGHTLY_MEASURE target=dev run=dry-run items_scanned=21000 brews_seen=19599 brews_counted=11527 duration_ms=4200 timeout_ms=300000 share_of_timeout=0.014 max_memory_used_mb=180 memory_mb=512 memory_share=0.352 items_written=0 items_deleted=0/);
  assert.match(r.out, /PASS {2}Max Memory Used 180 MB is within 60% of 512 MB/);
  assert.ok(!r.all.includes(ACCOUNT));
});

const dryFailures = [
  ['a function error', (f) => { f['lambda invoke'].out.FunctionError = 'Unhandled'; f['lambda invoke'].response = { errorType: 'ResourceNotFoundException' }; }, /FAIL {2}dry run: the function returned an error \(Unhandled, ResourceNotFoundException\)/],
  ['a log line without the fixed keys', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(JSON.stringify({ operation: 'nightly-aggregates', status: 'OK', dry_run: true }))); }, /FAIL {2}dry run: the log tail has no run log line with the fixed keys/],
  ['no log line at all', (f) => { f['lambda invoke'].out.LogResult = b64('START\nEND\n'); }, /FAIL {2}dry run: the log tail has no run log line/],
  ['a FAILED log line', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine({ status: 'FAILED' }))); }, /FAIL {2}dry run: the run log line says status FAILED/],
  ['a log line that is not a dry run', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine({ dry_run: false }))); }, /FAIL {2}dry run: the run log line says .* dry_run false/],
  ['a log line that reports writes', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine({ items_written: 5 }))); }, /FAIL {2}dry run: the log line reports writes/],
  ['a duration above 60 s', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine({ duration_ms: 61000, share_of_timeout: 0.203 }))); }, /FAIL {2}duration 61000 ms is above the 60 s budget/],
  ['a share above half of the timeout', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine({ share_of_timeout: 0.51 }))); }, /FAIL {2}share_of_timeout 0.51 is above half/],
  ['Max Memory Used above 60%', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine(), 308)); }, /FAIL {2}Max Memory Used 308 MB is above 60% of 512 MB/],
  ['no REPORT line', (f) => { f['lambda invoke'].out.LogResult = b64(logTail(runLine()).replace(/REPORT.*\n/, '')); }, /FAIL {2}dry run: no 'Max Memory Used'/],
  ['an invocation that cannot be made', (f) => { f['lambda invoke'] = null; }, /FAIL {2}dry run: the invocation failed/],
];
for (const [label, mutate, expected] of dryFailures) {
  test(`--dry-run-job fails on ${label}`, opts, () => {
    const f = clone(world('dev'));
    mutate(f);
    const r = run(f, { args: ['--dry-run-job'] });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, expected);
  });
}

test('the bounds are inclusive: exactly 60 s, half the timeout and 60% of the memory pass', opts, () => {
  const f = world('dev');
  f['lambda invoke'].out.LogResult = b64(logTail(runLine({ duration_ms: 60000, share_of_timeout: 0.2 }), 307));
  const r = run(f, { args: ['--dry-run-job'] });
  assert.equal(r.status, 0, r.all);
});

test('the dry run is skipped, and fails, when the function does not exist', opts, () => {
  const f = world('dev');
  f['lambda get-function-configuration'] = null;
  const r = run(f, { args: ['--dry-run-job'] });
  assert.equal(r.status, 1);
  assert.ok(!r.calls.some((c) => c[1] === 'invoke'));
});

test('post-deploy-checks.sh --dry-run-job and --nightly-only run these checks without a token or an API call', opts, () => {
  for (const args of [['--dry-run-job'], ['--nightly-only', '--dry-run-job']]) {
    const r = run(world('dev'), { args, script: POST_DEPLOY });
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /All nightly job checks passed\./);
    assert.equal(r.calls.filter((c) => c[1] === 'invoke').length, 1);
  }
  const only = run(world('dev'), { args: ['--nightly-only'], script: POST_DEPLOY });
  assert.equal(only.status, 0, only.all);
  assert.equal(only.calls.filter((c) => c[1] === 'invoke').length, 0);
  assert.ok(!only.calls.some((c) => c[0] === 'cloudformation'));
});

test('usage errors and refusals: no AWS call', opts, () => {
  for (const [stage, args] of [['staging', []], ['dev', ['--payload']], ['dev', ['--dry-run-job', 'x']], ['cupmark-dev', []], ['../x', []]]) {
    const r = run(world('dev'), { stage, args });
    assert.equal(r.status, 2, `${stage} ${args.join(' ')}: ${r.all}`);
    assert.equal(r.calls.length, 0);
  }
  const noStage = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(noStage.status, 2);
});

test('read-only: every call is on the allow-list, in eu-central-1, and names only cupmark- resources', opts, () => {
  const allowed = new Set([
    'lambda get-function-configuration', 'lambda get-function-event-invoke-config', 'lambda invoke', 'scheduler get-schedule',
    'iam list-role-policies', 'iam list-attached-role-policies', 'iam get-role-policy', 'cloudwatch describe-alarms', 'sns get-topic-attributes',
  ]);
  for (const stage of ['dev', 'prod']) {
    const r = run(world(stage, true), { stage, alarmsOn: true, args: ['--dry-run-job'] });
    assert.equal(r.status, 0, r.all);
    for (const call of r.calls) {
      assert.ok(allowed.has(`${call[0]} ${call[1]}`), `unexpected call ${call.join(' ')}`);
      assert.equal(call[call.indexOf('--region') + 1], 'eu-central-1');
      for (const flag of ['--function-name', '--role-name', '--policy-name', '--group-name', '--name']) {
        const i = call.indexOf(flag);
        if (i >= 0) assert.match(call[i + 1], new RegExp(`^cupmark-${stage}-[a-z-]+$`), `${flag} in ${call.join(' ')}`);
      }
      const names = call.indexOf('--alarm-names');
      if (names >= 0) for (const n of call.slice(names + 1, call.indexOf('--alarm-types'))) assert.match(n, new RegExp(`^cupmark-${stage}-`));
    }
  }
});

test('the script source has no write verbs, no keys and no other project names', () => {
  const full = readFileSync(SCRIPT, 'utf8');
  const src = full.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  const verbs = new Set([...src.matchAll(/\baws_json ([a-z0-9]+) ([a-z-]+)/g)].map((m) => `${m[1]} ${m[2]}`));
  assert.deepEqual([...verbs].sort(), [
    'cloudwatch describe-alarms', 'iam get-role-policy', 'iam list-attached-role-policies', 'iam list-role-policies',
    'lambda get-function-configuration', 'lambda get-function-event-invoke-config', 'lambda invoke', 'scheduler get-schedule',
    'sns get-topic-attributes',
  ]);
  assert.doesNotMatch(src, /simulate-principal-policy|list-subscriptions|AKIA|ASIA|AWS_SECRET|AWS_ACCESS_KEY|DerSchweigert|--stack-name/);
  assert.doesNotMatch(src, /\b(update|delete|put|create|set|attach|tag|add|remove)-[a-z-]+/);
  // Every resource name in the script is built from the cupmark-<stage> prefix.
  for (const m of src.matchAll(/^(?:FN|SCHEDULE|EXPORT_SCHEDULE|GROUP|SCHED_ROLE|TOPIC|ERRORS_ALARM|MISSING_ALARM|TABLE)="([^"]+)"/gm)) assert.match(m[1], /^\$P(-[a-z-]+)?$/);
  assert.match(src, /^P="cupmark-\$STAGE"$/m);
});
