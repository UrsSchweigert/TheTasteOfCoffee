# 0016 Label photos are uploaded with a presigned POST and stripped by the API

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014); no fixed cost, S3 requests only

## Context

docs/04 F1 step 4: a user who describes an unknown bean by pick lists also photographs the label. The photo goes to a private review queue, and the operator turns it into a verified catalogue entry. Task M1-T4d asks for:

- a presigned upload, limited in size and content type;
- the uploader recorded, so that account deletion (M1-T6, D10) can find the user's photos;
- all metadata stripped before the photo is stored for review or shown (D12).

The photo bucket already exists (`cupmark-<stage>-photos-<account>`, versioned, private). The guardrail boundary allows only `s3:GetObject`, `s3:PutObject` and `s3:ListBucket` on `cupmark-*` buckets. No S3 delete action is allowed yet.

## Decision

1. **Two steps, no new function.**
   - `POST /beans/{bean_id}/label_photos` checks the request and returns a presigned S3 POST for one new photo id. It is allowed only for an unverified bean, with at most 3 photos per bean per user.
   - The app uploads the JPEG straight to S3, to `uploads/<photo_id>.jpg`.
   - The app then calls `POST /label_photos/{photo_id}/complete`. The API reads the upload, checks and strips it with the same JPEG rewriter as the catalogue images (`backend/src/images/jpeg.ts`), and writes the result to `labels/<photo_id>.jpg`.
   - Only then is the photo recorded, so nothing unstripped is ever stored for review or shown.
2. **Presigned POST, not PUT.** The POST policy enforces:
   - the exact key;
   - `Content-Type: image/jpeg`;
   - `content-length-range` 1 byte to 8 MiB;
   - a 10-minute expiry.

   A presigned PUT cannot enforce a size range. The app converts the camera's HEIC to JPEG on the device before uploading.
3. **Limits at completion:**
   - The upload must be at most 8 MiB and a baseline or progressive 8-bit JPEG with at most 4096 px on each side, as the rewriter accepts. A 12-megapixel iPhone photo is 4032 × 3024.
   - Anything else is 400 (the photo is rejected), and nothing is recorded.
4. **Records.**
   - The user partition gets a `PHOTO#<photo_id>` item holding the bean id, so M1-T6 can find a user's photos.
   - The bean gets a `PHOTO#<photo_id>` item that holds no user id, so that verification (D10) can drop the link to the user by deleting the user item alone.
   - Both are written in one transaction, on the condition that the bean is still unverified.
5. **Staging objects are not deleted by the API.** The raw upload under `uploads/` still has its metadata. A lifecycle rule deletes it 1 day after creation, and its noncurrent version after 1 more day. That needs no S3 delete permission, so the guardrails stay as they are. Until then, nothing reads it except the completion call.
6. **Keys carry no user id.** S3 keys show up in logs and in the operator's tooling, so they hold only the random photo id.

## Alternatives

- **An S3 event that triggers a stripping Lambda:** this adds a function, an event notification and a second IAM role, and the app could not learn synchronously whether its photo was accepted.
- **Uploading through the API (base64 body):** API Gateway's 10 MB payload limit and base64 overhead leave little headroom. The Lambda would also pay for the whole transfer.
- **Deleting the raw upload right after completion:** that needs `s3:DeleteObject` and `s3:DeleteObjectVersion` in the boundary, which the owner would have to re-apply. A 1-day lifecycle gives the same result without that.
- **Presigned PUT:** it cannot limit the size.

## Consequences

- **Contract:** two new routes, and server-generated presigned POST fields in a response. Those fields are not free text from a user; contract-keeper defines them with the usual constraints.
- **Infra:**
  - the API role gets `s3:PutObject` on `uploads/*`, needed to sign the POST;
  - it also gets `s3:GetObject` on `uploads/*` and `s3:PutObject` on `labels/*`;
  - a new lifecycle rule expires `uploads/` after 1 day.
- **Cost:** S3 requests and a few MB of storage per photo, pay-per-use. Within docs/06 (300 KB average label photo; the raw upload lives at most two days).
- **Data:** the unstripped original exists for at most about two days, readable only by the API role. If D12 is read to forbid even that, revisit this ADR by adding the delete permissions and deleting the upload at completion.
- **M1-T6:** must delete every version under `labels/<photo_id>.jpg` for the user's photos of unverified beans (D10), and their `uploads/` objects if they are still there. That needs the delete permissions M1-T6 already plans for.
- **Refinements in M1-T4d (lead, ADR 0014; backend/README.md, Label photos):**
  - a daily cap of 20 new uploads per user and UTC day (`USER#<sub>` / `PHOTO_UPLOADS#<day>`, the same atomic conditional counter as the Open Food Facts lookup cap); over it, 429;
  - the upload is started by a pending item `USER#<sub>` / `PHOTO_PENDING#<photo_id>` (TTL 1 day); completion needs it, and a rejected photo (400) deletes it, so a later call is 404;
  - the 3-photo cap is a counter `USER#<sub>` / `BEANPHOTOS#<bean_id>`, raised in the completion transaction on the condition that it is below 3, so parallel completions cannot pass it;
  - a stripped `labels/` object whose transaction then fails is left unreferenced (an orphan, logged as such), as with the catalogue images;
  - `@aws-sdk/s3-presigned-post` is bundled into the API function rather than taken from the Lambda runtime, because the runtime's copy could not be confirmed.
