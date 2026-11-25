# 0024 iOS sign-in: an ephemeral web flow, an Apple-style button of our own, and a local account key

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no cloud cost

## Context

M2-T11 signs the app in through the Cognito hosted UI with Sign in with Apple as the only provider (infra/src/identity.ts: public app client, `openid`, `cupmark://auth`, 60-minute access and id tokens, 30-day refresh token, token revocation on). The task leaves five choices open: whether the web sheet shares Safari's cookies, which button to show, what order sign-out runs in, how a refresh that fails offline is reported, and what the local store (M2-T15) is keyed by.

## Decision

- **Ephemeral web session.** `ASWebAuthenticationSession` runs with `prefersEphemeralWebBrowserSession = true` and the callback scheme `cupmark`. No Cognito or Apple cookie outlives the sign-in, so sign-out needs no hosted `/logout` call and `cupmark://signout` stays registered but unused; a later sign-in cannot silently reuse the previous user's web session; iOS shows no "wants to use ... to sign in" alert. Apple asks for the Apple ID on each sign-in, which is rare with a 30-day refresh token. No URL scheme is registered in Info.plist.
- **Our own Apple-style button.** `AuthenticationServices.SignInWithAppleButton` always starts the native `ASAuthorizationController` request when tapped; it has no way to run another action. That request needs the Sign in with Apple entitlement and yields an Apple identity token the hosted UI cannot take. The app therefore draws the button itself to the Human Interface Guidelines (black on light, white on dark, the `apple.logo` symbol before Apple's wording "Sign in with Apple" / "Mit Apple anmelden", rounded rectangle, at least 44 points, Dynamic Type) and starts the web flow, which goes through the Services ID. The app needs no entitlement.
- **Sign-out clears first, then revokes.** The refresh token is taken, memory and the Keychain are cleared, the screen returns to sign-in, and then `/oauth2/revoke` is called. If the app ends or the network fails during the revoke, the device is still signed out; the token then expires at Cognito within 30 days. The task text says "revoke, then clear"; this order keeps the acceptance (revoke and clear, a failed revoke still clears) and closes the window in which a killed app stays signed in.
- **Offline is not signed out.** A Cognito request that fails in transport throws `APIError.transport`, and `APIClient` passes that through from the token provider instead of turning every provider failure into `unauthorized`. Likewise a Cognito 5xx or an unusable token response is `serviceUnavailable` and a Cognito 429 is `tooManyRequests`, so the outbox backs off; only `invalid_grant` (expired or revoked refresh token), no saved sign-in and an account mismatch are `unauthorized`, and only `invalid_grant` and an account mismatch end the session. The app opens signed in offline: the account is read from the Keychain without a request.
- **The local account key is a hash of `sub`.** `AccountID` is the lowercase hex SHA-256 of the id token's `sub`, read without verifying the token's signature. That is acceptable because the token was just received over TLS from the stage's Cognito domain for a code or refresh token only this app holds, and the value only selects a local store; nothing the server trusts depends on it, and the backend verifies the access token on every request (invariant 3). Hashing keeps the value file-name safe and different from the server's user id, so it cannot be sent as one by mistake. It is saved with the refresh token in one Keychain item (generic password, service `app.cupmark.Cupmark.auth.<stage>`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). The access token stays in memory; the id token is dropped after its `sub` is read.

## Alternatives

- **Shared web session:** would need a hosted `/logout` round trip on sign-out, or the next sign-in would come back as the same user without asking.
- **Native Sign in with Apple and a token exchange with Cognito:** needs the entitlement, and a user pool cannot redeem a native Apple identity token for its own tokens, so it would need a custom backend step (the option docs/05 keeps for past 10,000 monthly users). The hosted UI is what infra/src/identity.ts set up.
- **Overlaying `SignInWithAppleButton` and swallowing its tap:** fragile and still a native-API control used for a different flow.
- **Raw `sub` as the store key:** works, but is the server's user id in clear on disk and in file names.

## Consequences

- M2-T15 opens the store for `AuthModel.accountID` (also passed to `AuthGate`'s content). Sign-out and account deletion (`AuthModel.signOut()`, which clears locally even when the revoke fails) leave no tokens on the device; deleting the local store on sign-out is M2-T15's decision.
- Keychain items survive a reinstall, so a reinstalled app is still signed in until the refresh token expires or is revoked.
- The scan-to-rated-brew UI test needs a signed-in state; it must inject a fake `AuthModel` (fake `WebAuthenticator`, `TokenEndpoint` and `CredentialStore`) rather than run the web sheet.
