# Access requests

The only file where the agents ask the owner for something. The master agent adds requests here; the owner ticks them off. Everything else the master decides itself.

Never paste a secret into this file or anywhere in the repo.

## Already provided

- **AWS and fal.ai credentials** live in an env file in the sibling folder `../derschweigert/` on the owner's machine. Agents never open that file. They run commands through `scripts/with-env.sh <command>`, which loads the values into the command's environment only. If the file has another name or place, set `CUPMARK_ENV_FILE` to its path.
  - Expected keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optionally `AWS_SESSION_TOKEN` or `AWS_PROFILE`), `FAL_KEY`.

## Needed for iteration 1 (app on your phone)

- [ ] **A1 Xcode.** Why: Swift only builds on macOS. Steps: install Xcode from the App Store, open it once, accept the licence. Unblocks: every iOS task past `needs-mac-verification`.
- [ ] **A2 XcodeGen.** Why: the Xcode project is generated from `ios/project.yml` so agents never hand-edit project files. Steps: `brew install xcodegen`. Unblocks: I1-T2.
- [ ] **A3 Apple ID signed in to Xcode.** Why: signing a build for your own iPhone. A free Apple ID is enough for iteration 1; such builds expire after 7 days. Steps: Xcode, Settings, Accounts, add your Apple ID. Then put your Team ID in `ios/Local.xcconfig` as `DEVELOPMENT_TEAM = XXXXXXXXXX` (git-ignored). Unblocks: I1-T12.
- [ ] **A4 iPhone connected and trusted.** Why: installing the build. Steps: connect by cable, tap Trust, enable Developer Mode (Settings, Privacy & Security, Developer Mode). Unblocks: I1-T12.

## Needed later (not for iteration 1)

- [ ] **A5 Apple Developer Program membership.** For TestFlight, Sign in with Apple and subscriptions.
- [ ] **A6 App Store Connect: App ID, Sign in with Apple key, subscription products.**
- [ ] **A7 Confirm the AWS account may host this project's dev stack.** The master will only create resources through this project's CDK stacks, tagged `project=cupmark`, and will never touch anything else in the account. Tick this to allow the first dev deployment.
- [ ] **A8 Claude credential for runs from GitHub (optional).** Run `claude setup-token`, save it as repository secret `CLAUDE_CODE_OAUTH_TOKEN`, and install the Claude GitHub App on this repository.
