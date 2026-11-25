# 0020 No local-only mode without sign-in for now

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost either way

## Context

The owner asked whether the app could work without a sign-in, keeping everything on the device and away from other users. Task M2-T1 asks the lead to decide before the local store (M2-T15) and onboarding (M2-T29) are built.

The backend needs a token on every route except `GET /health`. Without a sign-in the app gets none of these:
- barcode lookup and the shared catalogue;
- the Open Food Facts hit and its image;
- label photos;
- the CSV export through the API;
- sync and backup across devices.

What would still work is pick-list beans kept on the device, shelf, brew, timer, rating, recipes and personal statistics.

## Decision

- M2 requires Sign in with Apple, as docs/03 and docs/04 state. There is no local-only mode in M2.
- Sign in with Apple already keeps the user anonymous to other users: only Apple's opaque id is stored, no name or e-mail address is requested, and aggregates need 5 raters and the user's opt-in (D1).
- The local store (M2-T15) is keyed by account, so a local-only profile can be added later without a migration of other data. If it is added, it is an "offline account": local items stay apart, and are uploaded only when the user signs in and agrees. Pick-list beans then become new unverified beans.
- This is revisited after the TestFlight round with the persona interviews (M6). If testers refuse to sign in, it becomes a task.

## Alternatives

- **Local-only from the start:** two code paths through every screen (with and without catalogue, photos, export and sync), plus an upload and merge flow on a later sign-in. That is a lot of work for a first release, and a scanned bean without the catalogue shows nothing a user would recognise (ADR 0005).
- **Anonymous Cognito identities:** they need an identity pool and extra flows, and still create server-side data.

## Consequences

- No cloud cost.
- Onboarding (M2-T29) starts with Sign in with Apple, then consent.
- docs/07 D16 records the answer.
