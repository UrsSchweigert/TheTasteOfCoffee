# 0005 Open Food Facts text is stored and shown; the server fetches it

- Status: accepted
- Date: 2026-11-25
- Decided by: owner (D7). The server-side fetch is the lead's reading of how to honour invariant 1; see Decision.

## Context

When a barcode is scanned, Open Food Facts returns a product name, a brand and an image. These are free text. Invariant 1 says no control in the app accepts typed text and no API field accepts an arbitrary string. The M0-T2 contract therefore kept all Open Food Facts text out of the API. Without it, a scanned bean has nothing a user would recognise it by.

## Decision

The owner decided: take the information Open Food Facts has. The restriction is that the app has no free-text input.

- Catalogue entries store the Open Food Facts name, brand and image reference, and API responses return them, tagged with their source (D5).
- The backend fetches this data by barcode, so the text never travels from a client to the API. Request bodies keep accepting only vocabulary ids, patterned ids, barcodes and dates, so invariant 1 holds as written. The phone still sends nothing but the barcode and the user's confirmation of the match.
- Text that comes from Open Food Facts is treated as untrusted when shown: length-limited when stored, never interpreted as markup, and never logged.

## Alternatives

- Keeping all Open Food Facts text out of the API: rejected by the owner, because it leaves beans unrecognisable.
- The phone fetches from Open Food Facts and sends the name and brand to the API: rejected, because an API field would then accept an arbitrary string, which breaks invariant 1.
- Showing the text only after the operator approves it: not chosen. Entries stay `unverified` until the operator curates them (D3), but they are shown right away.

## Consequences

- `docs/05-system-design.md` (Barcode lookup) changes from looking up from the phone to looking up from the backend. Open Food Facts rate limits then apply to our server, not to each user. The lookup needs a descriptive User-Agent, caching in the catalogue so each barcode is fetched once, and a per-user cap on lookups. The backend needs outbound HTTPS to the Open Food Facts API.
- The contract (`contracts/openapi.yaml`) adds response-only fields to the bean, with strict length limits, and the lint gets an explicit, documented rule that allows them only in responses.
- The ODbL attribution and share-alike review (D5) still applies before launch.
