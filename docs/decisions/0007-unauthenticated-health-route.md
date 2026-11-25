# 0007 The health route needs no token

- Status: accepted
- Date: 2026-11-25
- Decided by: owner (D9)

## Context

The deploy pipeline (M1-T7) runs a smoke test that calls a health route after every deploy. Every other route requires the Cognito JWT, except the App Store notifications route, which is verified by Apple's signature.

## Decision

`GET /health` needs no token. It returns only `{"status":"ok"}`, with a fixed literal: no version, environment or other data. It is throttled like the rest of the API.

## Alternatives

- Requiring a token: rejected, because the pipeline would then need test-user credentials.
- No health route, with the smoke test expecting a 401 from a protected route: not chosen, because a 401 cannot tell a working API from a misrouted one.

## Consequences

- `contracts/openapi.yaml` declares the route with `security: []`. The OpenAPI lint allows exactly this one documented exception; any other route without the bearer token still fails.
- infra-engineer (M1-T2) leaves the authorizer off this route only, and the test that checks every route has the authorizer lists it as an exception, next to the App Store notifications route.
