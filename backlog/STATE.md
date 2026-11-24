# State
Updated: 2026-11-24, session 0 (repo set up, no agent session has run yet)
Goal: iteration 1, the app installed on the owner's iPhone with the core loop working offline
Progress: 0 of 12 tasks toward the goal

## Last session
- Repository created with documents, agent team and backlog. No product code yet.

## Decisions made
- ADR 0001: serverless AWS stack, iOS-only client.
- ADR 0002: iteration 1 is local-first, no backend; master agent decides, owner grants access.

## Waiting on access
- A1 to A4 in ACCESS.md block I1-T12 (install on the phone). Nothing blocks I1-T1.

## Next
1. I1-T1 Vocabulary v1: everything else reads from it.
2. I1-T2 iOS project skeleton.
3. I1-T3 Local data model.

## Notes for the next session
- The owner runs sessions on their own machine. If Xcode is missing there, iOS tasks end at `needs-mac-verification`.
- AWS and fal.ai credentials are available through `scripts/with-env.sh` only. Not needed for iteration 1 except fal.ai for the app icon.
