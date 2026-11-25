# 0012 Shelf entries count the brews that reference them

- Status: proposed
- Date: 2026-11-25
- Decided by: agent (backend-engineer), task M1-T5

## Context

`DELETE /shelf/{shelf_entry_id}` answers 409 while brews still reference the entry (contracts/openapi.yaml). ADR 0010 expected this to be a query over the user's `BREW#` items with a filter on `shelf_entry_id`. A query followed by a delete is not atomic: a brew logged between the two would be left pointing at a deleted entry. The same race exists the other way round, when a brew is logged for an entry that is being deleted. `POST /brews` must also answer 404 when the shelf entry does not exist, and `POST /shelf` 404 when the bean does not exist.

The aggregator (M3) will need the bean of every brew, including of a removed brew, whose stream record carries only the old image. The contract's `BrewInput` holds `shelf_entry_id` but no bean.

## Decision

- Each shelf entry item holds `brewCount`, the number of brews that reference it. It starts at 0.
- Creating a brew is one transaction: the brew, its pointer (ADR 0010) and `ADD brewCount 1` on the shelf entry, on the condition that the entry exists and still names the bean that was read. Deleting a brew is one transaction that also does `ADD brewCount -1`, on the condition that the entry exists and the count is above 0. A replace that changes `shelf_entry_id` moves the count from the old entry to the new one in the same transaction. Every brew write is also conditional on the brew item still naming the shelf entry that was read, so two racing writes cannot leave the count wrong.
- Deleting a shelf entry is conditional on `brewCount` being 0 (or absent). A failed condition reads the item once: gone is 404, present is 409.
- The brew item holds `shelfEntryId` and `beanId` as top-level attributes: the shelf entry and that entry's bean at the time of the write. They are internal, not part of the contract.
- Creating or replacing a shelf entry is a transaction with a `ConditionCheck` that the bean's `META` item exists (404 otherwise).

## Alternatives

- **Filtered query, then delete (ADR 0010):** reads every brew of the user on each shelf delete and is not atomic, so a brew can end up referencing a deleted entry.
- **A query plus a `ConditionCheck` on every brew found:** a transaction holds at most 100 items, and a new brew can still be added between the query and the delete.
- **An index on `shelfEntryId`:** a second index costs a write per brew and changes the table (ADR 0010, Alternatives).
- **No bean on the brew:** the aggregator would have to read the shelf entry for every stream record, and a removed brew whose entry had changed its bean would be subtracted from the wrong bean.

## Consequences

- A brew create, replace or delete writes one or two more items in its transaction (about two more write units). Negligible at the expected volume (docs/06).
- The shelf entry is a hot item: every brew write on it also writes `brewCount`. Two brew writes on the same entry at the same moment (two devices syncing offline brews, a burst of edits) make DynamoDB cancel one transaction with `TransactionConflict`; a plain delete or update of the entry during a brew transaction fails with `TransactionConflictException`. Nothing is written in either case. The repository turns both into `WriteConflictError` and the API tries the write up to three times in all, with 10 to 100 ms of random wait. Contention is limited to one user's own entry, so this should be rare; if it is not, batch or serialise brew sync on the client, or revisit the counter.
- Shelf entry items change when brews change, so the table stream carries `SHELF` records for them. The aggregator ignores `SHELF` items, as it does `BREW_REF`.
- Open: `PUT /shelf/{shelf_entry_id}` may change `bean_id` while brews reference the entry. The brews keep the bean recorded at their last write until they are written again. Whether such a change is allowed, and what it means for aggregates, is for M3 to decide (and the contract, which has no 409 on that route).
- Account deletion (M1-T6) deletes the whole partition and need not maintain the counts.
