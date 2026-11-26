# 0035 Xcode Cloud is the TestFlight route; GitHub Actions stays the CI

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014); no AWS cost

## Context

M2-T12 needs a signed build in TestFlight. Signing needs the owner's certificates and profiles, which must not enter the repository or a GitHub secret (invariant 8, CLAUDE.md "Credentials"). The first Xcode Cloud build already ran (refused for the missing icon, fixed in the app-icon PR).

## Decision

- **Xcode Cloud builds and uploads TestFlight builds.** Apple builds from the repository with read access that the owner grants in Xcode (Integrate, then Create Workflow). Apple manages signing for the workflow (automatic signing, team `2F695PTZC6`, which is configuration and not a secret). No certificate, profile or key is stored in the repository, in GitHub or by this project.
- **GitHub Actions stays the CI** for tests and checks on every pull request (`CODE_SIGNING_ALLOWED=NO`). Xcode Cloud does not replace it and does not run on pull requests.
- **Build number:** `ios/ci_scripts/ci_pre_xcodebuild.sh` sets `CURRENT_PROJECT_VERSION` to `CI_BUILD_NUMBER`. Outside Xcode Cloud it does nothing. The marketing version stays in the project file.
- **Stage:** Release uses `Dev.xcconfig` (ADR 0023), so internal TestFlight builds talk to dev until M6.
- **Cost:** no AWS resource. Compute runs within the hours included in the Apple Developer Program membership; if they run out, more hours are a purchase the owner decides (CLAUDE.md "spends money").

## Alternatives

- **GitHub Actions with fastlane or `xcodebuild -exportArchive` and an App Store Connect API key:** needs signing material or a key as a GitHub secret, and an unpinned tool. Rejected for invariant 8.
- **Archiving by hand on the owner's Mac:** works, but is not repeatable and ties every build to one machine.
- **Xcode Cloud managed versioning only:** it does not exist as a setting in a hand-written project; the script is explicit and tested.

## Consequences

- The owner does the one-time Xcode Cloud setup and reports the first installed TestFlight build number; M2-T12 stays `needs-mac-verification` until then.
- Xcode Cloud reads the repository, including `ios/ci_scripts`, so that script runs in Apple's environment and must stay free of network calls and secrets (a static test checks it).
