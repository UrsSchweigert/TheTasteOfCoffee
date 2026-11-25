# 0011 Vocabulary v2: regions name their country, species is its own list; Open Food Facts images are copied

- Status: accepted
- Date: 2026-11-25
- Decided by: owner

## Context

The draft vocabulary v2 (M1-T8) had a flat `origins` list. Islands such as Sumatra, Java and Sulawesi sat next to the country Indonesia, and Hawaii had no USA entry, so one coffee could be tagged two ways and any filter or ranking by country would split. The draft also listed `robusta` under `varieties`, although Robusta is a species, not a cultivar.

Separately, the contract had the app load Open Food Facts product images straight from `images.openfoodfacts.org`. That would send every user's IP address to a third party.

## Decision

- **Regions name their country.** Each region entry in `origins` carries a reference to its parent country, for example Sumatra to Indonesia and Hawaii to the USA. Filters and rankings can then group by country. Bali, Flores and a `usa` country entry are added.
- **Species is its own pick list.** `species`: Arabica, Robusta (Canephora), Liberica, Excelsa, an Arabica/Robusta blend, and unknown. `robusta` is removed from `varieties`, which then lists Arabica cultivars only.
- **More entries.** Origins: Madagascar, Togo, Australia. Varieties: Red Bourbon, Java (the cultivar), Parainema, Obata, Marsellesa, Catucaí, Ethiopian 74110 and 74112, SL14.
- **The owner approves v2** with these changes. It is then published and locked under the usual rules.
- **Open Food Facts images are copied.** When a hit is cached, the backend downloads the image once from Open Food Facts, strips all metadata (D12) and stores it in the photo bucket. The API returns our own image reference, and the app never contacts Open Food Facts. Attribution under the ODbL stays (D5).

## Alternatives

- Countries only, with regions dropped: rejected, because a "Sumatra" bag would lose information.
- A flat list with the overlap kept: rejected, because it splits filters.
- Robusta kept as a variety, with Liberica added beside it: rejected, because it mixes species and cultivar.
- Hotlinking Open Food Facts images: rejected for privacy.

## Consequences

- The vocabulary schema gains a parent field for region entries, with a test that every parent is a country in the same list.
- The contract replaces the Open Food Facts `image_ref` pattern with a reference to our stored copy.
- M1-T4 downloads, cleans and stores the image, and the backend needs outbound HTTPS to the Open Food Facts image host as well as the API.
- The photo bucket holds catalogue images too. They follow the bucket's existing lifecycle rules and are not tied to a user, so account deletion (D10) does not remove them.
