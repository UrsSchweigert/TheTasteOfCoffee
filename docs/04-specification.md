# Specification

The app has four flows (scan, brew, rate, explore) and one rule: no control accepts typed text.

## Input model

| Allowed control | Used for |
| --- | --- |
| Camera scan | Barcode (EAN-13, UPC-A), optional label photo |
| Single or multi pick list | Method, milk, origin, species, process, variety, flavour notes, equipment |
| Slider or segmented scale | Rating criteria, roast level |
| Stepper or wheel | Dose, water, temperature, grind setting |
| Timer | Brew time |
| Date picker | Roast date, purchase date |
| Toggle | Buy again |

Consequences: there is no username, no display name, no bean nickname, no comment and no support form in the app. Identity comes from Sign in with Apple. Support runs through a mailto link outside the app.

The machine-readable lists live in `contracts/vocabulary/v<N>/` (latest published: v2). They are the single source of truth for the app, the API and the tests.

## F1 Scan and catalogue

1. The user scans the barcode on the bag. Scanning runs on the device (Apple VisionKit), so it costs nothing.
2. The app asks the backend for the barcode. A known bean returns from the shared bean catalogue.
3. Unknown barcode: the app asks the backend, which looks the barcode up in Open Food Facts for name, brand and image (the phone sends only the barcode; docs/05, Barcode lookup). Each barcode is fetched once and cached for all users, and each user has a daily lookup limit. The image is copied once into the photo bucket with all metadata stripped, and the app loads it from our API, never from Open Food Facts (ADR 0011). A hit is shown for confirmation; once the user confirms, the backend stores it as an unverified catalogue entry. The name and brand are shown as Open Food Facts text, with its attribution.
4. No hit, or no barcode: the user describes the bean by pick lists (origin, species, process, variety, roast level) and photographs the label. There is no roaster pick list: the roaster comes from the Open Food Facts brand or is set by the operator (ADR 0006). The photo goes to a private review queue. The operator turns it into a verified catalogue entry.
5. The purchase is saved to the user's shelf: bean, purchase date, roast date, bag size (pick list: 250 g, 500 g, 1 kg), price band (pick list).

Label photos are never shown to other users, so they need no public moderation.

## F2 Brew log

A brew references a bean on the shelf and a method. Fields depend on the method; all are optional except method.

| Field | Control | Values |
| --- | --- | --- |
| Method | Pick list | Espresso, moka pot, V60, Chemex, Kalita, batch filter, AeroPress, French press, cold brew, cezve, siphon, fully automatic machine |
| Grinder | Pick list | Curated grinder models, or "pre-ground" |
| Grind setting | Stepper | Grinder's own scale, plus a normalised 1 to 10 coarseness |
| Dose | Stepper | 5.0 to 100.0 g in 0.1 steps |
| Water or yield | Stepper | 10 to 1,500 g |
| Water temperature | Stepper | 80 to 100 °C, or "cold" |
| Brew time | Timer | Seconds |
| Water type | Pick list | Tap, filtered, bottled, remineralised |
| Milk | Pick list | None, dairy, oat, soy, almond, cashew, hazelnut, macadamia, coconut, rice, pea, other plant (see ADR 0003) |

The app computes ratio and days since roast. A brew can be saved as a recipe and repeated with one tap, which is how the 30-second target is met.

The recipe list also offers starting points: reference recipes from published sources (ADR 0034), bundled with the app, shown by method. They are numbers only (method, dose, water, temperature or cold, time, grind), labelled as reference recipes and never as community data, ratings or raters. Opening one shows its numbers, with the ones that were not published marked as estimated; one action copies it into the user's own recipes, where it is an ordinary recipe (no name, synced, repeated with one tap). A recipe the user already has with the same numbers is not copied again; the screen says it is already there. Only recipes of methods the app knows and whose fields the method allows are shown. Starting points need no network and cost nothing.

A brew can have up to 6 photos, taken with the camera or picked from the photo library. They are kept on the device only: never uploaded, never exported, with no caption (ADR 0033). By default they are not in the device backup either; a Settings toggle ("Include brew photos in the device backup", off by default, per device, not synced) puts them in the backup of that phone that the user already has with Apple (ADR 0033, addendum M2-T45).

## F3 Rating

Each brew is scored on eight criteria, 1 to 10 in half steps. They follow the attribute set used in professional cupping, reduced to what a home drinker can judge.

| Criterion | Question shown to the user |
| --- | --- |
| Aroma | How good does it smell? |
| Flavour | How good does it taste overall on the palate? |
| Aftertaste | How pleasant is what lingers? |
| Acidity | How pleasant is the brightness? |
| Body | How pleasant is the mouthfeel? |
| Sweetness | How sweet does it come across? |
| Balance | How well do the parts fit together? |
| Overall | How much did you enjoy this cup? |

Three additions keep the picture complete without text:

- **Intensity** of acidity, body and bitterness, each low, medium or high. This separates "how much" from "how good".
- **Flavour notes:** up to five picks from a closed two-level vocabulary (for example fruity > berry, nutty > hazelnut), about 80 terms.
- **Buy again:** yes or no.

The vocabulary and criteria are versioned. A rating stores the version it was made with, so later changes do not corrupt old aggregates.

### Personal statistics (free)

The user's own statistics are computed on the device from the local store and work offline (ADR 0027). They use the F4 measures on the user's own brews; removed brews count nowhere and only rated brews count for scores:

- brews in total and per ISO week for the last 8 weeks;
- the taste profile: the mean per criterion, overall and per method, a method once it has 2 rated brews;
- the 5 most-picked flavour notes;
- the best method and the best bean by mean overall score, each with at least 2 rated brews; on a tie, more rated brews win, then the most recent;
- the buy-again share among the ratings that answer it (ADR 0026).

Means have one decimal in the device locale. Without rated brews a section shows an empty state, not zeros.

#### My brews of this coffee (free)

The shelf entry screen (one bag) shows "My brews of this coffee" (M2-T44, ADR 0027 addendum), computed on the device and offline:

- the mean of each rating criterion, in vocabulary order, over the rated, not removed brews of this shelf entry (not of other bags of the same bean), with the mean overall score and the number of rated brews; ratings made with an older vocabulary version count;
- a breakdown by method for each method with at least 2 rated brews of this entry;
- one decimal in the device locale, each value with a simple bar; VoiceOver reads "Aroma, 7.5 of 10";
- no rated brew: "Rate a brew to see your averages here", no zeros; exactly one rated brew: its values, labelled as one brew, not as an average;
- the community mean and number of raters for the bean will sit next to each value (M4, paid rules apply); until then nothing is shown there.

#### Averages in context (free, M2-T48)

The same numbers appear where the user looks at them, without scrolling to the section above:

- **Rating sliders:** under each slider a marker and its number show the mean of the user's other rated brews of this shelf entry ("Your average for this coffee 7.5"), but only after the user has set that slider in this rating, so the average does not anchor the score. The brew being rated is left out. A brew opened with a rating shows its markers at once. The marker never changes the slider; VoiceOver reads it as "Your average for this coffee, 7.5 of 10". A second marker for the community's mean is reserved for M4 and hidden until it exists.
- **Top of the coffee's screen:** "Overall 7.4, rated brews 3" at the very top; a tap scrolls to the section above. Shown with at least one rated brew.
- **Brew list:** each rated brew shows its own overall score and the coffee's average ("avg 7.4"); unrated brews show neither, and one rated brew shows no average.

## F4 Explore (paid)

- Bean page: number of raters, mean and spread per criterion, most-picked flavour notes, buy-again share.
- Method breakdown: overall score per method for this bean.
- Top recipes: the parameter ranges (ratio, temperature, grind, time) of the top-scoring quarter of brews per method.
- Rankings: top beans filtered by origin, process, roast level, method, price band.
- An aggregate is shown only when at least 5 distinct users contributed to it.
- Give-to-get: a free user sees the overall community score for beans they have rated themselves.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Offline | Scan, brew and rate work offline and sync later; the device holds a full copy of the user's own data |
| Speed | API responses under 300 ms at the 95th percentile, cold starts excluded |
| Privacy | EU data residency; no advertising SDKs; no third-party analytics; account deletion in the app (it also deletes the brew photos on the device) |
| Durability | No loss of a confirmed write; recovery to any point in the last 35 days |
| Accessibility | Dynamic Type and VoiceOver on every control |
| Localisation | All labels are keys; German and English at launch |
