// The HTTP API's routes: exactly the operations of contracts/openapi.yaml.
// test/api.test.ts fails if this list and the contract differ (method and path),
// or if a route's authorisation differs from the contract's `security`.

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Which Lambda serves a route. */
export type RouteTarget = 'api' | 'health';

export interface ApiRoute {
  readonly method: RouteMethod;
  /** Path in the contract's (and API Gateway's) `{param}` syntax. */
  readonly path: string;
  readonly target: RouteTarget;
  /**
   * `jwt`: the Cognito JWT authorizer. `none`: only for the routes in
   * UNAUTHENTICATED_ROUTES, each backed by an ADR.
   */
  readonly auth: 'jwt' | 'none';
}

/**
 * The only routes without the authorizer. ADR 0007: `GET /health`. The App Store
 * notifications route (verified by Apple's signature, docs/05 Subscriptions) joins
 * this list in M4.
 */
export const UNAUTHENTICATED_ROUTES: readonly string[] = ['GET /health'];

const api = (method: RouteMethod, path: string): ApiRoute => ({ method, path, target: 'api', auth: 'jwt' });

export const API_ROUTES: readonly ApiRoute[] = [
  api('GET', '/barcodes/{barcode}'),
  api('GET', '/barcodes/{barcode}/open_food_facts'),
  api('POST', '/beans'),
  api('GET', '/beans/{bean_id}'),
  api('GET', '/catalogue_images/{image_id}'),
  api('GET', '/shelf'),
  api('POST', '/shelf'),
  api('GET', '/shelf/{shelf_entry_id}'),
  api('PUT', '/shelf/{shelf_entry_id}'),
  api('DELETE', '/shelf/{shelf_entry_id}'),
  api('GET', '/brews'),
  api('POST', '/brews'),
  api('GET', '/brews/{brew_id}'),
  api('PUT', '/brews/{brew_id}'),
  api('DELETE', '/brews/{brew_id}'),
  api('GET', '/recipes'),
  api('POST', '/recipes'),
  api('GET', '/recipes/{recipe_id}'),
  api('PUT', '/recipes/{recipe_id}'),
  api('DELETE', '/recipes/{recipe_id}'),
  api('GET', '/profile'),
  api('PUT', '/profile'),
  { method: 'GET', path: '/health', target: 'health', auth: 'none' },
  api('GET', '/export'),
  api('DELETE', '/account'),
];

export function routeKey(route: Pick<ApiRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}
