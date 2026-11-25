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
- **Order.** A `SyncEngine` per account sends the lowest sequence that is not parked, one operation at a time. A retry holds the queue, so later writes never overtake earlier ones. That also keeps two of the user's own brew writes off one shelf entry at the same moment (ADR 0012). The engine runs on the main actor with the screens' `ModelContext`, so the two never see stale copies of each other's changes; only the requests leave the main actor.
- **References resolve at send time.** An operation names its item by local id only. The body is built from the item's current values when it is sent, and a shelf entry's bean or a brew's shelf entry is read through the relationship. The request therefore carries whatever server id the referenced item has by then. The referenced item's create always sits earlier in the queue; if it was parked, the dependent operation is parked too (`missing_reference`). An edit is not queued again while a create or update that has not been sent carries it.
- **Answers** (after `APIClient`'s one refresh and one retry on a 401):
  - 2xx: the server id is stored. The server values are stored too, unless a later operation for the item is queued. The operation is removed.
  - Transport failure, 429, 503, other 5xx: retried after `min(300 s, 2 s × 2^(n−1))`, of which a random half is jitter (equal jitter). The same holds when Cognito fails while refreshing (ADR 0024).
  - `unauthorized`: the engine stops and asks for sign-in; every operation is kept. The app signs out, so the sign-in screen shows. ADR 0017's tombstone 401 is the same case: a token issued before an account deletion must sign in again, and nothing is dropped. Signing in with a new account opens another store, so the old operations are never sent with the new account's token.
  - 400: parked and never retried; the item is flagged `rejected`. The same applies to a 404 on a create (the bean or shelf entry it names does not exist) and to an answer that breaks the contract.
  - 404 on `DELETE`: done. 404 on `PUT`: the item is gone on the server, so the local item and its operations are removed.
  - 409 on a shelf `DELETE`: brews still reference the entry, so it is restored and flagged `delete_restored`.
  - 409 on a shelf `PUT` (D14): the entry is read again, the server's bean is linked back (fetched if not cached), the entry is flagged `bean_change_reverted`, and the other values are sent again.
  - 409 on `POST /beans`: the barcode already has a catalogue bean, which is looked up and adopted.
- **Ambiguous creates.** `sentWithoutAnswer` is saved before each request. It is cleared only by an answer that says the server did nothing (400, 401, 404, 409, 429) or by the check below. A create that still has the flag is checked before it is sent again, including after the app was ended mid-request. The engine lists the resource and adopts a server item that matches and has no local counterpart:
  - a brew with the same `shelf_entry_id` and `brewed_at`;
  - a shelf entry with the same bean and values;
  - a recipe with the same parameters.

  A retry therefore does not create a duplicate, and the contract does not change. Deleting a pending create that may already be on the server queues a delete after it instead of dropping it.
- **Two devices.** `PUT` replaces the whole item and the contract carries no version, so the last write to reach the server wins. The next pull (M2-T17) shows the winner.
- **Sign-out.** `SyncHost` follows the signed-in account. On a change it stops the old engine first: the request in flight is cancelled and nothing more is sent. Before every request the engine also asks `AuthSession` whether its account is still the signed-in one. The app's one `APIClient` (M2-T14) is shared; the account check, not a second client, keeps one account's outbox off another account's token.

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
