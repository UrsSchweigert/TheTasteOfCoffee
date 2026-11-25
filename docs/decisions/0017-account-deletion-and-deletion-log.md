# 0017 Account deletion runs in the request and writes a deletion log outside the table

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no fixed cost, pay-per-use requests and a few bytes of storage

## Context

Task M1-T6 builds `DELETE /account`, `GET /export` and the profile. The owner already decided three things:

- **D10:** every version of the user's label photos of unverified beans is deleted at once; photos of verified beans stay but lose the link to the user.
- **D11:** a deleted user's data may stay in point-in-time recovery (35 days) and the weekly exports (about 395 days) if the privacy policy says so. A deletion log of ids only is kept, and every restore re-applies it before the data is used.
- **From the M1-T2 review:** the Cognito user is deleted too.

D1 (consent) and D2 (aggregates) were still open. The lead decides them here.

## Decision

1. **D1:** opt-in. `consent.contribute_to_aggregates` is false unless the user agrees at onboarding. The aggregator (M3) counts a brew only if its author had consent when it was written.
2. **D2:** subtract, then delete. Deleting the account deletes every brew item. The aggregator subtracts a removed brew using the stream's old image, the same as for any brew delete. Nothing exists to subtract before M3.
3. **Deletion runs in the request.** `DELETE /account` deletes, in this order:
   1. **S3.** Every version and delete marker of `labels/<id>.jpg` and `uploads/<id>.jpg`, for the user's photos of unverified beans. The API lists the versions under that exact key (`ListObjectVersions` with the key as prefix), then calls `DeleteObject` with each `VersionId`.
   2. **The bean-side `PHOTO#` items** of those photos. For photos of verified beans only the user-side item goes, so the photo stays and loses its link (D10).
   3. **Every item in `USER#<sub>`**, with `BatchWriteItem` in pages of 25 items. Retries on unprocessed items.
   4. **The deletion log entry** (point 4 below).
   5. **The Cognito user**, with `AdminDeleteUser` on the stage pool.
   
   It answers 204 only when every step succeeded. A failure answers 500. The app retries, and every step is safe to repeat (idempotent). The deletion log is written before the Cognito user is deleted, so a retry is still authorised by the same token until it expires. A user with thousands of brews needs a few dozen batch calls, well inside the 10-second timeout.
4. **The deletion log lives outside the table,** in a new S3 bucket `cupmark-<stage>-deletion-log-<account>`. Restoring the table from point-in-time recovery or an export would otherwise lose log entries written after the restore point.
   - Each entry is one object, `entries/<ulid>.json`, holding `{ "sub", "photo_ids", "deleted_at" }`. These are ids only, with no other data.
   - The bucket is private, versioned and encrypted with SSE-S3, like the others.
   - A lifecycle rule expires entries after 400 days. That outlives the 365-day exports and the 35-day point-in-time recovery window.
   - The API role may only `s3:PutObject` to `entries/*`. Reading the log is for the operator's restore procedure (M5 restore drill), not for the API.
5. **Export** is `text/csv`, one row per item of the caller (profile, shelf entries, brews, recipes, label photo links). Counters and pending items are left out. The columns are fixed in the contract. Every value is an id, a vocabulary id, a number, a boolean or a timestamp, so there is no free text and nothing to escape except the separator. Even so, values are quoted per RFC 4180, and a leading `=`, `+`, `-` or `@` is never possible because the values are constrained.

## Alternatives

- **Asynchronous deletion through a queue or Step Functions:** more resources, and the app could not confirm that deletion finished. That is only worth it if partitions grow beyond what a 10-second request can handle.
- **The deletion log as items in the table:** lost on restore, as explained above.
- **The deletion log as a prefix in the backups bucket:** that bucket's whole-bucket rule expires objects after 365 days. Scoping that rule to the export prefix would change an existing stateful resource's rules for no other gain.
- **Soft delete (a flag) with a later sweep:** keeps personal data longer than needed, and needs a scheduled job.

## Consequences

- **Boundary and guardrails.** The boundary policy (`scripts/aws/cupmark-boundary-policy.json`) gains:
  - `s3:DeleteObject`, `s3:DeleteObjectVersion` and `s3:ListBucketVersions` on the photo bucket;
  - `cognito-idp:AdminDeleteUser` on `userpool/*`, as for the Apple provider in ADR 0015.

  The owner re-applies the guardrails before the first deploy. This is a human task, tracked as a GitHub issue.
- **The API role** gets exactly what it needs:
  - delete and version-list on the photo bucket, limited to `labels/*` and `uploads/*`, with a prefix condition on the list;
  - `AdminDeleteUser` on the stage's own pool;
  - `s3:PutObject` on the deletion log bucket's `entries/*`.
- **Cost:** one more bucket with no fixed fee; S3 and DynamoDB requests per deletion. Within docs/06.
- **Restore procedure (M5):** before restored data is used, read every log entry newer than the restore point and delete each `sub`'s partition and each bean-side `PHOTO#` item again.
- **The privacy policy (M6)** must disclose the 35-day and 365-day retention, and the 400-day retention of the ids-only deletion log.

## Addendum: tokens issued before deletion (2026-11-25, lead, ADR 0014)

An access token stays valid for up to 60 minutes after `AdminDeleteUser`, and the HTTP API's JWT authorizer does not check revocation. Without a guard, a write sent with such a token after the 204 (for example a queued offline sync) would recreate a partition for the deleted user.

- Account deletion therefore writes a tombstone item `DELETED#<sub>` / `META` in its own partition, outside `USER#<sub>`. It is written before the partition is emptied and holds `expires_at` 2 hours ahead: longer than any token issued before the deletion can live.
- Every write route checks the tombstone in the same transaction (a `ConditionCheck` that it does not exist), or with a strongly consistent read just before the write where the write is a single put. If the tombstone exists, the route answers 401.
- A repeated `DELETE /account` with an old token answers 204 and does nothing further.
- Reads need no check: once the partition is empty they return nothing.
- Cost: one extra read unit per write request, pay-per-use.
