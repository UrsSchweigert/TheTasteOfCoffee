# 0023 Debug builds and the M2 TestFlight builds use the dev stage

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

The app needs the endpoints of one backend stage: the Cognito hosted domain, the public app client id, the API URL and the callback URLs registered on the app client (infra/src/identity.ts). Task M2-T9 puts them in `ios/Config/Dev.xcconfig` and `ios/Config/Prod.xcconfig`. Only dev is deployed during M2; prod is deployed in M6 (backlog, M6 Launch). TestFlight builds are archived with the Release configuration, so Release has to point at a stage that exists, or the M2 TestFlight round (M2-T12, M2-T34) has nothing to talk to.

## Decision

- Both build configurations of the app target, Debug and Release, use `Config/Dev.xcconfig` (`baseConfigurationReference` in `project.pbxproj`). Debug builds and every TestFlight build of M2 therefore talk to dev.
- `Config/Prod.xcconfig` is written now with the prod hosted domain and placeholders, and is not referenced by any configuration. In M6, once prod is deployed and its outputs are known, Release switches to `Prod.xcconfig`. That is one line in `project.pbxproj` and gets its own ADR if it is done differently.
- The values reach the app through `Config/Info.plist` (merged with the generated Info.plist, `GENERATE_INFOPLIST_FILE` stays on) and are checked by `StageConfig`. A missing or malformed value, a placeholder, or a region other than eu-central-1 (invariant 6) shows a "not configured" screen; the app then calls no backend. The values are not secrets: the app client is public and has no secret.
- Until M2-T10 the dev app client id and API URL are placeholders (`PLACEHOLDER-SET-IN-M2-T10`) that `StageConfig` rejects, so a build never calls a wrong host.

## Alternatives

- **A third configuration (Debug, Release-Dev, Release-Prod) or a scheme per stage now:** more project and scheme surface to hand-edit without a Mac, for a prod stage that does not exist before M6.
- **Release uses `Prod.xcconfig` from the start:** every TestFlight build in M2 would show "not configured", which blocks the owner's device checks.
- **A stage switch inside the app:** a runtime choice of backend adds a control and a way to ship a build that points at the wrong stage; build-time configuration has neither.

## Consequences

- A TestFlight build of M2 writes to the dev stage. Dev data is test data; no M2 build is an App Store release.
- M6 must switch Release to `Prod.xcconfig` before the first App Store build. `scripts/ios-scripts.test.mjs` pins both app configurations to `Dev.xcconfig` until then, so the switch is a visible test change.
