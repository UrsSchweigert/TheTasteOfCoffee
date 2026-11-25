# 0010 Shelf, brew and recipe sort keys carry the item id

- Status: proposed
- Date: 2026-11-25
- Decided by: agent (backend-engineer), task M1-T3

## Context

The API (contracts/openapi.yaml) reads, replaces and deletes shelf entries and brews by their server-generated id (`/shelf/{shelf_entry_id}`, `/brews/{brew_id}`), and lists brews newest first. The data model in docs/05 had the sort keys `SHELF#<beanId>#<date>` and `BREW#<timestamp>`. Neither holds the id, so an item could not be read by id without a second index. Two purchases of the same bean on the same day, or two brews in the same instant, would also overwrite each other. The M0-T2 review raised this.

The table has one index, `gsi1`, which is reserved for the review queue (infra/README.md), and no local secondary index. A local index can only be added when the table is created.

## Decision

All of these stay in the user's partition `USER#<sub>`.

- **Shelf entry:** sort key `SHELF#<shelfEntryId>`. Bean id and purchase date are attributes (`beanId`, `purchaseDate`). A read by id is one `GetItem`. The list query (`begins_with SHELF#`) returns newest first, because ids are ULIDs and sort by creation time. The spec does not ask for any other shelf order.
- **Recipe:** unchanged, `RECIPE#<recipeId>`, listed newest first.
- **Brew:** two items, always written in one transaction:
  - the brew, `BREW#<brewedAt>#<brewId>`, where `brewedAt` is the brew's `brewed_at` converted to fixed-width UTC with milliseconds (`toISOString()`, always 24 characters). Querying `begins_with BREW#` in reverse lists brews newest `brewed_at` first, whatever offset the client sent. The id at the end keeps two brews at the same instant apart. This is the only item the aggregator (M3) reads.
  - a pointer, `BREWID#<brewId>`, with the brew's current sort key in `brewSk`. A read by id is two consistent `GetItem`s.
  - When a replace changes `brewed_at`, one transaction deletes the old brew item, puts the new one and updates the pointer, on the condition that the pointer still names the old key. The stream then shows a remove and an insert, so the aggregator subtracts the old scores and adds the new ones.
- Cursors hold only the sort key of the last item. The partition key always comes from the token, so a cursor cannot reach another partition.

docs/05 (Data model) is updated to match. `backend/src/repository/keys.ts` builds every key and is the only code that knows these formats.

## Alternatives

- **`SHELF#<beanId>#<date>#<shelfEntryId>`:** groups a bean's purchases, but a read by id still needs the bean and date, and no spec feature lists the shelf by bean.
- **`BREW#<brewId>` alone, with the ULID time taken from `brewed_at`:** one item, but `brewed_at` can be changed by a replace while the id cannot, so the order would be wrong after that edit.
- **A second global index for brews by time:** each write to the index costs about as much as the pointer item, and it would change the review-queue index contract in infra/README.md. Also an infra change.
- **A local secondary index on a `brewedAt` attribute:** needs the table to be recreated, and limits each user's partition to 10 GB.
- **Sorting in memory:** cannot be paged.

## Consequences

- Creating, replacing or deleting a brew is a two-item transaction, which costs about four write units instead of one. At the expected volume (docs/06) this is negligible.
- The aggregator must ignore `BREW_REF` items (attribute `type`, sort key `BREWID#`) and treat a moved brew as a remove plus an insert.
- Finding all brews of one shelf entry, which the delete rule "409 if brews still reference this shelf entry" needs, is a query over the user's `BREW#` items with a filter. That is fine for one user's data. Revisit with an index if it gets slow.
- Ranking keys: `RANK#<facet>` is `RANK#ALL`, `RANK#METHOD#<method>`, `RANK#PROCESS#<process>`, `RANK#ROAST_LEVEL#<level>` or `RANK#PRICE_BAND#<band>`. The sort key `<period>` is the calendar day of the nightly run (`YYYY-MM-DD`). Origin joins when vocabulary v2 has the list. M3 may refine both with a new ADR.
