// The router of the API Lambda: one function behind the HTTP API, a fixed
// table of routes. It dispatches only the routes that have landed: shelf,
// brews and recipes, five operations each (task M1-T5), the bean
// catalogue: GET /barcodes/{barcode}, POST /beans, GET /beans/{bean_id}
// (task M1-T4a, catalogue.ts), and the Open Food Facts lookup
// GET /barcodes/{barcode}/open_food_facts (task M1-T4b, open-food-facts.ts).
//
// Order of checks for every request:
// 1. Route: method and `rawPath` against the table. No match is 404 with no
//    body. That includes the contract routes whose tasks have not landed yet
//    (catalogue images, profile, export, account; the
//    contract declares no 501 for them), /health (its own Lambda, ADR 0007), a
//    trailing slash and any method a path does not declare (the contract
//    declares no 405).
// 2. Caller: `userIdFromEvent`, the token subject only. None is 401.
// 3. Input: path parameters against the contract (ids against the `Id`
//    pattern; a barcode against `Barcode` and its check digit), the query
//    (only `cursor` and `limit`, on lists only), the body (see http.ts,
//    parseBody). Bad input is 400.
// 4. The operation. Repository errors map to 404 (not in the caller's
//    partition, or a referenced bean or shelf entry is missing), 409 (a shelf
//    entry that brews reference is deleted or would change its bean, D14; a
//    bean for a barcode that already points to a bean; a bean from an Open
//    Food Facts hit the server has not cached), 400 (a cursor the repository
//    refuses) and 500 for anything else. A write that raced another write is
//    tried up to three times in all, with a short random wait in between.
//
// Matching uses `rawPath`, so the API must use the `$default` stage (no stage
// prefix in the path). Every response except a 2xx with content has no body.
// One log line per request: operation, status, request id and, on failure,
// the error class name. Never a body, token, header, query, barcode or user id.
import type { z } from 'zod';
import type { UserId } from '../auth/user-id.ts';
import { userIdFromEvent } from '../auth/user-id.ts';
import { IdSchema } from '../generated/contract.ts';
import {
  BarcodeTakenError,
  BeanNotFoundError,
  InvalidCursorError,
  InvalidKeyError,
  InvalidValuesError,
  ItemNotFoundError,
  OpenFoodFactsHitMissingError,
  ShelfEntryBeanLockedError,
  ShelfEntryInUseError,
  ShelfEntryNotFoundError,
  WriteConflictError,
} from '../repository/index.ts';
import { BarcodeParameterSchema, createBean, getBean, lookupBarcode, parseBeanCreate } from './catalogue.ts';
import { lookupOpenFoodFacts } from './open-food-facts.ts';
import type { LookupResult, OpenFoodFactsLookupConfig } from './open-food-facts.ts';
import type { CursorSigner } from './cursor.ts';
import { empty, hasNoBody, json, parseBody, parseLimit, parseQuery } from './http.ts';
import type { ApiEvent, ApiResult } from './http.ts';
import { brewResource, recipeResource, shelfResource } from './resources.ts';
import type { ApiStore, Resource } from './resources.ts';

export interface LogEntry {
  readonly operation: string;
  readonly status: number;
  readonly request_id: string;
  readonly error?: string;
  /** A fixed reason code with some errors (the Open Food Facts lookup's 503). Never input or upstream text. */
  readonly reason?: string;
}

export interface ApiDependencies {
  readonly store: ApiStore;
  /** The cursor signer, or undefined if the key is unavailable (list routes then answer 500). */
  readonly cursorSigner: () => Promise<CursorSigner | undefined>;
  /** The Open Food Facts client and the daily cap. Absent: the lookup answers from the cache only, else 503. */
  readonly openFoodFacts?: OpenFoodFactsLookupConfig;
  readonly log?: (entry: LogEntry) => void;
  /** Wait before retry number `retry` (1, 2) of a write that raced; for tests. Default: 10 to 50 ms, then 20 to 100 ms. */
  readonly retryDelayMs?: (retry: number) => number;
}

/** A write that raced (WriteConflictError) is tried this many times in total. */
export const WRITE_ATTEMPTS = 3;

function jitteredDelay(retry: number): number {
  return retry * (10 + Math.random() * 40);
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Call {
  readonly event: ApiEvent;
  readonly user: UserId;
  /** Path parameters, already checked against the contract pattern. */
  readonly params: Readonly<Record<string, string>>;
  readonly deps: ApiDependencies;
}

/** What an operation returns: the response, and the error class name for the log if it failed. */
interface Outcome {
  readonly result: ApiResult;
  readonly error?: string;
  readonly reason?: string;
}

interface Route {
  readonly method: HttpMethod;
  /** Path template as in contracts/openapi.yaml, split on `/`. */
  readonly segments: readonly string[];
  /** The contract schema of each path parameter. */
  readonly parameters: Readonly<Record<string, z.ZodType<string>>>;
  readonly operation: string;
  readonly handle: (call: Call) => Promise<Outcome>;
}

const BAD_REQUEST: Outcome = { result: empty(400) };
const NOT_FOUND: Outcome = { result: empty(404) };

function failed(status: number, error: unknown): Outcome {
  return { result: empty(status), error: error instanceof Error ? error.name : 'unknown' };
}

/** Maps a repository error to its status. Messages are never used (they are safe, but the status is the answer). */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ItemNotFoundError || error instanceof BeanNotFoundError || error instanceof ShelfEntryNotFoundError) {
    return failed(404, error);
  }
  if (
    error instanceof ShelfEntryInUseError ||
    error instanceof ShelfEntryBeanLockedError ||
    error instanceof BarcodeTakenError ||
    error instanceof OpenFoodFactsHitMissingError
  ) {
    return failed(409, error);
  }
  if (error instanceof InvalidCursorError || error instanceof InvalidKeyError || error instanceof InvalidValuesError) {
    return failed(400, error);
  }
  return failed(500, error);
}

/**
 * Runs a repository call, again after a short random wait if it raced another
 * write: a failed condition that names a change in between, or a transaction
 * cancelled by a concurrent one on the same item (hot shelf entry, ADR 0012).
 * Such a write wrote nothing, so repeating it is safe.
 */
async function attempt<T>(call: () => Promise<T>, delayMs: (retry: number) => number): Promise<T> {
  for (let retry = 1; ; retry += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof WriteConflictError) || retry >= WRITE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs(retry)));
    }
  }
}

async function run(operation: () => Promise<ApiResult>): Promise<Outcome> {
  try {
    return { result: await operation() };
  } catch (error) {
    return outcomeOf(error);
  }
}

/** True if the request has no query string and no body, as get, delete and (for the query) create and replace must. */
function noQuery(event: ApiEvent): boolean {
  return parseQuery(event, [])?.size === 0;
}

function routesOf<I extends { vocabulary_version: number }, O>(resource: Resource<I, O>): Route[] {
  const collection = ['', resource.collection];
  const item = [...collection, `{${resource.idParam}}`];
  // Every item id in these paths is a server-generated `Id` (contracts/openapi.yaml, *IdPath).
  const none = {};
  const id = { [resource.idParam]: IdSchema };
  const idOf = (call: Call): string => call.params[resource.idParam] ?? '';
  const body = (event: ApiEvent): I | undefined =>
    parseBody(event, resource.inputSchema, resource.inputSchemaName, resource.accepts);

  return [
    {
      method: 'GET',
      segments: collection,
      parameters: none,
      operation: resource.operations.list,
      handle: async ({ event, user, deps }) => {
        const query = parseQuery(event, ['cursor', 'limit']);
        if (query === undefined || !hasNoBody(event)) return BAD_REQUEST;
        const limit = parseLimit(query.get('limit'));
        if (limit === undefined) return BAD_REQUEST;
        // Fail closed: without the key no cursor is accepted or issued.
        const signer = await deps.cursorSigner();
        if (signer === undefined) return { result: empty(500), error: 'CursorKeyUnavailable' };
        const given = query.get('cursor');
        const inner = given === undefined ? undefined : signer.verify(resource.collection, user, given);
        if (given !== undefined && inner === undefined) return { result: empty(400), error: 'InvalidCursorError' };
        return run(async () => {
          const page = await resource.list(deps.store, user, inner === undefined ? { limit } : { limit, cursor: inner });
          const next = page.nextCursor === undefined ? {} : { next_cursor: signer.sign(resource.collection, user, page.nextCursor) };
          return json(200, { items: page.items, ...next });
        });
      },
    },
    {
      method: 'POST',
      segments: collection,
      parameters: none,
      operation: resource.operations.create,
      handle: async ({ event, user, deps }) => {
        const input = noQuery(event) ? body(event) : undefined;
        if (input === undefined) return BAD_REQUEST;
        return run(async () => json(201, await attempt(() => resource.create(deps.store, user, input), deps.retryDelayMs ?? jitteredDelay)));
      },
    },
    {
      method: 'GET',
      segments: item,
      parameters: id,
      operation: resource.operations.get,
      handle: async (call) => {
        if (!noQuery(call.event) || !hasNoBody(call.event)) return BAD_REQUEST;
        return run(async () => {
          const found = await resource.get(call.deps.store, call.user, idOf(call));
          return found === undefined ? empty(404) : json(200, found);
        });
      },
    },
    {
      method: 'PUT',
      segments: item,
      parameters: id,
      operation: resource.operations.replace,
      handle: async (call) => {
        const input = noQuery(call.event) ? body(call.event) : undefined;
        if (input === undefined) return BAD_REQUEST;
        return run(async () => json(200, await attempt(() => resource.replace(call.deps.store, call.user, idOf(call), input), call.deps.retryDelayMs ?? jitteredDelay)));
      },
    },
    {
      method: 'DELETE',
      segments: item,
      parameters: id,
      operation: resource.operations.delete,
      handle: async (call) => {
        if (!noQuery(call.event) || !hasNoBody(call.event)) return BAD_REQUEST;
        return run(async () => {
          await attempt(() => resource.remove(call.deps.store, call.user, idOf(call)), call.deps.retryDelayMs ?? jitteredDelay);
          return empty(204);
        });
      },
    },
  ];
}

/** The bean catalogue (M1-T4a). Shared, not user-scoped: the caller only has to be signed in. */
const catalogueRoutes: Route[] = [
  {
    method: 'GET',
    segments: ['', 'barcodes', '{barcode}'],
    parameters: { barcode: BarcodeParameterSchema },
    operation: 'lookupBarcode',
    handle: async ({ event, params, deps }) => {
      if (!noQuery(event) || !hasNoBody(event)) return BAD_REQUEST;
      return run(async () => {
        const found = await lookupBarcode(deps.store, params.barcode ?? '');
        return found === undefined ? empty(404) : json(200, found);
      });
    },
  },
  {
    method: 'GET',
    segments: ['', 'barcodes', '{barcode}', 'open_food_facts'],
    parameters: { barcode: BarcodeParameterSchema },
    operation: 'lookupOpenFoodFacts',
    handle: async ({ event, user, params, deps }) => {
      if (!noQuery(event) || !hasNoBody(event)) return BAD_REQUEST;
      let found: LookupResult;
      try {
        found = await lookupOpenFoodFacts(deps.store, deps.openFoodFacts, user, params.barcode ?? '');
      } catch (error) {
        return outcomeOf(error);
      }
      if (found.status === 200) return { result: json(200, found.product) };
      return {
        result: empty(found.status),
        ...('error' in found ? { error: found.error } : {}),
        ...('reason' in found ? { reason: found.reason } : {}),
      };
    },
  },
  {
    method: 'POST',
    segments: ['', 'beans'],
    parameters: {},
    operation: 'createBean',
    handle: async ({ event, deps }) => {
      const input = noQuery(event) ? parseBeanCreate(event) : undefined;
      if (input === undefined) return BAD_REQUEST;
      return run(async () => json(201, await attempt(() => createBean(deps.store, input), deps.retryDelayMs ?? jitteredDelay)));
    },
  },
  {
    method: 'GET',
    segments: ['', 'beans', '{bean_id}'],
    parameters: { bean_id: IdSchema },
    operation: 'getBean',
    handle: async ({ event, params, deps }) => {
      if (!noQuery(event) || !hasNoBody(event)) return BAD_REQUEST;
      return run(async () => {
        const found = await getBean(deps.store, params.bean_id ?? '');
        return found === undefined ? empty(404) : json(200, found);
      });
    },
  },
];

/** Every route this Lambda serves. */
export const ROUTES: readonly Route[] = [
  ...routesOf(shelfResource),
  ...routesOf(brewResource),
  ...routesOf(recipeResource),
  ...catalogueRoutes,
];

const PARAMETER = /^\{([a-z][a-z0-9_]*)\}$/;

/** The parameters if `path` has the shape of `template` (literal segments equal, parameters non-empty); else undefined. */
function matchPath(template: readonly string[], path: readonly string[]): Record<string, string> | undefined {
  if (template.length !== path.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of template.entries()) {
    const actual = path[index] ?? '';
    const parameter = PARAMETER.exec(segment)?.[1];
    if (parameter === undefined) {
      if (actual !== segment) return undefined;
    } else {
      if (actual === '') return undefined;
      params[parameter] = actual;
    }
  }
  return params;
}

function defaultLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The API handler for the given dependencies. */
export function createApi(deps: ApiDependencies): (event: ApiEvent) => Promise<ApiResult> {
  const log = deps.log ?? defaultLog;
  return async (event) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a malformed event may lack these
    const rawRequestId: unknown = event.requestContext?.requestId;
    const requestId = typeof rawRequestId === 'string' ? rawRequestId : '';
    const done = (operation: string, outcome: Outcome): ApiResult => {
      log({
        operation,
        status: outcome.result.statusCode ?? 500,
        request_id: requestId,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      });
      return outcome.result;
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a malformed event may lack these
    const method = event.requestContext?.http?.method;
    const rawPath: unknown = event.rawPath;
    const path = typeof rawPath === 'string' ? rawPath.split('/') : [];
    let route: Route | undefined;
    let params: Record<string, string> | undefined;
    for (const candidate of ROUTES) {
      if (candidate.method !== method) continue;
      params = matchPath(candidate.segments, path);
      if (params !== undefined) {
        route = candidate;
        break;
      }
    }
    if (route === undefined || params === undefined) return done('unknown', NOT_FOUND);

    const user = userIdFromEvent(event);
    if (user === undefined) return done(route.operation, { result: empty(401) });

    for (const [name, value] of Object.entries(params)) {
      const schema = Object.hasOwn(route.parameters, name) ? route.parameters[name] : undefined;
      if (schema?.safeParse(value).success !== true) return done(route.operation, BAD_REQUEST);
    }

    try {
      return done(route.operation, await route.handle({ event, user, params, deps }));
    } catch (error) {
      return done(route.operation, failed(500, error));
    }
  };
}
