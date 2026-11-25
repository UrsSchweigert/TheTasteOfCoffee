// The user id is the subject of the Cognito access token, as passed on by the
// API Gateway JWT authorizer. It is never read from the body, path or query
// (CLAUDE.md, invariant 3).
//
// `UserId` is a nominal type: a class with an ES private field, so neither a
// string nor an object of the same shape satisfies it. The only way to obtain
// one is `userIdFromEvent`. Its constructor is private to TypeScript and also
// guarded at run time by a token that never leaves this module, so a cast or a
// reflective `new` cannot forge one either. Every user-scoped function of the
// repository takes a `UserId` and checks it with `UserId.is` at run time.
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

/** Cognito `sub`: a lower-case UUID. Anything else is rejected. */
const COGNITO_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MINT: unique symbol = Symbol('UserId');

let mint: (sub: string) => UserId;

export class UserId {
  readonly #sub: string;

  private constructor(token: typeof MINT, sub: string) {
    if (token !== MINT || !COGNITO_SUB.test(sub)) {
      throw new TypeError('a UserId comes only from userIdFromEvent');
    }
    this.#sub = sub;
  }

  static {
    mint = (sub) => new UserId(MINT, sub);
  }

  /** The Cognito subject. Used to build the `USER#` partition key, nothing else. */
  public get value(): string {
    return this.#sub;
  }

  /** True only for an instance made by `userIdFromEvent`; a string or a look-alike object is false. */
  public static is(value: unknown): value is UserId {
    return typeof value === 'object' && value !== null && #sub in value;
  }
}

/** Returns the caller's user id, or undefined if the token has no valid subject (answer 401). */
export function userIdFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): UserId | undefined {
  // The optional chain guards against an event that did not pass the authorizer,
  // even though the type says the context is always there.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const sub: unknown = event.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && COGNITO_SUB.test(sub) ? mint(sub) : undefined;
}
