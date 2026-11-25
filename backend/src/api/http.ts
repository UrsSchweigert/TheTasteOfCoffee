// HTTP plumbing of the API Lambda: responses, body parsing, query parsing.
// Error responses have no body; the status code is the answer
// (contracts/README.md, Shapes). Nothing here logs.
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { z } from 'zod';
import { conformsToVocabulary } from '../vocabulary/check.ts';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;

/**
 * Largest request body accepted, in bytes after base64 decoding. The largest
 * valid body (a brew with every field, five notes, generous whitespace) is
 * well under 2 KiB.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/** `LimitQuery` in contracts/openapi.yaml: integer 1 to 100, default 50. Not generated (parameters are not). */
export const LIMIT_QUERY = { minimum: 1, maximum: 100, default: 50 } as const;

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function json(statusCode: number, body: unknown): ApiResult {
  return { statusCode, headers: { 'content-type': 'application/json', ...NO_STORE }, body: JSON.stringify(body) };
}

/** A response without a body: every error, and 204. */
export function empty(statusCode: number): ApiResult {
  return { statusCode, headers: { ...NO_STORE } };
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function header(event: ApiEvent, name: string): string | undefined {
  // HTTP API lower-cases header names in payload format 2.0.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the event may lack headers at run time
  const headers = event.headers ?? {};
  return headers[name];
}

function hasBody(event: ApiEvent): boolean {
  return event.body !== undefined && event.body !== '';
}

/** The body as UTF-8 text, or undefined if it is too large, not valid base64 or not valid UTF-8. */
function bodyText(event: ApiEvent): string | undefined {
  const raw = event.body ?? '';
  if (!event.isBase64Encoded) {
    // A JS string can hold lone surrogates that are not UTF-8; refuse them.
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES || !raw.isWellFormed()) return undefined;
    return raw;
  }
  // Check the encoded size first, so an oversized body is never decoded.
  if (raw.length > Math.ceil(MAX_BODY_BYTES / 3) * 4 || !BASE64.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > MAX_BODY_BYTES) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** True if the request carries no body, as GET and DELETE must. */
export function hasNoBody(event: ApiEvent): boolean {
  return !hasBody(event);
}

/**
 * Parses and validates a request body, in this order: content type, size,
 * UTF-8, JSON, the generated contract schema (unknown properties rejected),
 * the vocabulary version the body names (ids, ranges and limits of that
 * published version; a draft or unknown version is rejected), then `extra`
 * (method-dependent rules). Returns undefined on any failure (answer 400).
 */
export function parseBody<T extends { vocabulary_version: number }>(
  event: ApiEvent,
  schema: z.ZodType<T>,
  schemaName: string,
  extra: (value: T) => boolean = () => true,
): T | undefined {
  const contentType = header(event, 'content-type');
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType.trim())) return undefined;
  if (!hasBody(event)) return undefined;
  const text = bodyText(event);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return undefined;
  if (!conformsToVocabulary(schemaName, parsed.data, parsed.data.vocabulary_version)) return undefined;
  if (!extra(parsed.data)) return undefined;
  return parsed.data;
}

/**
 * The query parameters, if every name is in `allowed` and none repeats.
 * Undefined otherwise (answer 400). Values are taken as sent: every value the
 * API accepts (a limit, a cursor) is plain ASCII that needs no encoding, so a
 * percent-encoded value simply fails its own check later.
 */
export function parseQuery(event: ApiEvent, allowed: readonly string[]): Map<string, string> | undefined {
  const params = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the event may lack it at run time
  const raw = event.rawQueryString ?? '';
  if (raw === '') return params;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!allowed.includes(name) || params.has(name) || value === '') return undefined;
    params.set(name, value);
  }
  return params;
}

const LIMIT_TEXT = /^[1-9][0-9]{0,2}$/;

/** `limit` from the query: absent gives the default; anything but a plain integer in range is undefined (400). */
export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return LIMIT_QUERY.default;
  if (!LIMIT_TEXT.test(value)) return undefined;
  const limit = Number(value);
  return limit >= LIMIT_QUERY.minimum && limit <= LIMIT_QUERY.maximum ? limit : undefined;
}
