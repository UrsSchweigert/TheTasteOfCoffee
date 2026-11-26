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

## Addendum (M2-T35, ios-engineer under the lead's delegation, ADR 0014; no cloud cost)

Failed writes put every edited field back.

- **Why.** "On disk together or not at all" (Decision, first point) also has to hold in memory. `ModelContext.rollback()` drops inserted models and unsaved deletes, but in the macOS `ios` job it did not restore an attribute changed on a model that was already saved. The screens and the engine share one context, so a failed edit stayed in memory with no operation queued, and the next unrelated save (any screen's, the engine's, the pull's) stored it without it ever being sent.
- **One mechanism, in `AccountStore`.** A failed `save()`, and a throw inside `write { }`, call `discardUnsavedChanges()`: every model the context lists as changed or deleted takes again the values the store holds for it, then the context rolls back. The saved values are read through a fresh `ModelContext` on the same container, which sees only what is on disk. The store is the snapshot: no write leaves anything unsaved (every write saves at once, screens edit drafts), so the last save is exactly the state to return to. Each model lists the stored properties it puts back (`SavedValuesRestorable`: every attribute, the to-one relationships and their to-many inverses; models are found by `localID`, operations by `sequence`), and a test checks the lists against the schema. A write that changes a model before a call that can throw runs inside `write { }`; the engine discards before it saves a retry.
- **Alternatives.** A snapshot per screen (as `BrewRatingSnapshot` did for the rating) has to name every field and every model a write touches, the outbox operations and the beans a shelf entry leaves included, and is missed at the next new site. A snapshot taken by `write` from its callers' list of models has the same gap. Reading the saved values from disk needs no list and covers what a write touches on the side; it costs a fetch per changed model, only on the failure path. Comparing by `persistentModelID` was not used: on iOS 17 a model inserted and saved in the same context could keep a temporary identifier, so `localID` and `sequence` are the keys.
- **Also.** Moving the last shelf entry off a pending bean drops the bean as removing the entry does, so a bean waiting for an answer never stays in the outbox with nothing on the shelf. A description of a pending bean is never sent as `POST /beans`, also when the entry has no store.

## Addendum (M2-T36, ios-engineer under the lead's delegation, ADR 0014; no cloud cost)

The failed-write mechanism of M2-T35, hardened after its review (PR #64).

- **Writes nest; the outermost one discards.** `addShelfEntry` and `addBrew` now run inside `write { }`, like `markUpdated`, and are also called inside the screens' writes. `write` keeps a depth (`AccountStore.writeNesting`): inside another write it only runs its body, and the error reaches the outermost write, which discards once for every change made so far. An inner write's error must not be caught inside the outer one. If it is, nothing of it is stored all the same: every later `save()` of the outer write throws `WriteNestingError.innerWriteFailed` (and discards, as a failed save does), and the outer write's end discards and throws the same error. Alternative: every write discards on its own (as before). That undoes the outer write's changes too, early, and an outer write that catches the error then saves its later changes alone; with one owner of the discard there is no such half state.
- **A failure of `ModelContext.save()` itself is tested** on a store opened again with `allowsSave: false`, where SwiftData refuses the save without the `willSave` hook: removing a brew from its entry, and a scanned bag's entry with its pending bean, both come back with their relationships and operations. Limits: a uniqueness violation on `localID` cannot force a failed save, since SwiftData answers a second model with the same unique value with an upsert; the schema has no other constraint (no `.deny` delete rule, no relationship counts), and the schema is not changed for a test. A save that fails half-way inside SQLite (disk full) is not reproduced; it reaches the same `catch` in `save()`.
- **What that test found, and the fix.** The brew came back right, but the scanned bag's entry came back with `bean` nil and twice in its pending bean's `shelfEntries`, although the read-only save error (NSCocoaErrorDomain 513) showed the save failed as intended. Cause: a failed `ModelContext.save()` has already processed the pending changes, so the delete rules (nullify) have run on the deleted models; when both ends of a relationship are deleted in the same write, restoring before the rollback and then rolling back does not give back the saved relationship (with the `willSave` hook `ModelContext.save()` is never called, so the delete rules do not run, and no hook test deleted both ends of a relationship). Exactly which step SwiftData gets wrong (the rollback re-adding the inverse to its own array, or the to-one reverting to the nullified value) was not observable from Linux, so the fix does not depend on it:
  - every relationship restore is idempotent and compares with the saved value: a to-one by the target's `localID`, a to-many as the exact saved set, a list holding a target twice counting as wrong; a to-many is assigned the deduplicated saved targets, never appended to;
  - after the rollback, the to-one relationships and then the to-many ones of every changed or deleted model are checked against the saved copies again and set where they differ, repeated until a pass changes nothing (at most 3 passes; a fixed fault message is logged if they do not settle, a notice when a repair was needed);
  - a relationship set in that pass holds the store's value, so the context may keep it as a change equal to the disk; a later save stores nothing of the failed write. `testAFailedRemovalOfAScannedBagsEntryBringsBackTheEntryAndItsPendingBean` covers the same removal through the hook.
- **A store that cannot be read while discarding is said.** `savedCopy` throwing (not "not found") leaves that model to the bare `rollback()`, which may keep a changed attribute in memory. It raises `assertionFailure` in debug builds and logs a fixed message with `os.Logger` (no ids, no values).
- **Restored properties carry their key path.** `RestoredProperty` has the key path it sets, and a test checks that no name and no key path is listed twice. SwiftData does not make the schema's key paths public (`Schema.PropertyMetadata` has no public `name` or `keypath`), so a key path cannot be compared with the schema's for the same name. The per-site tests restore every field and compare the result instead.
- **Describing without a store** ends in `BeanEntryModel.Failure.noStore`, which offers no retry (`canSave` is false, also after a pick changes): the description is only ever written to the local store, so another try could not succeed either.
- **Label photo queue.** A failed save after an upload puts the job's saved stage back, so the next run repeats the S3 POST (and, from `notStarted`, the presigned POST). `LabelPhotoQueue.run()` says why that is safe: one exact key per presigned POST, raw uploads expire after a day (ADR 0016), a photo is stored only by its completion, once per id, and new presigned POSTs are capped per run and per day.

## Addendum (M2-T29, ios-engineer under the lead's delegation, ADR 0014; no cloud cost)

Onboarding (docs/07 D1) writes the profile while the server's state may be unknown. The merge rule below is the lead's decision after review (ADR 0014).

- **When onboarding shows.** With no local profile: at once after `GET /profile` answered 404 or the pull failed (offline); after a short wait (5 s) when no pull has answered yet, so a sync stuck behind a retry never blocks the user. Never once a local profile exists, and never when the server has one (the pull stores it first).
- **Check before the first `PUT`.** A profile made on the device that the server never confirmed (`pendingCreate`) is checked with `GET /profile` before its `PUT`. A 404 sends ours. A failure of the read retries with backoff (the read counts as an attempt, except when cancelled) and leaves `sentWithoutAnswer` as it is; an unreadable profile is parked (`unexpected_response`) rather than overwritten.
- **Merge on a 200.** The server has a profile (made on another device, or our own earlier `PUT` whose answer was lost). The two cannot be ordered, so neither simply wins. The local profile is read again after the answer, so an edit made during the read counts, and resolved as:
  - `locale`: the server's;
  - `consent.contribute_to_aggregates`: the server's and the local value both true. A "no" given on either device is never turned into "yes" without the user.

  If the resolved profile equals the server's, it is adopted: the local profile takes it and is synced, its operations are removed, nothing is sent. Otherwise the resolved values are stored, the profile becomes `pendingUpdate`, and the same operation (the only one kept) sends them with `PUT /profile`.
- **Later edits.** A profile the server has (`pendingUpdate`) is sent without the check: an edit is the user's change of a known profile, and the last write wins as for every other item.
- **Alternatives.** Not showing onboarding until the server answered: blocks a user who signs in offline. A plain `PUT`: overwrites the consent given on another device. The server's profile winning outright: a "no" given here (in onboarding or Settings) before the first sync would silently become "yes".
