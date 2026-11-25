// M1-T7: scripts/deploy/deploy-stage.sh, scripts/smoke/health.sh and
// scripts/smoke/post-deploy-checks.sh, run against fake `aws`, `npx` and `curl` that
// answer from fixtures and record every call. PATH holds nothing else that could reach
// AWS or the network.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stripJpeg } from '../../backend/src/images/jpeg.ts';
import { FAKE_ACCOUNT, testApp } from './helpers.ts';

const script = (path: string): string => fileURLToPath(new URL(`../../scripts/${path}`, import.meta.url));
const DEPLOY = script('deploy/deploy-stage.sh');
const HEALTH = script('smoke/health.sh');
const CHECKS = script('smoke/post-deploy-checks.sh');
const BASH = execFileSync('/usr/bin/env', ['bash', '-c', 'command -v bash'], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'cupmark-deploy-scripts-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const DEPLOY_ARN = `arn:aws:sts::${FAKE_ACCOUNT}:assumed-role/CupmarkGitHubDeploy/cupmark-deploy-dev`;
const OWNER_ARN = `arn:aws:sts::${FAKE_ACCOUNT}:assumed-role/Admin/owner`;
const API = 'https://abcde12345.execute-api.eu-central-1.amazonaws.com';
const CONTACT = 'ops@example.invalid';

interface Response {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly bodyHex?: string;
}
/** `METHOD URL` to a response, or to a list answered in turn (the last one repeats). */
type Routes = Record<string, Response | Response[]>;

interface Call {
  readonly argv: string[];
  readonly method: string;
  readonly url: string;
  readonly headers: string[];
  readonly form: string[];
  readonly files: string[];
  readonly data?: string;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aws: string[];
  readonly npx: string[][];
  readonly curl: Call[];
  readonly dir: string;
}

interface Options {
  readonly env?: Record<string, string>;
  readonly arn?: string;
  readonly url?: string;
  readonly routes?: Routes;
  readonly npxExit?: number;
}

const FAKE_CURL = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const routes = JSON.parse(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'));
const args = process.argv.slice(2);
const call = { argv: args, method: 'GET', url: '', headers: [], form: [], files: [] };
let out, dump, format = '';
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const next = () => args[++i];
  if (a === '-o') out = next();
  else if (a === '-D') dump = next();
  else if (a === '-w') format = next();
  else if (a === '-X') call.method = next();
  else if (a === '--max-time') next();
  else if (a === '-H') {
    const v = next();
    if (v.startsWith('@')) call.headers.push(...fs.readFileSync(v.slice(1), 'utf8').split('\\n').filter(Boolean));
    else call.headers.push(v);
  } else if (a === '--data-binary') {
    const v = next();
    call.data = v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8') : v;
    if (call.method === 'GET') call.method = 'POST';
  } else if (a === '--form-string') {
    call.form.push(next());
    call.method = call.method === 'GET' ? 'POST' : call.method;
  } else if (a === '-F') {
    const v = next();
    call.form.push(v);
    const m = /^[^=]+=@([^;]+)/.exec(v);
    if (m) {
      const copy = path.join(dir, 'upload-' + fs.readdirSync(dir).length + '.bin');
      fs.copyFileSync(m[1], copy);
      call.files.push(copy);
    }
    call.method = call.method === 'GET' ? 'POST' : call.method;
  } else if (/^https?:/.test(a)) call.url = a;
}
fs.appendFileSync(path.join(dir, 'curl.log'), JSON.stringify(call) + '\\n');
const key = call.method + ' ' + call.url;
let route = routes[key];
if (Array.isArray(route)) {
  const counter = path.join(dir, 'count-' + Buffer.from(key).toString('hex'));
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  route = route[Math.min(n, route.length - 1)];
}
if (!route) {
  process.stderr.write('curl: (7) Failed to connect\\n');
  if (format) process.stdout.write('000');
  process.exit(7);
}
const body = route.bodyHex !== undefined ? Buffer.from(route.bodyHex, 'hex') : Buffer.from(route.body ?? '');
if (out) fs.writeFileSync(out, body);
if (dump) {
  const lines = ['HTTP/2 ' + route.status, ...Object.entries(route.headers ?? {}).map(([k, v]) => k + ': ' + v)];
  fs.writeFileSync(dump, lines.join('\\r\\n') + '\\r\\n\\r\\n');
}
if (format) process.stdout.write(format.replace('%{http_code}', String(route.status)));
`;

function run(scriptPath: string, args: string[], options: Options = {}): Run {
  const dir = mkdtempSync(join(work, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'tmp'));
  const awsLog = join(dir, 'aws.log');
  const npxLog = join(dir, 'npx.log');
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(options.routes ?? {}));
  writeFileSync(
    join(bin, 'aws'),
    `#!${BASH}
echo "aws $* [key=\${AWS_ACCESS_KEY_ID:-}]" >> "${awsLog}"
case "$*" in
  "sts get-caller-identity --region eu-central-1 --query [Account,Arn] --output text") printf '%s\\t%s\\n' "${FAKE_ACCOUNT}" "${options.arn ?? DEPLOY_ARN}" ;;
  "sts assume-role --region eu-central-1 --role-arn arn:aws:iam::${FAKE_ACCOUNT}:role/cdk-cupmark-lookup-role-${FAKE_ACCOUNT}-eu-central-1 --role-session-name cupmark-smoke-"*" --query Credentials.[AccessKeyId,SecretAccessKey,SessionToken] --output text") printf 'LOOKUPKEY\\tLOOKUPSECRET\\tLOOKUPTOKEN\\n' ;;
  "cloudformation describe-stacks --region eu-central-1 --stack-name cupmark-"*"-core --query Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0] --output text") echo "${options.url ?? API}" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`,
  );
  writeFileSync(
    join(bin, 'npx'),
    `#!${BASH}
printf '%s\\0' "$@" >> "${npxLog}"; printf '\\n' >> "${npxLog}"
echo "npx in $PWD"
exit ${String(options.npxExit ?? 0)}
`,
  );
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}\n${FAKE_CURL}`);
  for (const name of ['aws', 'npx', 'curl']) chmodSync(join(bin, name), 0o755);
  const PATH = `${bin}:/usr/bin:/bin`;
  const resolved = execFileSync(BASH, ['-c', 'command -v aws; command -v npx; command -v curl'], { env: { PATH }, encoding: 'utf8' });
  expect(resolved.trim().split('\n')).toEqual([join(bin, 'aws'), join(bin, 'npx'), join(bin, 'curl')]);
  const r = spawnSync(BASH, [scriptPath, ...args], {
    env: {
      PATH,
      HOME: dir,
      FAKE_DIR: dir,
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      SMOKE_DELAY_S: '0',
      TMPDIR: join(dir, 'tmp'),
      ...options.env,
    },
    encoding: 'utf8',
  });
  const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : []);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    aws: lines(awsLog),
    npx: lines(npxLog).map((l) => l.split('\0').filter((a) => a !== '')),
    curl: lines(join(dir, 'curl.log')).map((l) => JSON.parse(l) as Call),
    dir,
  };
}

const deployEnv = { AWS_REGION: 'eu-central-1', OFF_CONTACT: CONTACT };

describe('scripts/deploy/deploy-stage.sh', () => {
  it.each(['dev', 'prod'])('%s: diff, then deploy of exactly cupmark-%s-core in deploy mode on the cupmark bootstrap', (stage) => {
    const r = run(DEPLOY, [stage], { env: deployEnv });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const context = ['-c', `stage=${stage}`, '-c', `cupmark:deploy=${stage}`, '-c', `cupmark:${stage}:account=${FAKE_ACCOUNT}`, '-c', `cupmark:offContact=${CONTACT}`];
    const common = ['--toolkit-stack-name', 'CDKToolkit-cupmark', '--no-lookups'];
    expect(r.npx).toEqual([
      ['cdk', 'diff', `${stage}/core`, ...context, ...common],
      ['cdk', 'deploy', `${stage}/core`, ...context, ...common, '--exclusively', '--require-approval', 'never', '--ci'],
    ]);
    expect(r.stdout).toMatch(/npx in .*\/infra\n/);
    // The only AWS call is the identity; the CDK CLI does the rest.
    expect(r.aws).toEqual([`aws sts get-caller-identity --region eu-central-1 --query [Account,Arn] --output text [key=]`]);
  });

  it.each(['dev', 'prod'] as const)('%s: the selector <stage>/core is the hierarchical id of exactly cupmark-%s-core', (stage) => {
    // The CDK CLI matches stacks in a Stage by hierarchical id, not by stack name.
    const { stages } = testApp({ context: { stage } });
    expect(stages.map((s) => [s.core.node.path, s.core.stackName])).toEqual([[`${stage}/core`, `cupmark-${stage}-core`]]);
  });

  it('passes OFF_LOOKUP_CAP only when it is set', () => {
    const r = run(DEPLOY, ['dev'], { env: { ...deployEnv, OFF_LOOKUP_CAP: '20' } });
    expect(r.status).toBe(0);
    for (const call of r.npx) expect(call).toContain('cupmark:offLookupCap=20');
    const without = run(DEPLOY, ['dev'], { env: { ...deployEnv, OFF_LOOKUP_CAP: '' } });
    for (const call of without.npx) expect(call.join(' ')).not.toContain('offLookupCap');
  });

  it('masks the account id and the mailbox in GitHub Actions logs', () => {
    const r = run(DEPLOY, ['dev'], { env: { ...deployEnv, GITHUB_ACTIONS: 'true' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`::add-mask::${CONTACT}\n`);
    expect(r.stdout).toContain(`::add-mask::${FAKE_ACCOUNT}\n`);
    expect(r.stdout.indexOf(`::add-mask::${FAKE_ACCOUNT}`)).toBeLessThan(r.stdout.indexOf('== cdk diff'));
  });

  it.each<[string, string[], Options, RegExp]>([
    ['no stage', [], { env: deployEnv }, /Usage/],
    ['an unknown stage', ['staging'], { env: deployEnv }, /Usage/],
    ['--all', ['--all'], { env: deployEnv }, /Usage/],
    ['two stages', ['dev', 'prod'], { env: deployEnv }, /Usage/],
    ['another region', ['dev'], { env: { ...deployEnv, AWS_REGION: 'eu-west-1' } }, /AWS_REGION must be eu-central-1/],
    ['no OFF_CONTACT', ['dev'], { env: { AWS_REGION: 'eu-central-1' } }, /OFF_CONTACT is not set/],
    ['an empty OFF_CONTACT', ['dev'], { env: { ...deployEnv, OFF_CONTACT: '' } }, /OFF_CONTACT is not set/],
    ['a caller that is not CupmarkGitHubDeploy', ['dev'], { env: deployEnv, arn: OWNER_ARN }, /not the role CupmarkGitHubDeploy/],
  ])('refuses %s with exit 2, before cdk runs', (_label, args, options, message) => {
    const r = run(DEPLOY, args, options);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.npx).toEqual([]);
  });

  it('stops when the diff fails, and never deploys then', () => {
    const r = run(DEPLOY, ['dev'], { env: deployEnv, npxExit: 1 });
    expect(r.status).toBe(1);
    expect(r.npx.map((c) => c[1])).toEqual(['diff']);
  });

  it('has no other cdk command (no destroy, bootstrap or --all)', () => {
    const code = readFileSync(DEPLOY, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/--all|destroy|bootstrap|cdk import/);
    expect([...code.matchAll(/npx cdk (\w+)/g)].map((m) => m[1])).toEqual(['diff', 'deploy']);
  });
});

const HEALTHY: Response = { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"status":"ok"}' };

describe('scripts/smoke/health.sh', () => {
  it.each(['dev', 'prod'])('%s: reads ApiUrl as the lookup role when the caller is CupmarkGitHubDeploy, then GET /health', (stage) => {
    const r = run(HEALTH, [stage], { routes: { [`GET ${API}/health`]: HEALTHY }, env: { GITHUB_ACTIONS: 'true' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.aws[1]).toContain(`role/cdk-cupmark-lookup-role-${FAKE_ACCOUNT}-eu-central-1`);
    expect(r.aws[2]).toMatch(new RegExp(`^aws cloudformation describe-stacks --region eu-central-1 --stack-name cupmark-${stage}-core .*\\[key=LOOKUPKEY\\]$`));
    expect(r.stdout).toContain('::add-mask::LOOKUPSECRET');
    expect(r.stdout).toContain('::add-mask::LOOKUPTOKEN');
    expect(r.curl.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/health`]);
    expect(r.curl[0]?.headers).toEqual([]);
  });

  it('any other caller (the owner) reads with its own credentials', () => {
    const r = run(HEALTH, ['dev'], { arn: OWNER_ARN, routes: { [`GET ${API}/health`]: HEALTHY } });
    expect(r.status).toBe(0);
    expect(r.aws.some((l) => l.includes('assume-role'))).toBe(false);
    expect(r.aws[1]).toMatch(/\[key=\]$/);
  });

  it('retries with backoff until the API answers', () => {
    const r = run(HEALTH, ['dev'], {
      routes: { [`GET ${API}/health`]: [{ status: 503, body: '{"message":"Service Unavailable"}' }, { status: 500 }, HEALTHY] },
    });
    expect(r.status, r.stdout).toBe(0);
    expect(r.curl).toHaveLength(3);
    expect(r.stdout).toContain('(attempt 3)');
  });

  it.each<[string, Response | undefined]>([
    ['a 500', { status: 500 }],
    ['another body', { ...HEALTHY, body: '{"status":"ok","version":"1"}' }],
    ['another content type', { ...HEALTHY, headers: { 'content-type': 'text/plain' } }],
    ['no answer at all', undefined],
  ])('fails after SMOKE_ATTEMPTS on %s', (_label, response) => {
    const routes: Routes = response === undefined ? {} : { [`GET ${API}/health`]: response };
    const r = run(HEALTH, ['dev'], { routes, env: { SMOKE_ATTEMPTS: '3' } });
    expect(r.status).toBe(1);
    expect(r.curl).toHaveLength(3);
    expect(r.stderr).toContain('failed after 3 attempts');
  });

  it.each(['http://abcde12345.execute-api.eu-central-1.amazonaws.com', 'https://abcde12345.execute-api.us-east-1.amazonaws.com', 'None', 'https://example.com'])(
    'refuses an output that is not an HTTP API URL in eu-central-1: %s',
    (url) => {
      const r = run(HEALTH, ['dev'], { url, routes: { [`GET ${url}/health`]: HEALTHY } });
      expect(r.status).toBe(1);
      expect(r.curl).toEqual([]);
    },
  );

  it('refuses an unknown stage', () => {
    expect(run(HEALTH, ['staging']).status).toBe(2);
    expect(run(HEALTH, []).status).toBe(2);
  });
});

// ---- post-deploy-checks.sh ----

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const KNOWN = '3017620422003';
const UNKNOWN = '9510000000005';
const IMAGE_ID = '01JDXJ6Q8R4ZK3V5W7X9Y1Z2A3';
const BEAN_ID = '01JDXJ6Q8R4ZK3V5W7X9Y1Z2B4';
const PHOTO_ID = '01JDXJ6Q8R4ZK3V5W7X9Y1Z2C5';
const BUCKET = `cupmark-dev-photos-${FAKE_ACCOUNT}`;
const S3 = `https://${BUCKET}.s3.eu-central-1.amazonaws.com/`;
const JSON_HEADERS = { 'content-type': 'application/json' };

function upload(fields: Record<string, string> = {}): Response {
  return {
    status: 201,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      photo_id: PHOTO_ID,
      expires_at: '2026-11-25T12:10:00Z',
      max_bytes: 8388608,
      upload: {
        url: S3,
        fields: {
          key: `uploads/${PHOTO_ID}.jpg`,
          bucket: BUCKET,
          content_type: 'image/jpeg',
          policy: 'eyJjb25kaXRpb25zIjpbXX0=',
          x_amz_algorithm: 'AWS4-HMAC-SHA256',
          x_amz_credential: 'ASIAEXAMPLEEXAMPLE12/20261125/eu-central-1/s3/aws4_request',
          x_amz_date: '20261125T120000Z',
          x_amz_security_token: 'FwoGZXIvYXdzEXAMPLE',
          x_amz_signature: 'abcdef0123456789',
          ...fields,
        },
      },
    }),
  };
}

function goodRoutes(): Routes {
  return {
    [`GET ${API}/health`]: HEALTHY,
    [`GET ${API}/barcodes/${UNKNOWN}`]: { status: 404 },
    [`GET ${API}/barcodes/${UNKNOWN}/open_food_facts`]: { status: 404 },
    [`GET ${API}/barcodes/${KNOWN}`]: { status: 404 },
    [`GET ${API}/barcodes/${KNOWN}/open_food_facts`]: {
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Nutella', brand: 'Ferrero', image_id: IMAGE_ID }),
    },
    [`GET ${API}/catalogue_images/${IMAGE_ID}`]: {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' },
      bodyHex: 'ffd8ffe000104a464946',
    },
    [`POST ${API}/beans`]: {
      status: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ bean_id: BEAN_ID, vocabulary_version: 1, verified: false, open_food_facts_match: false, picked_attributes: {}, operator_attributes: {} }),
    },
    [`POST ${API}/beans/${BEAN_ID}/label_photos`]: upload(),
    [`POST ${S3}`]: { status: 204 },
    [`POST ${API}/label_photos/${PHOTO_ID}/complete`]: { status: 204 },
  };
}

function checks(args: string[], routes: Routes = goodRoutes(), env: Record<string, string> = {}): Run {
  return run(CHECKS, args, { arn: OWNER_ARN, routes, env: { CUPMARK_ACCESS_TOKEN: TOKEN, ...env } });
}

describe('scripts/smoke/post-deploy-checks.sh', () => {
  it('passes every check against a dev API that behaves as the contract says', () => {
    const r = checks(['dev']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('All post-deploy checks passed.');
    expect(r.stdout).not.toContain('FAIL');
    expect(r.curl.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /health',
      `GET /barcodes/${UNKNOWN}`,
      `GET /barcodes/${UNKNOWN}/open_food_facts`,
      `GET /barcodes/${KNOWN}`,
      `GET /barcodes/${KNOWN}/open_food_facts`,
      `GET /catalogue_images/${IMAGE_ID}`,
      'POST /beans',
      `POST /beans/${BEAN_ID}/label_photos`,
      `POST ${S3}`,
      `POST /label_photos/${PHOTO_ID}/complete`,
    ]);
    // The only AWS call reads the dev stack's ApiUrl with the owner's credentials.
    expect(r.aws.slice(-1)[0]).toMatch(/^aws cloudformation describe-stacks --region eu-central-1 --stack-name cupmark-dev-core /);
  });

  it('sends the token only to the API, from a header file, never on a command line', () => {
    const r = checks(['dev']);
    for (const call of r.curl) {
      expect(call.argv.join(' ')).not.toContain(TOKEN);
      const toApi = call.url.startsWith(API) && !call.url.endsWith('/health');
      expect(call.headers.includes(`Authorization: Bearer ${TOKEN}`), call.url).toBe(toApi);
    }
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.aws.join('\n')).not.toContain(TOKEN);
    // The temporary header file is gone afterwards.
    expect(readdirSync(join(r.dir, 'tmp'))).toEqual([]);
  });

  it('creates an unverified bean with no picks, and posts every presigned field under its S3 name, then a JPEG the server accepts', () => {
    const r = checks(['dev']);
    const bean = r.curl.find((c) => c.url === `${API}/beans`);
    expect(JSON.parse(bean?.data ?? '')).toEqual({ vocabulary_version: 1, attributes: {} });
    const s3 = r.curl.find((c) => c.url === S3);
    expect(s3?.headers).toEqual([]);
    expect(s3?.form.slice(0, -1).sort()).toEqual(
      [
        `key=uploads/${PHOTO_ID}.jpg`,
        `bucket=${BUCKET}`,
        'Content-Type=image/jpeg',
        'Policy=eyJjb25kaXRpb25zIjpbXX0=',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256',
        'X-Amz-Credential=ASIAEXAMPLEEXAMPLE12/20261125/eu-central-1/s3/aws4_request',
        'X-Amz-Date=20261125T120000Z',
        'X-Amz-Security-Token=FwoGZXIvYXdzEXAMPLE',
        'X-Amz-Signature=abcdef0123456789',
      ].sort(),
    );
    expect(s3?.form.at(-1)).toMatch(/^file=@.*label\.jpg;type=image\/jpeg$/);
    const jpeg = readFileSync(s3?.files[0] ?? '');
    expect(jpeg.length).toBeLessThan(200);
    // The backend's own check of label photos (ADR 0016) accepts it.
    expect(stripJpeg(new Uint8Array(jpeg))).toBeDefined();
  });

  it('--lookups-only creates no bean and no label photo', () => {
    const r = checks(['dev', '--lookups-only']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.curl.every((c) => c.method === 'GET')).toBe(true);
  });

  it('checks the bean copy when the known barcode already points to a bean', () => {
    const routes = goodRoutes();
    routes[`GET ${API}/barcodes/${KNOWN}`] = {
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ bean_id: BEAN_ID, verified: false, open_food_facts: { name: 'Nutella', image_id: IMAGE_ID } }),
    };
    routes[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 409 };
    const r = checks(['dev', '--lookups-only'], routes);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // The lookup route would answer 409 for it, so the script does not call it.
    expect(r.curl.some((c) => c.url.endsWith(`${KNOWN}/open_food_facts`))).toBe(false);
  });

  it.each<[string, (routes: Routes) => void, RegExp]>([
    ['a known barcode without image_id', (rt) => {
      rt[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 200, body: '{"name":"Nutella"}' };
    }, /no image_id\. A cached hit is never overwritten/],
    ['an extra field in the product', (rt) => {
      rt[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 200, body: JSON.stringify({ name: 'N', image_id: IMAGE_ID, product_name: 'N' }) };
    }, /not the OpenFoodFactsProduct shape/],
    ['a product with neither name nor brand', (rt) => {
      rt[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 200, body: JSON.stringify({ image_id: IMAGE_ID }) };
    }, /not the OpenFoodFactsProduct shape/],
    ['a name that is too long', (rt) => {
      rt[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 200, body: JSON.stringify({ name: 'x'.repeat(151), image_id: IMAGE_ID }) };
    }, /not the OpenFoodFactsProduct shape/],
    ['a 503 from the lookup (no OFF_CONTACT, or a shape mismatch upstream)', (rt) => {
      rt[`GET ${API}/barcodes/${KNOWN}/open_food_facts`] = { status: 503 };
    }, /OFF_CONTACT is missing or invalid.*\n.*product\.product_name, product\.brands/],
    ['an unknown barcode that Open Food Facts knows', (rt) => {
      rt[`GET ${API}/barcodes/${UNKNOWN}/open_food_facts`] = { status: 200, body: '{"name":"x"}' };
    }, /set UNKNOWN_BARCODE to another one/],
    ['a catalogue image without nosniff', (rt) => {
      rt[`GET ${API}/catalogue_images/${IMAGE_ID}`] = { status: 200, headers: { 'Content-Type': 'image/jpeg' }, bodyHex: 'ffd8ff' };
    }, /catalogue_images.*expected 200 image\/jpeg with nosniff/],
    ['a catalogue image that is not a JPEG', (rt) => {
      rt[`GET ${API}/catalogue_images/${IMAGE_ID}`] = { status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff' }, body: '<html>' };
    }, /catalogue_images.*expected 200/],
    ['a 500 from the upload start (presigner version skew)', (rt) => {
      rt[`POST ${API}/beans/${BEAN_ID}/label_photos`] = { status: 500 };
    }, /label_photos: expected 201.*version skew/],
    ['an upload URL of another bucket', (rt) => {
      const other = upload();
      rt[`POST ${API}/beans/${BEAN_ID}/label_photos`] = { ...other, body: (other.body ?? '').replace(S3, 'https://cupmark-prod-photos-123456789012.s3.eu-central-1.amazonaws.com/') };
    }, /label_photos: expected 201 with a presigned POST for the dev photo bucket/],
    ['an unknown presigned field', (rt) => {
      rt[`POST ${API}/beans/${BEAN_ID}/label_photos`] = upload({ success_action_redirect: 'https://example.com' });
    }, /unknown form field success_action_redirect/],
    ['S3 refusing the upload', (rt) => {
      rt[`POST ${S3}`] = { status: 403 };
    }, /S3 presigned POST: expected 204, got 403/],
    ['a failed completion', (rt) => {
      rt[`POST ${API}/label_photos/${PHOTO_ID}/complete`] = { status: 400 };
    }, /complete: expected 204, got 400/],
    ['an expired token', (rt) => {
      rt[`GET ${API}/barcodes/${UNKNOWN}`] = { status: 401 };
    }, /401: the token is expired/],
  ])('fails with exit 1 on %s', (_label, change, message) => {
    const routes = goodRoutes();
    change(routes);
    const r = checks(['dev'], routes);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toMatch(/\d check\(s\) failed/);
  });

  it.each<[string, string[], Record<string, string>, RegExp]>([
    ['prod', ['prod'], {}, /Refusing stage 'prod'/],
    ['any other stage', ['staging'], {}, /Refusing stage/],
    ['no stage', [], {}, /Usage/],
    ['an unknown option', ['dev', '--all'], {}, /Usage/],
    ['no token', ['dev'], { CUPMARK_ACCESS_TOKEN: '' }, /CUPMARK_ACCESS_TOKEN is not set/],
    ['a token that is not a JWT', ['dev'], { CUPMARK_ACCESS_TOKEN: 'Bearer x' }, /not a JWT/],
    ['a barcode with a wrong check digit', ['dev'], { KNOWN_BARCODE: '3017620422004' }, /valid check digit/],
  ])('refuses %s with exit 2, before any call', (_label, args, env, message) => {
    const r = checks(args, goodRoutes(), env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.curl).toEqual([]);
    expect(r.aws).toEqual([]);
  });

  it('refuses an API URL that is not an HTTP API in eu-central-1', () => {
    const r = run(CHECKS, ['dev'], { arn: OWNER_ARN, url: 'https://example.com', env: { CUPMARK_ACCESS_TOKEN: TOKEN } });
    expect(r.status).toBe(1);
    expect(r.curl).toEqual([]);
  });
});
