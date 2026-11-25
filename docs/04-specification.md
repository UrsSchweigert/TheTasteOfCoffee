# Specification

The app has four flows (scan, brew, rate, explore) and one rule: no control accepts typed text.

## Input model

| Allowed control | Used for |
| --- | --- |
| Camera scan | Barcode (EAN-13, UPC-A), optional label photo |
| Single or multi pick list | Method, milk, origin, process, variety, flavour notes, equipment |
| Slider or segmented scale | Rating criteria, roast level |
| Stepper or wheel | Dose, water, temperature, grind setting |
| Timer | Brew time |
| Date picker | Roast date, purchase date |
| Toggle | Buy again |

Consequences: there is no username, no display name, no bean nickname, no comment and no support form in the app. Identity comes from Sign in with Apple. Support runs through a mailto link outside the app.

The machine-readable lists live in `contracts/vocabulary/v1/`. They are the single source of truth for the app, the API and the tests.

## F1 Scan and catalogue

1. The user scans the barcode on the bag. Scanning runs on the device (Apple VisionKit), so it costs nothing.
2. The app asks the backend for the barcode. A known bean returns from the shared bean catalogue.
3. Unknown barcode: the device queries Open Food Facts for name, brand and image. A hit is shown for confirmation and stored as an unverified catalogue entry.
4. No hit, or no barcode: the user describes the bean by pick lists (roaster from the curated roaster list or "not listed", origin country, process, variety, roast level) and photographs the label. The photo goes to a private review queue. The operator turns it into a verified catalogue entry.
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
| Privacy | EU data residency; no advertising SDKs; no third-party analytics; account deletion in the app |
| Durability | No loss of a confirmed write; recovery to any point in the last 35 days |
| Accessibility | Dynamic Type and VoiceOver on every control |
| Localisation | All labels are keys; German and English at launch |
