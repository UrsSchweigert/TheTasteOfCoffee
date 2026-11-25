// The user id is the subject of the Cognito access token, as passed on by the
// API Gateway JWT authorizer. It is never read from the body, path or query
// (CLAUDE.md, invariant 3).
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

/** Cognito `sub`: a lower-case UUID. Anything else is rejected. */
const COGNITO_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns the caller's user id, or undefined if the token has no valid subject (answer 401). */
export function userIdFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  // The optional chain guards against an event that did not pass the authorizer,
  // even though the type says the context is always there.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const sub: unknown = event.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && COGNITO_SUB.test(sub) ? sub : undefined;
}
