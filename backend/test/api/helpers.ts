// Test helpers for the API: events as API Gateway HTTP API (payload 2.0) sends
// them after the JWT authorizer, and a harness around createApi with the
// in-memory store and a cursor key generated per test run (never a real key).
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CursorSigner } from '../../src/api/cursor.ts';
import type { ApiEvent } from '../../src/api/http.ts';
import { createApi } from '../../src/api/router.ts';
import type { ApiDependencies, LogEntry } from '../../src/api/router.ts';
import { FakeStore } from './fake-store.ts';

export const ALICE_SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718';
export const BOB_SUB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const BEAN = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';

export interface RequestOptions {
  /** Token subject; null for a request without the authorizer context. Default ALICE_SUB. */
  readonly sub?: string | null;
  /** A value to send as JSON. */
  readonly json?: unknown;
  /** A raw body, sent as is. */
  readonly body?: string;
  readonly base64?: boolean;
  /** The raw query string, without `?`. */
  readonly query?: string;
  readonly headers?: Record<string, string>;
}

export function apiEvent(method: string, path: string, options: RequestOptions = {}): ApiEvent {
  const sub = options.sub === undefined ? ALICE_SUB : options.sub;
  const body = options.json === undefined ? options.body : JSON.stringify(options.json);
  const hasBody = body !== undefined;
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: options.query ?? '',
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...options.headers },
    ...(hasBody ? { body } : {}),
    isBase64Encoded: options.base64 ?? false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'example.invalid',
      domainPrefix: 'example',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
      requestId: 'request-1',
      routeKey: '$default',
      stage: '$default',
      time: '25/Nov/2026:07:30:00 +0000',
      timeEpoch: 0,
      authorizer: sub === null ? undefined : { principalId: '', integrationLatency: 0, jwt: { claims: { sub }, scopes: [] } },
    },
  };
  return event as unknown as ApiEvent;
}

export interface Response {
  readonly status: number;
  readonly body: unknown;
  readonly result: APIGatewayProxyStructuredResultV2;
}

export interface Harness {
  readonly store: FakeStore;
  readonly logs: LogEntry[];
  readonly signer: CursorSigner;
  call(method: string, path: string, options?: RequestOptions): Promise<Response>;
}

export function testSigner(): CursorSigner {
  return new CursorSigner(randomBytes(32));
}

/** A harness around createApi; `overrides.store`, if given, must be a FakeStore (it is what `store` returns). */
export function harness(overrides: Partial<Omit<ApiDependencies, 'store'>> & { store?: FakeStore } = {}): Harness {
  const store = overrides.store ?? new FakeStore();
  store.beans.add(BEAN);
  const signer = testSigner();
  const logs: LogEntry[] = [];
  const api = createApi({
    store,
    cursorSigner: () => Promise.resolve(signer),
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  return {
    store,
    logs,
    signer,
    async call(method, path, options) {
      const result = await api(apiEvent(method, path, options));
      const status = result.statusCode ?? 0;
      // A binary body (base64, the catalogue images) is returned as sent; everything else is JSON.
      const body = result.body === undefined ? undefined : result.isBase64Encoded === true ? result.body : (JSON.parse(result.body) as unknown);
      return { status, result, body };
    },
  };
}

export function shelfBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { vocabulary_version: 1, bean_id: BEAN, purchase_date: '2026-11-20', roast_date: '2026-11-10', bag_size: 'g_250', price_band: 'from_15_to_30', ...overrides };
}

export function brewBody(shelfEntryId: string): Record<string, unknown> {
  return {
    vocabulary_version: 1,
    shelf_entry_id: shelfEntryId,
    brewed_at: '2026-11-25T07:30:00.250+01:00',
    parameters: { method: 'v60', dose_dg: 150, water_g: 250, water_temp_c: 94, brew_time_s: 180, grind_normalised: 4.5, water_type: 'filtered', milk: 'none' },
    rating: {
      scores: { aroma: 8, flavour: 7.5, aftertaste: 7, acidity: 8.5, body: 6, sweetness: 7, balance: 7.5, overall: 8 },
      intensities: { acidity: 'high', body: 'medium', bitterness: 'low' },
      flavour_notes: ['berry', 'jasmine', 'honey'],
      buy_again: true,
    },
  };
}

/** A POST /beans body; `attributes` replaces the picked attributes. */
export function beanBody(overrides: Record<string, unknown> = {}, attributes: Record<string, unknown> = { process: 'washed', roast_level: 'light' }): Record<string, unknown> {
  return { vocabulary_version: 1, attributes, ...overrides };
}

export function recipeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { vocabulary_version: 1, parameters: { method: 'aeropress', dose_dg: 150, water_g: 200, ...overrides } };
}

/** Sets `value` at a dotted path in a copy of `body` (undefined deletes the key). */
export function withField(body: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(body);
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  let node: Record<string, unknown> = copy;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return copy;
}
