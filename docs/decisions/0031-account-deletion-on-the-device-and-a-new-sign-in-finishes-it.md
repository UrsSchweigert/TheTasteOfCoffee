# 0031 Account deletion on the device: a Keychain record, no sign-out before the 204, and a new sign-in finishes it

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014); no cloud cost (the app only calls the existing `DELETE /account` and Cognito's token endpoint)

## Context

M2-T31 builds account deletion in the app (docs/04, Non-functional) on top of `DELETE /account` (ADR 0017 and its Addendum, contracts `deleteAccount`). The server deletes in the request, answers 204 only when every step succeeded, and is safe to repeat; a repeated `DELETE /account` with a token issued before the deletion answers 204. Its last step deletes the Cognito user, after which no new token can be issued for that user. ADR 0017 requires that the app never signs out or discards tokens before the 204.

The task leaves open what happens when the token cannot be refreshed before a 204, and where the "deletion in progress" state lives so that it survives the store being deleted and the app restarting.

## Decision

1. **The rule for a refresh that fails.** If the token cannot be refreshed before a 204 (Cognito answers `invalid_grant`, an account mismatch, or anything else that means "sign in again"), the user is asked to sign in again, and the deletion is retried with the new token. Whichever account that sign-in gives is the one deleted:
   - the same account (the user was not deleted yet, for example a revoked refresh token): `DELETE /account` is sent with its new token and finishes the deletion;
   - another account: Cognito had already deleted the user (a 204 was lost, or a deletion finished on the server after the app stopped waiting), so Sign in with Apple created a new, empty Cognito user with a new `sub`. Deleting it again answers 204 and leaves nothing. The record moves to the new account, and after the 204 the local data of both accounts goes.

   The sign-in screen says so while it waits: "Sign in again to finish deleting your account. The account you sign in with is deleted." The progress screen replaces every signed-in screen during a deletion and offers no sign-out, so this sign-in is the only way another account can appear. There is no cancel once the deletion started: after a 500 the server may already have deleted part of the account, and a half-deleted account that syncs again would be worse than finishing.
2. **Never sign out before the 204.** Nothing in the deletion signs out, discards a token or deletes local data before the 204. A 500, 429, 503, any other failure and a network failure (also of the refresh) are retried with `SyncBackoff` (2 s doubling to 300 s, equal jitter) until a 204. When the session ended itself (`invalid_grant`), `AuthSession` has already dropped a token Cognito refuses; that is the session's existing rule (ADR 0024), not the deletion's. When the session is still saved but cannot be refreshed, the progress screen's "Sign In Again" runs the web sign-in while signed in (`AuthModel.signInAgain()`) and replaces the saved sign-in only once the new one succeeded.
3. **Refresh once, then delete.** Each run (the start, and each resume after a restart or a new sign-in) refreshes the token before its first `DELETE /account`, so a partly finished deletion has the token's whole lifetime for its retries. Later attempts of the run use the token as it is; the API client still refreshes it shortly before it expires and on a 401. A retry after a deletion that finished on the server therefore still gets its 204 with the old token, instead of failing a refresh for a user that no longer exists.
4. **The record lives in the Keychain.** `AccountDeletionRecord` (`requested` or `serverDeleted`, the account the `DELETE` is sent for, and every account whose local data goes) is one generic-password item, service `app.cupmark.Cupmark.deletion.<stage>`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. It is written before anything is stopped or sent, becomes `serverDeleted` after the 204, and is removed last, after the local data and the sign-in are gone. The Keychain is outside the store and Application Support, so deleting them never deletes it, and like the saved sign-in it survives a reinstall: a reinstalled app that is still signed in to an account under deletion resumes the deletion instead of syncing it. If the record cannot be saved, the deletion does not start and nothing is sent.
5. **Nothing more is sent.** While a record exists, `SyncHost` opens no store and runs no engine for any account, and `AuthSession.maySend(as:)`, which the engine, the pull, the label photo queue and the screen uploads ask before each request, is false. A token refresh, a return to the foreground or a restart cannot start them again. A record that cannot be read (before the first unlock) also holds them.
6. **After the 204**, in this order: the store files of each listed account (`<stem>.store`, `-wal`, `-shm`, so the outbox goes with the data), its label photo folder `LabelPhotos/<account>/` with the `Queued` photos (from the M2-T24 and M2-T25 reviews), the cached catalogue images and export files, then the sign-out (the Keychain sign-in, with the note "Your account and its data were deleted"), then the record. Every step is safe to repeat; an app ended at any point after the 204 finishes at the next start without another request.
7. **The tombstone 401 gets a reason** (from the M2-T16 review). When sync asks for sign-in, the app signs out with the note "This account was deleted, or its sign-in ended". After the refresh the two cases answer the same, so the note names both, and nothing local is removed automatically (M2-T30's decision stands).

## Alternatives

- **Sign out and give up when the refresh fails:** would leave a half-deleted account, or a Cognito user that still exists, with no way to finish from the app.
- **Delete only the original account and never another:** after a lost 204 the user is already gone; the new sign-in is a new, empty Cognito user that would stay behind. Asking which account to delete would need a choice the user cannot make better than the rule above.
- **Refresh before every attempt:** after the server deleted the Cognito user, every refresh fails, so a retry that the old token would have finished would instead ask for a sign-in.
- **The record as a file in Application Support:** lost on a reinstall while the Keychain sign-in survives, so the reinstalled app would sync to a half-deleted account. A file inside the store would be deleted with it.
- **A cancel button during the deletion:** see point 1.

## Consequences

- If the user signs in with a different Apple ID on the "finish deleting" screen, that account is deleted; the screen says so before the sign-in.
- A deletion shows its progress instead of the shelf until the 204; offline it waits and retries, also across restarts.
- Cost: none beyond the `DELETE /account` requests ADR 0017 already counts and a Cognito token request per run.
- Revisit if the server's deletion becomes asynchronous (ADR 0017, Alternatives), since the 204 would then no longer mean "deleted".
