# Iteration 1: the app on a phone

The first iteration is done when the owner can install the app on their own iPhone and use the core loop: scan a bag, put it on the shelf, log a brew, rate it, and look at the history.

The master agent owns this goal and may change the scope below, with an ADR, if that gets a testable app sooner.

## Approach: local-first

Iteration 1 runs entirely on the device. The specification already requires that scan, brew and rate work offline with a full local copy of the user's data, so nothing built here is thrown away. The backend, sign-in, sync, aggregates and the subscription follow in iteration 2 and attach to the same local store.

This means iteration 1 needs no AWS account, no Apple Developer Program membership and no App Store Connect setup. It needs a Mac with Xcode, an Apple ID and an iPhone (see `ACCESS.md`).

## In scope

- Barcode scan with the camera (EAN-13, UPC-A).
- Bean lookup in Open Food Facts for unknown barcodes, with confirmation.
- Bean entry by pick lists when there is no barcode or no hit, with an optional label photo kept on the device.
- Shelf: beans with purchase date, roast date, bag size, price band.
- Brew log per method with steppers and a timer; saved recipes and one-tap repeat.
- Rating: eight criteria, three intensities, up to five flavour notes, buy again.
- History and personal statistics (average per criterion, best method per bean, taste profile).
- German and English. VoiceOver labels and Dynamic Type on every control.
- No typed text anywhere.

## Out of scope for iteration 1

- Accounts and Sign in with Apple.
- Backend, sync, shared bean catalogue.
- Community aggregates, Explore, subscription and paywall.
- App Attest, CSV export, account deletion (nothing leaves the device yet).

## Exit criteria

1. `xcodebuild test` passes on a simulator, including a UI test of scan (stubbed) to rated brew.
2. `scripts/check-no-free-text.sh` passes.
3. The repeat-brew path takes at most 8 taps and under 30 seconds.
4. A signed build installs and launches on the owner's iPhone; the core loop works in airplane mode, except the Open Food Facts lookup.
5. `docs/run-on-phone.md` lets the owner rebuild and reinstall with one command.
6. `docs/test-script-iteration-1.md` gives the owner a 10-minute test script and a place to note findings.

## After iteration 1

The owner tests on the phone. The master turns the findings into tasks, then plans iteration 2 (backend, sign-in, sync) with `/plan-milestone`.
