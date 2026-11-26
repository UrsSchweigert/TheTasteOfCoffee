# 0036 Xcode Cloud is the TestFlight route; GitHub Actions stays the CI

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014); no AWS cost

## Context

M2-T12 needs a signed build in TestFlight. Signing needs the owner's certificates and profiles, which must not enter the repository or a GitHub secret (invariant 8, CLAUDE.md "Credentials"). The first Xcode Cloud build already ran (refused for the missing icon, fixed in the app-icon PR).

## Decision

- **Xcode Cloud builds and uploads TestFlight builds.** Apple builds from the repository with read access that the owner grants in Xcode (Integrate, then Create Workflow). Apple manages signing for the workflow (automatic signing, team `2F695PTZC6`, which is configuration and not a secret). No certificate, profile or key is stored in the repository, in GitHub or by this project.
- **GitHub Actions stays the CI** for tests and checks on every pull request (`CODE_SIGNING_ALLOWED=NO`). Xcode Cloud does not replace it and does not run on pull requests.
- **Build number:** Xcode Cloud numbers its builds itself: the project file says 1 and the first accepted TestFlight build was 6. No script sets it (an earlier draft had one; it was dropped because it was redundant). The marketing version stays in the project file.
- **Stage:** Release uses `Dev.xcconfig` (ADR 0023), so internal TestFlight builds talk to dev until M6.
- **Cost:** no AWS resource. Compute runs within the hours included in the Apple Developer Program membership; if they run out, more hours are a purchase the owner decides (CLAUDE.md "spends money").

## Alternatives

- **GitHub Actions with fastlane or `xcodebuild -exportArchive` and an App Store Connect API key:** needs signing material or a key as a GitHub secret, and an unpinned tool. Rejected for invariant 8.
- **Archiving by hand on the owner's Mac:** works, but is not repeatable and ties every build to one machine.
- **A `ci_pre_xcodebuild.sh` script that sets `CURRENT_PROJECT_VERSION` from `CI_BUILD_NUMBER`:** rejected, because Xcode Cloud already numbers its builds (build 6 reached TestFlight with the project file saying 1).

## Consequences

- The owner set up the workflow, and Xcode Cloud build 6 was accepted by TestFlight and installed on a device (2026-11-26).
