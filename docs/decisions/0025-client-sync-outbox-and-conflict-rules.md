# 0025 Client sync: an ordered outbox per account, and how each answer is handled

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014), task M2-T16; no cloud cost

## Context

The app writes to its SwiftData store first and syncs later (docs/04, Non-functional: Offline; Durability: no loss of a confirmed write). M2-T16 has to say how local writes reach the API, in which order, and what the app does with each answer of the write routes in `contracts/openapi.yaml`. The task leaves these points open:

- where the queue lives;
- how a write that references an item with no server id yet is sent;
- how an answer that never arrived is retried without a duplicate, given that the contract has no idempotency key;
- what a 401 for a deleted account (ADR 0017, Addendum) means on the device;
- how sign-out stops sync.

## Decision

- **The queue is in the store.** `OutboxOperation` is a SwiftData model of the account's own store, holding:
  - a sequence number;
  - a resource and action (create, update or delete of a shelf entry, brew or recipe; create of a bean; update, meaning `PUT`, of the profile);
  - the item's local id;
  - an attempt count and `nextAttemptAt`;
  - `sentWithoutAnswer`;
  - a parked flag with a reason.

  It is added to `CupmarkSchemaV1` rather than to a version 2: nothing has been released, so no store with the shorter model list exists outside development. The first released schema is version 1 with the outbox. Every `AccountStore` write inserts its operation before its one save, so the item and its operation are on disk together or not at all. Models get `syncIssueRaw`, the flag shown for an item.
- **Order.** A `SyncEngine` per account sends the lowest sequence that is not parked, one operation at a time. A retry holds the queue, so later writes never overtake earlier ones. That also keeps two of the user's own brew writes off one shelf entry at the same moment (ADR 0012). The engine runs on the main actor with the screens' `ModelContext`, so the two never see stale copies of each other's changes; only the requests leave the main actor. Screens therefore edit drafts and write them through `AccountStore`: the engine's saves save the shared context.
- **References resolve at send time.** An operation names its item by local id only. The body is built from the item's current values when it is sent, and a shelf entry's bean or a brew's shelf entry is read through the relationship. The request therefore carries whatever server id the referenced item has by then. The referenced item's create always sits earlier in the queue; if it was parked, the dependent operation is parked too (`missing_reference`). An edit is not queued again while a create or update that has not been sent carries it.
- **Answers** (after `APIClient`'s one refresh and one retry on a 401):
  - 2xx: the server id is stored. The server values are stored too, unless a later operation for the item is queued. The operation is removed.
  - Transport failure, 429, 503, other 5xx: retried after `min(300 s, 2 s × 2^(n−1))`, of which a random half is jitter (equal jitter). The same holds when Cognito fails while refreshing (ADR 0024). `n` counts every attempt, including the check before a create is sent again, so a failing check backs off too.
  - `unauthorized`: the engine stops and asks for sign-in; every operation is kept. The app signs out, so the sign-in screen shows. ADR 0017's tombstone 401 is the same case: a token issued before an account deletion must sign in again, and nothing is dropped. Signing in with a new account opens another store, so the old operations are never sent with the new account's token.
  - 400: parked and never retried; the item is flagged `rejected`. The same applies to a 404 on a create (the bean or shelf entry it names does not exist) and to an answer that breaks the contract.
  - 404 on `DELETE`: done.
  - 404 on `PUT`: the backend answers 404 both when the item is gone and when a reference in the body is (an unknown or rejected bean on `PUT /shelf/{id}`, a deleted shelf entry on `PUT /brews/{id}`). So the engine reads the item with `GET`. A 404 means the item is gone: the local item and its operations are removed. A 200 means the reference was refused: the operation is parked as `rejected`, the item is flagged and kept. A transport failure or 5xx is retried with backoff. (Corrected after review, lead, ADR 0014: the first version removed the item on any 404.)
  - 409 on a shelf `DELETE`: brews still reference the entry, so it is restored and flagged `delete_restored`.
  - 409 on a shelf `PUT` (D14): the entry is read again, the server's bean is linked back (fetched if not cached), the entry is flagged `bean_change_reverted`, and the other values are sent again.
  - 409 on `POST /beans`: the barcode already has a catalogue bean, which is looked up and adopted.
- **Ambiguous creates.** `sentWithoutAnswer` is saved before each request. It is cleared only by an answer that says the server did nothing (400, 401, 404, 409, 429, or a transport failure in which no connection was made: no internet, host not found, cannot connect, DNS failure) or by the check below. A create that still has the flag is checked before it is sent again, including after the app was ended mid-request. The engine lists the resource and adopts a server item that matches and has no local counterpart:
  - a brew with the same `shelf_entry_id` and `brewed_at`;
  - a shelf entry with the same bean and values;
  - a recipe with the same parameters.

  The check matches the body that was last sent (`sentBody`, saved with the flag), not the item's current values, so an edit made while the answer was unknown does not hide the server's copy; the edit goes out as the update queued behind the create. A retry therefore does not create a duplicate, and the contract does not change. Deleting a pending create that may already be on the server queues a delete after it instead of dropping it.
- **Two devices.** `PUT` replaces the whole item and the contract carries no version, so the last write to reach the server wins. The next pull (M2-T17) shows the winner.
- **Sign-out.** `SyncHost` follows the signed-in account. It acts on a sign-in-required stop only from its current engine and only for the signed-in account, and signs out only while the session is still saved, so a session that ended itself keeps its "session expired" note. On a change it stops the old engine first: the request in flight is cancelled and nothing more is sent. Before every request the engine also asks `AuthSession` whether its account is still the signed-in one. The app's one `APIClient` (M2-T14) is shared; the account check, not a second client, keeps one account's outbox off another account's token.

## Alternatives

- **An idempotency key on every create.** It would make retries exact, but it needs a contract change, a new attribute and conditional writes on the backend. The list-and-adopt check reaches the same result for the user's own small lists without either.
- **Snapshots of the body in the operation.** A snapshot would have to be rewritten when a referenced item gets its server id, and again on every later edit. Building the body at send time needs neither.
- **A separate actor with its own `ModelContext`.** It would keep sync off the main actor, but two contexts on one store see each other's changes only after a fetch. That risks stale values in either the screens or the engine. The requests are the slow part, and they already run off the main actor.
- **Parallel sends per resource.** Faster after a long offline period, but it breaks the order between, for example, a shelf entry and its brews, and races brew writes on one entry (ADR 0012).

## Consequences

- No cloud cost: the check lists the user's own items, a few small paged reads, and only after an ambiguous create.
- A pick-list bean without a barcode has nothing to match, so a lost answer to its `POST /beans` can leave an unused duplicate bean in the catalogue. It holds no user data and is harmless.
- A head-of-line retry delays every later write by up to 5 minutes per attempt. That is the price of keeping the order.
- Parked operations stay on the device with their flagged items until the screens (M2-T18) offer to remove or redo them. The flags are not cleared by later successes; the screens clear them once shown.

## Addendum (M2-T18, lead, ADR 0014; no cloud cost)

The screens offer the two ways out (`AccountStore.syncIssues()`, `redo(_:)`, `discard(_:)`):

- **Redo** of a parked operation clears `parked`, its reason, the attempt count and the wait, so it goes out again at its own sequence, built from the item's current values. A parked create of the item it references (a shelf entry's bean; a brew's shelf entry and that entry's bean) is redone with it; otherwise it would only be parked again as `missing_reference`. The flags of the redone items are cleared.
- **Discard** of a parked create, or of any parked operation of an item with no server id, removes the item and its operations, but not while brews on the device reference the shelf entry or shelf entries name the bean. Discard of a parked update or delete removes the parked operations and takes the item's state from what still waits: a waiting delete keeps it `pendingDelete`, a waiting update `pendingUpdate`, nothing waiting `synced`, so the next pull gives it the server's values; a refused delete brings the item back into the lists. The screen asks for that pull. Discard reads the item's parked operations again first: if none is parked any more (a row shown before a redo), it only clears the flag and removes nothing.
- A flag without a parked operation (`bean_change_reverted`, `delete_restored`, an old `rejected`) has nothing to send or drop: the screen's "OK" clears it.

## Addendum (M2-T25, ios-engineer under the lead's delegation, ADR 0014; no cloud cost)

Offline scan and pending beans (docs/04, Non-functional: Offline). The answer to a miss and to a rejected hit is the lead's decision after review (ADR 0014).

- **A pending bean is a bean with an operation of its own kind.** A barcode scanned while the lookup cannot answer (no network, 5xx, a throttling or daily-cap 429) is saved, when its bag is put on the shelf, as a `StoredBean` with the barcode and no server id and an operation `look_up`, in the same save as the shelf entry. A cancelled shelf form stores nothing. The states are outbox actions (`look_up`, `await_confirmation`, `await_description`); no model of schema version 1 changed.
- **A pending bean lives for its shelf entries.** Removing its last entry removes it with its operations and queued label photos, and the engine drops a pending bean it finds without a live entry instead of looking it up. Questions are only asked about beans on the shelf.
- **Resolution.** `look_up` asks `GET /barcodes/{barcode}`: a known bean is used without asking. A 404 asks `GET /barcodes/{barcode}/open_food_facts`:
  - a hit is kept on the bean (shown only on the question screen, never as the bean's name before the answer, never sent back) and the operation becomes `await_confirmation`;
  - a miss becomes `await_description`.

  The app asks the next time it comes to the foreground. A hit offers Confirm (`POST /beans` with `open_food_facts_confirmed` and the optional picks) or "Not my coffee". A miss, and a rejected hit, then offer the pick lists and a label photo as online (docs/04 F1 step 4, the same `BeanEntryScreen`), with "Skip", which creates the bean from its barcode alone. So a barcode scanned offline never silently becomes a bean the user could not describe. The operations that need the bean wait meanwhile.
- **A bean described with pick lists while offline** is a plain `create` (with its barcode a 409 adopts the catalogue's bean, as before), so it is created without asking. It is never looked up in Open Food Facts later: once its barcode has a bean, the Open Food Facts route answers 409, so such a bean never gets the Open Food Facts name or image. A second offline description of a bean whose create is unsent changes the picks it will send; one of a bean the server already has cannot change it, and the screen says the picks were not added.
- **What waits, and what goes first.** A look-up that waits (for its next attempt, or for the user) does not hold the queue, against the head-of-line rule above: it and every operation that needs its bean are skipped, and everything else keeps its order. Holding the whole queue on a user's answer, or on the Open Food Facts daily cap, could keep every other write off the server for a day. An operation whose shelf entry or bean has no server id and still has its create (or look-up) queued needs that operation first, whatever the sequences are: an entry made earlier and later moved to a bean scanned offline goes after that bean, instead of being parked `missing_reference`. A delete never waits: an item the server never had is removed locally. ADR 0012 holds, since the order among the operations of one shelf entry is kept. A look-up after the daily cap waits an hour; other failures use the usual backoff.
- **No rewrite.** The shelf entries and brews of a pending bean need none: their bodies are built when they are sent and name the bean through the relationship, so they carry its server id once it has one.
- **Label photos** taken for a bean saved or described offline are `QueuedLabelPhoto`s, a new model in schema version 2 (one lightweight stage from version 1, which lists the same model types unchanged), with the JPEG in the account's queue folder. They upload in the engine's idle slot once the bean has a server id, resuming from the stored `LabelPhotoUploadJob`. A photo that cannot be written is not dropped silently: nothing is saved and the screen says so.
- **Sign-out and queued photos.** One store per account stays on the device after a sign-out, with its outbox; its queued photos are part of it and stay too. A sign-out deletes the account's other photo files and the queued files its store does not list (if the store cannot be read, the queue folder is kept); a sign-in keeps other accounts' queue folders and deletes the account's queued files its store does not list. Deleting an account's data (M2-T30) must delete its queue folder with its store.
