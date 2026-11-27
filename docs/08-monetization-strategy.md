# Monetization strategy

Status: proposal for the owner, written 2026-11-27. Nothing here is decided. It changes no code, contract, infrastructure or other document. Where it disagrees with docs/03 (price points, what is in scope), it says so and leaves the decision to the owner.

## How to read the claims

Every factual claim carries one of these marks.

| Mark | Meaning |
| --- | --- |
| **[V]** VERIFIED | Read in full in a source that was fetched on 2026-11-27. In this session only `developer.apple.com` could be fetched, so only Apple facts are verified. |
| **[R]** REPORTED | Taken from a search result summary; the page itself could not be opened (network allowlist of the session). Treat as unconfirmed until someone opens the source. Same standing as the sources of docs/06. |
| **[E]** ESTIMATE | Own reasoning; the arithmetic is shown. |
| **[A]** ASSUMPTION | A working assumption with no source. To be replaced by a measurement or a lawyer's or tax adviser's answer. |
| **[D]** | Stated in this repository (docs/01 to docs/07, ADRs, backlog, companion page). |

Numbers in brackets like [S3] point to the Sources section.

## Executive summary

1. **Primary path: one consumer subscription, sold through StoreKit 2, priced higher than planned and switched on only where there is data.** Comparable hobby apps charge 33 to 55 a year (Filtru, Vivino, Whiskybase, Untappd) [R]; the planned 19.99 EUR is about half of that. Recommended list price: **29.99 EUR a year, 3.99 EUR a month**, with a first-year launch offer of 19.99 EUR.
2. **The product must never sell emptiness.** The 5-rater rule means almost no bean has community data at launch. The paywall is shown only on beans that have data, it states how many coffees have data today, and the paid tier is not sold in a storefront before a measurable coverage gate is met (section 4).
3. **Give-to-get is the trial and the growth loop.** It must depend on having rated the bean, never on consenting to share: making a benefit conditional on consent collides with GDPR Art. 7(4) [A] and with App Review 5.1.1 [V].
4. **Cloud cost is not the constraint.** A subscriber nets about 1.19 EUR a month at 19.99 and about 1.79 EUR at 29.99 [E]; a user costs well under 0.01 USD a month [D]. About 560 subscribers at 29.99 give 1,000 EUR a month; about 2,240 give 4,000 EUR [E]. The constraint is reach and data density.
5. **Roasters are the cold-start engine first and a revenue line second.** A roaster who puts an App Store link and an offer code on the bag concentrates ratings on a few beans, which is exactly what the 5-rater rule needs. In return the roaster gets the aggregate view of its own beans. Charge for that only after 24 months or 50 active roasters, 19 to 39 EUR a month, invoiced outside the app.
6. **Rejected or deferred:** advertising and ad networks (invariant 7), sponsored ranking positions (trust), selling or licensing rating data below aggregates (invariant, GDPR, App Review 5.1.2 [V]), Family Sharing at launch (cannot be undone [V]), lifetime purchase and tip jar until the subscription has six months of data, affiliate links until v1 scope is reopened (docs/03 puts them out of scope [D]).
7. **Measurement works without analytics.** App Store Connect gives subscription retention, conversion, offer performance and peer benchmarks [V]; the nightly job's log line can carry counts (beans above the threshold, entitled profiles). No SDK, no custom metric, no user id.
8. **Illustrative 36-month net revenue (not a forecast):** conservative about 1,000 EUR, base about 14,000 to 19,000 EUR, ambitious about 100,000 to 160,000 EUR [E]. The spread is the honest message: this is a side income unless distribution through roasters or a second platform works.

## 1 Segments and willingness to pay

The five personas of docs/01 are fictional and unvalidated [D]. Willingness to pay below is therefore assumption, anchored on what comparable apps charge.

| Segment | Size signal | What they would pay for | What they will not pay for | Likely price | Mark |
| --- | --- | --- | --- | --- | --- |
| Home enthusiast (Jonas): logs to remember recipes | Whole-bean sales in Germany at a record in 2025, up 130% in ten years; one in three households has a fully automatic machine [S14] [R] | Little. The log is the value, and the log is free. Possibly a tip or a small "supporter" purchase | Community data on beans he already knows | 0, or 5 to 10 EUR once | [A] |
| Explorer (Mira): buys a new bag every two weeks at 15 to 20 EUR [D] | Germany is reported as Europe's largest specialty market, about 1.7 billion USD in 2025 [S15] [R] | Knowing before buying: score profile, best method, starting recipe. One avoided bad bag pays for a year | A database with holes; rankings of beans she cannot buy | 25 to 40 EUR a year | [A] |
| Prosumer and barista | Small, vocal, on forums | Method breakdown, recipe ranges per grinder and method | Anything that looks like opinion instead of numbers | 30 to 50 EUR a year | [A] |
| Café owner (Tomás): burns 200 to 300 g dialling in a new bean [D] | 490 registered specialty cafés in Germany in 2025, up from 294 in 2021 [S16] [R] | A starting recipe for a guest bean; evidence for what to stock | Per-seat software pricing | Consumer price; later 10 to 20 EUR a month if a café view exists | [A] |
| Micro-roaster (Selin): 40 kg a week [D] | About 650 small roasters in Germany per the coffee association's managing director; customs counts more than 1,500 roasting businesses of all sizes [S13] [R] | Structured feedback on its own beans: how customers brew and score them; correct catalogue data | Raw data (and may not get it); anything that costs like production software | 0 at first (barter for distribution), later 19 to 39 EUR a month | [A] |
| Retailer and online shop | A few large shops (for example roastmarket) run affiliate programmes at 6 to 12% [S17] [R] | Qualified traffic | Data they cannot act on | Affiliate commission, not a fee | [R] |

Roaster revenue check [E]: 40 kg a week is about 2,080 kg a year; at an assumed 30 to 40 EUR per kg online that is 62,000 to 83,000 EUR turnover. Roaster production software is reported at 26 to 95 EUR a month and more (Cropster) [S18] [R], venue software for beer at about 90 to 120 USD a month (Untappd for Business) [S6] [R]. An insight add-on must sit clearly below a production tool: 19 to 39 EUR a month.

How the large comparables earn [S27] [R]: Untappd is reported to earn mainly from its business subscription for venues, with the consumer subscription beside it; Vivino from wine sales and merchant fees, with a premium subscription beside it. Neither lives on the consumer subscription alone, and both had millions of users first.

Who pays for what, in one line: the explorer pays the subscription, the roaster pays with distribution first and money later, the retailer pays commission, the hobbyist pays with data.

## 2 Value metric and tiers

**Value metric: access to community data, by breadth and depth.** Breadth is "all beans, not only the ones I rated". Depth is "all eight criteria, method breakdown, recipe ranges, rankings". Not seats, not usage, not number of logs. Limiting the log (as BrewJournal does with 8 free logs [S9] [R]) would starve the data set that the paid tier sells; reject it.

### Tiers

| | Free | Paid ("Explore") |
| --- | --- | --- |
| Scan, shelf, brew, rate, recipes, own statistics, CSV export, offline | Unlimited, for ever [D] | Same |
| Community overall score and rater count | For beans the user rated (give-to-get) [D] | All beans |
| Full profile, method breakdown, recipe ranges, rankings, filters | No | Yes |
| Community markers next to own averages (M2-T44, M2-T48) [D] | Overall only, for rated beans | All criteria |

Rules that protect the promise on the companion page ("Your history and your own statistics are free" [D]):

- Nothing that is free today moves behind the paywall, ever.
- A lapsed subscriber loses Explore and nothing else. Own data, export and give-to-get stay.

### Give-to-get threshold

Recommended: the user sees the community overall for a bean once they have **one rated brew of that bean in their own log**, and the bean has 5 distinct raters. Derived from the user's own brews, as docs/04 already foresees (there is no per-bean rater list) [D].

Two collisions to avoid:

- **Tying the teaser to consent.** "Share your ratings to see the community score" makes a benefit conditional on consent. Art. 7(4) GDPR makes such consent doubtful [A], and App Review 5.1.1 says paid functionality must not depend on granting access to data, and that consent must be withdrawable easily [V]. Compliant variant: the teaser depends on rating, not on sharing. A user who rates but does not share still sees the teaser. The cost is a few free riders; the gain is a clean consent.
- **Raising the threshold to "rate 3 brews".** More data, but it reads as a chore and delays the first "aha". Keep 1.

### Trial design

A classic free trial fits badly: the paid value is lookup, and a week is enough to look up a whole shelf and cancel. Reported benchmarks say 55% of 3-day-trial cancellations happen on day 0 [S10] [R]. Recommended: **no free trial at launch**. Give-to-get is the permanent free sample. Use an introductory offer of the "pay up front" type instead (first year 19.99 EUR, then 29.99 EUR); Apple allows one introductory offer per subscription group and customer, in the types free trial, pay as you go and pay up front [V]. Test a 7-day free trial on the annual plan later (section 6).

### Purchase types

| Type | Fit | Recommendation |
| --- | --- | --- |
| Auto-renewing subscription, annual | Best. Matches the ongoing cost of a growing data set; Apple requires "ongoing value" for subscriptions [V], and nightly-updated community data is that | **Launch** |
| Auto-renewing subscription, monthly | Needed as the low-commitment door, priced so that annual is clearly better. Risk: one month, look up everything, cancel | **Launch**, at 3.99 |
| Lifetime (non-consumable) | Economically safe: a user costs well under 0.01 USD a month [D], so ten years cost under 1 USD [E]. Comparable apps sell it at 79.99 to 99.99 USD [S8] [S9] [R]. Nets about 43 EUR at 59.99 and 57 EUR at 79.99 [E]. But it hides the retention signal | **Later**, after 6 to 12 months, at about 2.5 times the annual price |
| Tip jar (consumable) | Allowed: apps may use in-app purchase to let customers tip the developer [V]. Honest fit for hobbyists who will never need Explore. Small money | **Later**, cheap to add |
| One-time unlock per bean | Micro-transactions on a lookup; confusing next to a subscription | Reject |
| Family Sharing | Up to five family members share one subscription. Once enabled for a subscription it cannot be turned off [V]. Entitlement is on the profile, so shared members need extra handling | **Not at launch.** Decide after a year |

### Price points

Net per subscriber after 19% German VAT and 15% commission, assuming the commission applies to the price net of VAT (as docs/06 does) [A]. Formula: price / 1.19 x 0.85.

| Plan | Price EUR | Net per year | Net per month | Mark |
| --- | --- | --- | --- | --- |
| Annual (docs/03 default) | 19.99 | 14.28 | 1.19 | [E] |
| Annual | 24.99 | 17.85 | 1.49 | [E] |
| **Annual (recommended)** | **29.99** | **21.42** | **1.79** | [E] |
| Annual | 39.99 | 28.56 | 2.38 | [E] |
| Monthly (docs/03 default) | 2.99 | 25.63 | 2.14 | [E] |
| **Monthly (recommended)** | **3.99** | **34.20** | **2.85** | [E] |

Comparable prices, all [R] unless noted:

| App | Category | Monthly | Annual | Other | Source |
| --- | --- | --- | --- | --- | --- |
| Filtru | Coffee brewing | 3.49 USD | 32.99 USD (39.99 EUR on euro storefronts) | Lifetime 79.99 USD | [S8] |
| Sola Coffea | Coffee | 4.99 USD | 39.99 USD | Lifetime 99.99 USD | [S9] |
| BrewJournal | Coffee log | 0.99 USD | | Free tier capped at 8 logs | [S9] |
| Beanconqueror | Coffee log | Free, open source, donations | | | [S9] |
| Untappd Insiders | Beer | 5.99 USD | 54.99 USD | | [S5] |
| Vivino Premium | Wine | 4.99 USD | 47.90 USD | Free shipping perk | [S7] |
| Whiskybase Plus | Whisky | 4.99 EUR | 49.99 EUR | Voluntary supporter tier from 100 EUR a year | [S19] |
| Delectable Premium | Wine | 5.99 USD | | Possibly outdated (2017) | [S19] |

Why start at 29.99 and not 19.99:

- Apple applies a price decrease to existing subscribers automatically, while an increase can require each subscriber's opt-in, and those who do not agree expire [V]. Starting high and discounting is reversible; starting low is not.
- The launch offer (first year 19.99) gives early buyers the lower price while the data is thin, without setting 19.99 as the anchor.
- The buyer is the explorer who spends 400 to 500 EUR a year on beans (a bag every two weeks at 15 to 20 EUR [D]); 29.99 is 6 to 7% of that [E].

Regional prices: Apple offers 800 price points and can equalise from a base storefront; one future price change per territory can be scheduled [V]. Proposal [A]: base storefront Germany at 29.99 EUR; the euro area follows at the same price; Switzerland, the United Kingdom and the United States at the nearest local point to parity (about CHF 29, GBP 25.99, USD 29.99); every other storefront on Apple's equalised price. Proceeds differ per country because VAT rates differ.

## 3 Revenue lines beyond the consumer subscription

| Line | What it is | Collision | Compliant variant | Verdict |
| --- | --- | --- | --- | --- |
| **Roaster view of own beans** | The aggregates of a roaster's beans in one place, as a PDF or CSV made by the operator CLI | Invariant 4 (5 raters); App Review 5.1.2: data may not be repurposed without further consent [V]; roasters know their customers, so small cohorts leak | Show only what any subscriber could already see (same aggregates, same threshold, same purpose: "community averages"), bundled per roaster. Delivered outside the app, so no in-app unlock and no IAP question. Free in the first 24 months in exchange for distribution | **Secondary option 1** |
| **Roaster insight report, paid** | Deeper cuts: trend over time, method mix, flavour-note distribution, comparison with an anonymous peer group | New purpose: needs the consent text to name it from the start, or a new consent. Re-identification in small cohorts (section 8) | Minimum 20 raters per cell, monthly snapshots (not nightly), peer group of at least 10 roasters, no cell below the minimum, lawyer review first | Later, 19 to 39 EUR a month, invoiced |
| Anonymous benchmark dashboard | "Your washed Ethiopians score 0.4 above the peer median" | As above; also a web client and login, which do not exist | Start as a line in the PDF report; no dashboard until 50 paying roasters | Later |
| Verified roaster page | A roaster confirms its beans and their attributes | Invariant 1: a roaster-written description is free text; a self-service portal is out of scope [D] | Roaster confirms attributes from pick lists through the operator; a shop link is operator-curated catalogue data, response-only like the Open Food Facts name (ADR 0005) [D]. A "verified by the roaster" label, no text | Bundle with the roaster view |
| **Sponsored placement** | Paid position in rankings or search | Destroys the one asset: comparable, unbought numbers. App Review 5.6 forbids manipulative practices [V] | None inside rankings. At most a clearly labelled, separate "new from roasters" shelf that never touches a ranking and is sold at a flat fee | **Reject for 24 months** |
| **Affiliate links to retailers** | "Buy this bean" link on a bean page | Out of scope for v1 [D]. Physical goods are sold outside in-app purchase, which Apple requires anyway [V]. Tracking: network links set cookies on the retailer's side | A plain outbound link with a fixed partner parameter or a displayed coupon code; no SDK, no click logging per user. One reported programme pays 12% on new and 8% on existing coffee customers, 6% on machines, and only on sales with a listed coupon [S17] [R]. Link shown on every bean with a known shop, never influencing rank, disclosed | **Secondary option 2**, after launch |
| Gear and bean-subscription partnerships | Same mechanism for grinders and subscriptions | Same as affiliate | Same; the grinder pick list already exists [D] | Later, with affiliate |
| Merch | Cups, prints | No invariant, no margin, real distraction for one person | Print on demand only if asked for | Reject |
| Data licensing to research | Aggregate tables for universities | Individual ratings are never licensed. Open Food Facts share-alike on catalogue data is unresolved (D5) [D] | Aggregates only, minimum 20 raters, free for academic use against citation | Not a revenue line |
| Commercial data licensing | Selling the data set to market researchers | The "data being sold" risk of docs/03 [D]; App Review 5.1.2 limits sharing collected data with third parties [V] | None worth the trust cost | **Reject** |
| Score badge or read API for roasters | A roaster shows "Cupmark 8.4 (37 raters)" on its shop | Gives roasters a reason to push ratings; needs a public route | Aggregate only, at least 20 raters, pay-per-request on the existing API, rate-limited | Later, part of the paid roaster tier |
| White label | The app under a roaster's brand | A second product for one person | None | Reject |
| Advertising | Banner or network ads | Invariant 7, and the companion page promises none [D] | None | **Reject** |

Billing for roasters [A]: an invoice and a bank transfer need no cloud resource and no SDK. A payment provider is a real account and a new data processor, so it is the owner's decision. Business registration and VAT on B2B sales need a tax adviser.

## 4 Network effects and the cold start

### Where the value comes from

A bean page is worth something when at least 5 distinct people rated the bean [D]. Value therefore grows with ratings per bean, not with users. Ten thousand users who each rate a different micro-lot produce nothing.

Rough density model [E]. Assume 1,000 consenting users who each rate 10 different beans a year: 10,000 user-bean pairs. Spread evenly over 2,000 beans that is 5 per bean, just at the threshold, so real (uneven) distribution leaves most beans below it. Concentrated on 400 beans it is 25 per bean. Density is a matter of concentration: one region, one catalogue.

Three consequences:

- **The first beans with data will be barcoded, widely sold beans**, not micro-lots: they resolve through Open Food Facts and many people own them [D]. That audience (households with whole-bean machines [S14] [R]) is larger than the specialty niche. The paid tier's first honest promise is "which widely available bean suits my method", not "every specialty lot".
- **Reference recipes are never community data** (ADR 0034) [D]. They stay labelled as published numbers and are not part of the paid offer. Seeding the community numbers with anything other than real consenting raters is rejected.
- **Launch by region and catalogue**: German-speaking countries first (German and English are the launch languages [D]), with a named list of 10 to 20 partner roasters whose beans are verified in the catalogue before launch.

### How monetization avoids selling emptiness

1. **Coverage gate before the paid tier is sold.** Do not offer the subscription in a storefront until both hold [A]: at least 200 beans have 5 raters, and at least 30% of users active in the last 30 days have 3 or more beans on their shelf with community data. Both are counts the nightly job can write to its log line. Until then the app is free and says "community data is growing".
2. **The paywall appears only on a bean that has data.** A bean below the threshold shows "not enough ratings yet", with no purchase prompt. This is already the mitigation in docs/03 [D].
3. **The paywall states coverage as a number**: "Community data for N coffees, M of them on your shelf". A number from the nightly job, not text.
4. **Launch price while thin**: the first-year offer of 19.99.
5. **Store listing matches reality.** App Review treats charging for content that is not delivered as a breach of the developer code of conduct [V].

### Roaster-driven onboarding

A roaster adds an App Store link and a code to bags, shipping notes and the shop. Its customers all own the same few beans, so those beans pass 5 raters within weeks. The roaster gets the aggregate view (section 3). Two Apple mechanisms make this measurable without tracking: App Store Connect campaign links attribute downloads to a source, and offer codes can be custom words whose redemptions are reported by App Store Server Notifications [V]. One code per roaster gives a per-roaster count with no SDK and no user-level data.

Risk: a roaster's fans rate kindly. The daily one-vote rule, the cap and the plausibility rules of ADR 0035 limit volume, not bias [D]. Mitigation in section 8.

### Give-to-get as the loop

Rate a bean, see the community overall, see that the full profile exists, buy or keep rating. Every rating also moves another bean towards 5. The loop only turns if a meaningful share of rated beans have data, which is why the coverage gate and the regional focus come first.

## 5 Unit economics

### Cost per user (from docs/06)

| Monthly active users | AWS total, USD a month | Per user, USD a month | Per paying user at 3% conversion | Mark |
| --- | --- | --- | --- | --- |
| 1,000 | about 1 | about 0.001 | about 0.03 | [D] [E] |
| 10,000 | about 3 to 6 | about 0.0003 to 0.0006 | about 0.01 to 0.02 | [D] [E] |
| 50,000 | about 238 | about 0.005 | about 0.16 | [D] [E] |

Above 10,000 users sign-in dominates (about 220 of 238 USD at 50,000) [D]. A paying user's extra cost is a few dozen more reads a month, which is far below a cent [E]. Even at 50,000 users the AWS cost per paying user (0.16 USD) is about 9% of the 1.79 EUR net at 29.99 [E].

Costs outside AWS [D] [A]: the Apple developer membership (yearly), a domain, the tooling used to build the app, a lawyer for the terms and the privacy policy (one-off), a tax adviser.

### Apple's share

- Small Business Program: 15% on paid apps and in-app purchases for developers with up to 1 million USD proceeds in the prior calendar year; new developers qualify; enrolment is required [V] [S1]. It is still an open human task in docs/07 [D].
- EU terms since 1 October 2026: 26% for sales through Apple In-App Purchase; 15% for Small Business Program participants and for subscriptions after their first year [V] [S2]. Without the programme the first year costs 26%, not 15%: net at 29.99 falls from 21.42 to 18.65 EUR a year [E].
- Elsewhere: 70% to the developer in a subscriber's first year, 85% after one year of paid service, and 85% from the start in the Small Business Program [V] [S3].
- Alternative payment in the app (10% for programme participants) and link-outs (10% for programme participants on sales within 7 days of the tap) exist in the EU, and the chosen payment options must be kept for 12 months [V] [S2]. Both need a payment provider, which is a third party and a real account. The saving against 15% is at most 5 points before payment costs. **Not worth it at this size.**

### Break-even for a solo founder

Subscribers needed, all on the annual plan, net per month as in section 2 [E]:

| Target net per month | 19.99 a year | 24.99 | 29.99 | 39.99 |
| --- | --- | --- | --- | --- |
| 15 EUR (membership, domain, AWS at small scale) | 13 | 11 | 9 | 7 |
| 200 EUR (plus build tooling [A]) | 169 | 135 | 113 | 85 |
| 1,000 EUR (side income, before income tax) | 841 | 673 | 561 | 421 |
| 4,000 EUR (a living, before income tax [A]) | 3,362 | 2,690 | 2,241 | 1,681 |

At 3% conversion, 2,241 subscribers mean about 75,000 monthly active users, where sign-in alone costs about 360 USD a month (65,000 billable users x 0.0055 USD) [E] [D].

### Sensitivity: net revenue per month for every 10,000 monthly active users

EUR, annual plan only [E]. AWS at 10,000 users is about 3 to 6 USD [D].

| Share of active users who subscribe | 19.99 | 24.99 | 29.99 | 39.99 |
| --- | --- | --- | --- | --- |
| 1% | 119 | 149 | 179 | 238 |
| 2% | 238 | 297 | 357 | 476 |
| 3% (docs/03 target) | 357 | 446 | 536 | 714 |
| 5% | 595 | 744 | 893 | 1,190 |

Each value is 10,000 x share x net per month.

Reference points for the share: the median freemium app converts 2.1% of downloads to paid within 35 days, against 10.7% for apps with a hard paywall; the figures come from a 2026 report over 115,000 apps [S10] [R]. A critique notes that the hard-paywall figure leaves out people who walk away at the gate [S12] [R]. That base is downloads, not active users, so it is not the same ratio as the 3% target in docs/03. Renewal is the bigger unknown: the same report is summarised as saying that first-year cancellation of annual plans worsened in 2026 and that 95% of cancelling annual subscribers never return [S10] [S11] [R]. Plan for less than half of annual subscribers renewing until own data says otherwise [A].

### The nightly job at scale

- Read cost: about 3 USD a month at 50,000 users, accepted by the owner [D]. Scaling linearly, about 30 USD at 500,000 users [E].
- The limit is run time, not money: one invocation, 300 seconds, 512 MB; ADR 0035 already sets the trigger (more than half of the timeout, or 60% of memory) for splitting the scan [D]. No monetization line changes this, as long as B2B reports are computed from the stored aggregates and not by a second scan.
- Monthly B2B snapshots would be one more scheduled run a month reading aggregate items only: cents [E].

### When a fixed-fee resource is justified

Invariant 5 needs an approved ADR for each [D]. A rule the owner can apply [A]: a fixed fee is worth an ADR when it is under 5% of the trailing three months' average net revenue **and** it removes a risk that pay-per-use cannot.

| Resource | Why it might be needed | Rough fee | Justified from |
| --- | --- | --- | --- |
| WAF with a rate rule (named in docs/05 "When to revisit") [D] | Abuse of public or paid routes, scraping of community data | Under 10 USD a month plus requests [A] | First real abuse incident, or about 200 EUR net a month (about 113 subscribers at 29.99) [E] |
| Own sign-in authorizer instead of Cognito | Not a fixed fee; it removes one. About 220 USD a month at 50,000 users [D] | Engineering time, security code to own | Above about 25,000 active users, where Cognito passes about 80 USD a month [E] |
| Payment provider for roasters | Invoicing at volume | Per transaction; some have no monthly fee [A] | 30 or more paying roasters |
| Anything else in the invariant's list | No monetization line here needs it | | Not foreseeable |

## 6 Pricing and packaging experiments without third-party analytics

### What Apple gives without an SDK

- **Subscription dashboards** in App Store Connect: active plans, recurring revenue, retention and conversion rates, cancellation reasons; an offers view for introductory, promotional and win-back offers and offer codes; cohorts with subscription retention; filters by territory, plan and offer [V] [S3].
- **App Analytics**: downloads, product-page conversion rate, source types and campaign links, sales, proceeds, paying users. Usage data (sessions, active devices, retention) covers only users who agreed to share diagnostics with developers. Peer-group benchmarks include conversion, retention, proceeds per paying user and download-to-paid conversion [V] [S4].
- **No built-in price A/B test** for subscriptions is described on Apple's subscription page; it describes the pricing tool, 800 price points and one scheduled price change per territory [V] [S3].

### Experiments that work with that

| Experiment | How | Measure | Caution |
| --- | --- | --- | --- |
| Price by storefront | Different price points in comparable storefronts (for example Germany against Austria and the Netherlands) for 8 weeks | Download-to-paid and proceeds per download per territory, in App Store Connect | Not randomised; small numbers; treat as direction only |
| Price over time | One scheduled change per territory | Same, before and after | Decreases reach existing subscribers automatically [V] |
| Introductory offer type | Pay up front 19.99 first year against 7-day free trial, by territory or in sequence | Offer conversion and retention in the offers view | One introductory offer per customer per group [V] |
| Annual against monthly emphasis | Change which plan the paywall preselects, with an app release | Plan mix in App Store Connect | Needs a release per change |
| Roaster channel | One custom offer code and one campaign link per roaster | Redemptions per code (server notifications), downloads per campaign | Codes are limited to 1 million redemptions per app per quarter [S20] [R] |
| Win-back | Offers to lapsed subscribers, eligibility by paid duration and time since lapse; Apple shows them in the app on iOS 18 and in subscription settings [V] [S21] | Offers view | Start after the first renewal cycle |
| Promotional offer | To existing or former subscribers, up to 10 per subscription, eligibility decided by own logic [V] | Offers view | Needs server signing |

### First-party counts that respect the invariants

Counts only, no user id, no bean id, no text, written to the nightly job's one log line (ADR 0035 keeps custom metrics out, and they would cost a fee per metric) [D]:

- beans with 5 or more raters, in total and added this week;
- share of shelf entries whose bean has community data (the coverage the user actually feels);
- profiles that consent to sharing, as a count;
- profiles with an active entitlement, by product id (a closed list);
- give-to-get views served and paid-route refusals for non-subscribers, counted from requests that happen anyway (the server's own response codes), not from a client event.

Collision: the companion page says the app does "no analytics" [D]. Counting server responses in aggregate is operations, not user analytics, but the privacy policy should say in one sentence that aggregate counts are kept. A client-side "paywall viewed" event would be first-party analytics; it is not forbidden by invariant 7, but it contradicts the published wording, so **do not add it**.

Apple Search Ads: campaigns run and report installs in Apple's own console with no SDK [A]. Per-install attribution uses Apple's AdServices framework and a call to Apple's attribution service [S22] [R]; it is a first-party Apple framework, reported as not needing the tracking prompt, but it links an install to a campaign, which sits badly with "no tracking". Recommended: Search Ads, if at all, **without** attribution code, judged by cost per install in Apple's console and by territory-level conversion.

## 7 Go-to-market and sequencing against the backlog

M4 to M6 are not yet planned [D]. This is input for `/plan-milestone`, not a plan.

### M4 Paid tier: build

- One subscription group with two products (annual, monthly). Apple recommends a single group [V].
- Entitlement on the profile that is product-agnostic (a product id from a closed list, an expiry, a source), so a lifetime purchase, an offer code or a shared family entitlement can be added later without a contract break.
- App Store Server Notifications route as designed in docs/05 [D]; it also carries offer-code redemptions.
- Paywall with the disclosures Apple requires: name and duration, what is provided, the full renewal price as the most prominent price, restore, links to terms and privacy [V].
- "Manage subscription" in Settings through the system sheet (`showManageSubscriptions`) [V]; it doubles as the cancellation path that German law expects to be easy to find (section 8).
- Offer-code redemption sheet (system API) [V]: this is the roaster channel.
- Billing grace period switched on in App Store Connect (3, 16 or 28 days) [V]: no code, fewer involuntary lapses.
- Paywall shown only on beans with data; coverage numbers on the paywall; counts in the nightly log line.
- Give-to-get from the user's own rated brews, independent of consent.

### M4: do not build

Family Sharing, lifetime, tip jar, free trial, roaster portal, affiliate links, any client event logging, any payment path other than Apple In-App Purchase.

### M5 Hardening

- App Attest and per-user write caps are already in scope [D]; they are also the defence of the data's value.
- Operator CLI: add "export the aggregates of one roaster's beans" (aggregate items only, threshold enforced by the single read path of M3 [D]). This is the whole roaster product for the first two years.
- Privacy review: the consent text should name every intended use of the aggregates now (shown to subscribers; shown to the roaster of the bean), so no later re-consent is needed for secondary option 1.

### M6 Launch

- TestFlight interviews (five per persona are planned [D]): add three price questions (too cheap, expensive but acceptable, too expensive) and "would you scan a code on a bag".
- Launch the free app first. Switch the paid tier on per storefront when the coverage gate holds. The suggested order of work in docs/07 already says to add the paid tier once the first beans pass the threshold [D].
- Sign 10 to 20 partner roasters in the launch region before the store release.
- Join the Small Business Program before the first sale [D].

### M4 design decisions this strategy depends on

| Decision | This strategy assumes | If decided otherwise |
| --- | --- | --- |
| Give-to-get source | Own rated brews of the bean (not shelf alone) | Shelf alone lets a user "unlock" by adding beans without rating: the loop yields no data |
| Give-to-get and consent | Independent | Legal and App Review risk (section 8) |
| What free users see | Overall score and rater count for rated beans; a locked outline of the rest | Showing nothing removes the upsell; showing more removes the product |
| Paywall placement | Contextual, on a bean with data and on rankings; never at onboarding, never in the logging flow | An early paywall hurts activation, which is the data supply |
| Lapsed subscriber | Explore locks; everything else stays; win-back offers after one month | Holding own data back would break the free promise |
| Price ids | Products configurable in App Store Connect, not hard-coded prices in the app | Every price test needs a release |
| Top-recipe ranges | Part of paid; minimum cups per method decided in M4 [D] | This is the prosumer's and the café's reason to pay |
| Ranking rule | Rank only beans with a higher minimum than 5 raters and by a cautious estimate, not the raw mean [A] | Rankings of 5-rater beans are noise and easy to game |

## 8 Legal, ethical and trust risks

Not legal advice. Every row marked [A] or [R] needs a lawyer before the paid launch; the companion page already says the terms are a draft [D].

| Risk | Why | Mitigation |
| --- | --- | --- |
| Consent that is not free | A benefit tied to consent; unclear purpose | Give-to-get independent of consent; the consent text names each use; withdrawal in one tap, effective at the next nightly run [D] |
| Purpose creep (B2B) | App Review: data collected for one purpose may not be repurposed without further consent; data may be shared with third parties only to improve the app or serve advertising [V]. Whether anonymous aggregates are "data collected from apps" in that sense is untested [A] | Roaster view limited to what subscribers see; anything deeper only after consent wording, lawyer review and a higher minimum |
| "They sell my data" | Named as a risk in docs/03 [D] | Say it plainly at onboarding: "Subscribers and the roaster of a bean see averages. Nobody sees your ratings." No licensing of the data set. Publish the 5-rater rule and the roaster rules on the companion page |
| Re-identification in small cohorts | Differencing: if a bean goes from 5 to 6 raters overnight, the new rater's score is about 6 x new mean minus 5 x old mean. With means rounded to 0.1 the error is about plus or minus 0.55 points [E]. A roaster may know who bought yesterday. The per-part 5-rater rule [D] prevents reading one user out of a part, not this | For anything a roaster sees: minimum 20 raters, monthly snapshots, no day-level history. For subscribers: consider showing the rater count in bands and delaying the first display until a second rater joins after the fifth [A]. European guidance names singling out, linkability and inference as the tests [S23] [R]; new EDPB guidelines on anonymisation are reported for 2026 and should be read by the lawyer [S23] [R] |
| Cancellation button | German law requires a cancellation button for paid subscriptions concluded online; the Federal Court of Justice is reported to have held in autumn 2026 that this also covers apps [S24] [R]. Whether the developer or Apple is the obliged party for an In-App Purchase is open [A] | "Manage subscription" in Settings (system sheet), plus a cancellation notice and contact on the companion page |
| Withdrawal right and button | 14-day withdrawal for digital content, which ends early only with express consent and confirmation [S25] [R]; a withdrawal button for online contracts, apps included, is reported to apply in Germany from 19 June 2026 [S26] [R]. Apple handles purchase and refund; the split of duties is open [A] | Lawyer; describe the refund path in the terms |
| Renewal terms | German rules on automatic renewal of consumer contracts may limit yearly renewal [A] | Lawyer; if in doubt, sell the monthly plan prominently |
| Price transparency | Apple: the billed amount must be the most prominent price; trial length and the price after it must be clear [V]. Total price including VAT under German price rules [A] | Follow Apple's paywall rules; no per-week or per-day price display |
| Dark patterns | App Review forbids tricking users into purchases and raising prices in a tricky manner [V] | No countdowns, no pre-ticked options, no nagging; one prompt per bean view at most; price increases through Apple's consent flow |
| App Review: forced actions | Apps must not force users to rate or review the app to access functionality; they may otherwise incentivise actions in the app [V] | Give-to-get rewards rating a coffee, not the app. Never ask for an App Store review in exchange for anything |
| App Review: thin content | Charging for content not delivered [V] | Coverage gate; paywall only on beans with data |
| Ranking manipulation by a paying roaster | A roaster who pays expects visibility | No paid ranking, ever, written into the roaster terms. Verified label says who confirmed the attributes, nothing about quality |
| Review bombing and fan votes | One vote per user, bean and day; cap of 10 cups; plausibility rules [D]. These bound volume, not coordinated bias | App Attest (M5) [D]; higher minimum for rankings; show spread next to the mean [D]; counts of left-out brews per reason in the log line show an attack [D] |
| Affiliate bias | A commission is a reason to favour a shop | Links never affect order; disclosed as paid links; one neutral rule for which shop is shown |
| Catalogue licence | Open Food Facts share-alike on catalogue data is unresolved (D5) [D] | Keep catalogue and ratings separate [D]; lawyer before any licensing or API |
| Tax | Apple is the seller of record towards consumers; B2B invoices are the owner's own sales [A] | Tax adviser before the first roaster invoice |

## 9 Scenarios

**Illustrative scenarios, not forecasts.** They show how the result moves with reach, payer share and price. Every input is an assumption [A]; the arithmetic is [E]. Months count from the paid launch. Subscribers at the end of a year = active users x payer share; revenue of a year = average of start and end subscribers x net per month x 12. Renewal losses are folded into the payer share.

| | Conservative | Base | Ambitious |
| --- | --- | --- | --- |
| Story | Word of mouth only; data stays thin outside a few supermarket beans | Roaster channel works in German-speaking countries; coverage gate met in year 1 | Roaster channel plus a second language area; press in the coffee scene |
| Active users at month 12 / 24 / 36 | 500 / 1,500 / 3,000 | 3,000 / 10,000 / 25,000 | 10,000 / 40,000 / 100,000 |
| Payer share of active users | 1.5% | 2.5% | 4% |
| Price and net per month | 24.99 a year; 1.49 | 29.99 a year; 1.79 | 70% annual 29.99, 30% monthly 3.99; 2.10 blended |
| Subscribers at month 12 / 24 / 36 | 8 / 23 / 45 | 75 / 250 / 625 | 400 / 1,600 / 4,000 |
| Subscription net, year 1 / 2 / 3 (EUR) | 70 / 270 / 600 | 800 / 3,500 / 9,400 | 5,100 / 25,300 / 70,700 |
| **Subscription net, 36 months** | **about 950** | **about 13,700** | **about 101,000** |
| Roaster tier | none | year 3: 10 roasters x 25 EUR x 12 = 3,000 | year 2: 20 x 39 x 12 = 9,400; year 3: 80 x 39 x 12 = 37,400 |
| Affiliate (0.5% of active users buy through a link each month, 2 EUR commission per order) | none | year 3: 17,500 average users x 0.5% x 2 x 12 = 2,100 | year 2: 3,000; year 3: 8,400 |
| **Total net, 36 months (EUR)** | **about 1,000** | **about 14,000 to 19,000** | **about 100,000 to 160,000** |
| AWS at month 36 (USD a month) | under 1 | about 95 (sign-in about 82) | about 530 (sign-in about 495) |

"Net" is after VAT and Apple's 15%, before AWS, other costs and income tax. Income from roasters and affiliates is before VAT handling and any payment fees.

What the scenarios say:

- The conservative case does not pay for a lawyer. It is still a working product with near-zero running cost, which is the point of the architecture.
- The base case is a modest side income by year 3 and depends on the roaster channel, not on the price.
- In the ambitious case sign-in cost becomes the largest bill; the replacement described in docs/05 pays for itself there [D].

## 10 Recommendation

### The primary path

Consumer subscription through StoreKit 2, annual 29.99 EUR and monthly 3.99 EUR, first year 19.99 EUR as an introductory offer, no trial, no Family Sharing, paid tier switched on per storefront only when the coverage gate holds, give-to-get on own rated brews and independent of consent.

### Two secondary options

1. **Roaster programme**: free aggregate view of own beans in exchange for bag codes and links, from launch; a paid insight tier at 19 to 39 EUR a month once 50 roasters are active and a lawyer has cleared the consent wording.
2. **Plain affiliate links** to shops for beans and gear, with no tracking code, after launch and after the owner reopens the v1 scope.

### Decide now, decide later

| Now (before M4 is planned) | Later (with data) |
| --- | --- |
| Price points for the App Store Connect products (docs/07, D4) | Lifetime purchase and tip jar |
| Whether the paid tier waits for a coverage gate, and the gate's numbers | Family Sharing (irreversible) |
| Give-to-get: own rated brews, independent of consent | Free trial against introductory price |
| Consent wording that names subscribers and roasters as viewers of averages | Paid roaster tier, its price and minimum cohort |
| Launch region and the first roaster list | Affiliate programme and partners |
| No ads, no sponsored ranking, no data licensing: written down as an ADR | Search Ads; a second language area; Android or web |
| Small Business Program enrolment | Replacing Cognito above 25,000 users |

### Kill or continue checklist

First-party or App Store Connect signals only. Review at 6 and 12 months after the store release. Thresholds are assumptions to be set by the owner.

| Signal | Source | Continue | Rethink |
| --- | --- | --- | --- |
| Beans with 5 or more raters | Nightly log line | 200 at month 6; 500 at month 12 (docs/03 aims at the 500 most-logged beans within six months [D]) | Under 50 at month 6 |
| Share of shelf entries with community data | Nightly log line | 30% or more | Under 10% |
| Share of users who consent to sharing | Count of profiles | 60% or more | Under 30%: the wording or the trust is wrong |
| First rated brew on day one | Count of profiles with a rated brew within a day of creation | 60% (docs/03 target [D]) | Under 30% |
| Download to paid, in storefronts where paid is on | App Store Connect, with peer benchmark | At or above the peer median; 2% or more | Under 1% after two price or offer changes |
| Annual renewal at the first anniversary | App Store Connect cohorts | 45% or more | Under 25% |
| Refund requests | App Store Connect | Under 3% of purchases | Above 6% |
| Roasters with a redeemed code | Offer-code redemptions | 10 by month 6 | 0 to 2 |
| Monthly net revenue against monthly cost | Apple payments, AWS bill | Covers running cost by month 12 | Does not cover the membership fee by month 18 |

If three or more signals sit in "rethink" at month 12: keep the free app running (it costs almost nothing), stop work on paid features, and decide between a tip jar only, a roaster-only product, or leaving it as it is.

### The 10 questions the owner must answer

1. Is 29.99 EUR a year with a 19.99 EUR first year acceptable, or does 19.99 EUR stay as the list price (docs/07, D4)?
2. May the paid tier launch later than the app, gated on coverage, and are 200 beans and 30% the right gate?
3. Is give-to-get independent of consent, accepting some free riders?
4. Should the consent text name roasters as viewers of averages from day one, so that the roaster programme needs no second consent?
5. Is "no paid ranking, no ads, no licensing of the data set" a permanent rule worth an ADR?
6. Which region and which 10 to 20 roasters first, and who talks to them?
7. Should the paid tier stay purely community data, or gain a few new personal power features so that it has value while data is thin (nothing currently free would move)?
8. Are affiliate links wanted at all, given that docs/03 excludes them from version 1?
9. Who is the lawyer for terms, privacy, cancellation and withdrawal duties, and the tax adviser for roaster invoices, and what is the budget?
10. What result at month 12 means stop, and what means invest more time (the checklist above is a proposal)?

## Decision table

| Option | Revenue potential (36 months) | Cloud cost | Effort | Risk | Invariant fit |
| --- | --- | --- | --- | --- | --- |
| **Consumer subscription, annual and monthly (primary)** | 1,000 to 100,000 EUR, by reach | None beyond docs/06 | In M4 already | Thin data at launch; renewal | Fits all |
| First-year introductory price | Raises early conversion; lowers year-1 net by a third | None | App Store Connect only | Low | Fits |
| Coverage gate before selling | Delays revenue; protects reviews and refunds | None (two counts in a log line) | Low | Low | Fits |
| **Roaster programme, free view (secondary 1)** | Indirect: data density | Cents | Operator CLI export; outreach time | Fan bias; small cohorts | Fits if aggregate only, threshold kept, no free text |
| Roaster insight tier, paid | 3,000 to 47,000 EUR | Cents | Medium; lawyer; invoicing | Purpose creep; re-identification | Fits only with consent wording and a minimum of 20 |
| **Affiliate links, no tracking (secondary 2)** | 2,000 to 11,000 EUR | None | Low to medium; partner contracts | Bias perception | Fits (operator-curated links); out of v1 scope today |
| Lifetime purchase | One-off 43 to 57 EUR net each | None | Low once entitlement is product-agnostic | Hides the retention signal | Fits |
| Tip jar | Small | None | Low | None | Fits |
| Family Sharing | Slightly negative per household, some goodwill | None | Medium (shared entitlement) | Cannot be undone | Fits |
| Free trial | Unknown; lookup-and-cancel risk | None | Low | Refunds, day-0 cancellations | Fits |
| Score badge or read API for roasters | Part of the roaster tier | Per request | Medium | Incentive to push ratings | Fits with threshold and rate limit |
| Benchmark dashboard (web) | Part of the roaster tier | Per request | High (a web client) | As paid tier | Fits only as above |
| Research access to aggregates | None | Cents | Low | Catalogue licence (D5) | Fits if aggregate only |
| Sponsored placement in rankings | Some | None | Low | Destroys trust | **Reject** |
| Commercial data licensing | Some | None | Medium | Trust, GDPR, App Review 5.1.2 | **Reject** |
| Advertising | Some | None | Medium | Breaks the promise | **Breaks invariant 7** |
| Alternative payment or link-out in the EU | Saves at most 5 points of commission | Payment fees | High; 12-month lock-in | Third party, real account | Needs the owner; not worth it now |
| Merch, white label | Negligible | None | High | Distraction | Reject |

## Sources

Accessed 2026-11-27. "Fetched" means the page was read in this session. "Search summary" means only the search engine's summary was read, because the session's network settings allowed no other host than `developer.apple.com`; these need opening before anyone relies on them.

| Id | Source | How read |
| --- | --- | --- |
| S1 | Apple, App Store Small Business Program. https://developer.apple.com/app-store/small-business-program/ | Fetched |
| S2 | Apple, Update on apps distributed in the European Union (commission tables, effective 1 October 2026). https://developer.apple.com/support/apps-in-the-eu/ and https://developer.apple.com/news/?id=gmws0jgp | Fetched |
| S3 | Apple, Auto-renewable subscriptions (revenue share, Family Sharing, offers, price changes, grace period, dashboards, paywall requirements). https://developer.apple.com/app-store/subscriptions/ | Fetched |
| S4 | Apple, App Analytics in App Store Connect. https://developer.apple.com/app-store-connect/analytics/ | Fetched |
| S4b | Apple, App Review Guidelines (3.1.1, 3.1.2, 3.1.3(e), 3.2.2, 4.5.4, 5.1.1, 5.1.2, 5.6). https://developer.apple.com/app-store/review/guidelines/ | Fetched |
| S5 | Untappd help centre, pricing options for Untappd Insiders. https://help.untappd.com/hc/en-us/articles/4409476745492-What-are-my-pricing-options-to-become-an-Untappd-Insider | Search summary |
| S6 | BeerMenus, guide to Untappd for Business (plan prices). https://www.beermenus.com/blog/260-guide-to-untappd-for-business ; Untappd, https://utfb.untappd.com/get-pricing/ | Search summary |
| S7 | Vivino Premium terms and App Store listing. https://www.vivino.com/legal/premium-subscription-terms ; https://apps.apple.com/us/app/-/id414461255 | Search summary |
| S8 | Filtru App Store listings. https://apps.apple.com/app/id1150921819 ; https://apps.apple.com/de/app/filtru-coffee/id1150921819?l=en | Search summary |
| S9 | App Store listings: Sola Coffea https://apps.apple.com/app/id6737065958 ; BrewJournal https://apps.apple.com/us/app/brewjournal/id6758138863 ; Beanconqueror https://beanconqueror.gitbook.io/beanconqueror/resources | Search summary |
| S10 | RevenueCat, State of Subscription Apps 2026 and benchmark article. https://www.revenuecat.com/state-of-subscription-apps-2026/ ; https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026 | Search summary |
| S11 | 9to5Mac on the same report, 4 March 2026. https://9to5mac.com/2026/03/04/new-report-looks-into-the-sustainability-of-the-subscription-app-market-for-2026/ ; heise, https://heise.de/-11310636 | Search summary |
| S12 | Airbridge, Hard paywall vs freemium in 2026. https://www.airbridge.io/en/blog/hard-paywall-vs-freemium-2026 | Search summary |
| S13 | Tageskarte, regional roasters (about 650 small roasters). https://www.tageskarte.io/industrie/detail/800-aromen-pro-bohne-wie-regionale-roestereien-den-markt-aufmischen.html ; Nationalatlas (customs count). https://nationalatlas.de/wp-content/uploads/24_03_Kaffee.pdf | Search summary |
| S14 | Deutscher Kaffeeverband, Deutscher Kaffeemarkt 2025. https://www.kaffeeverband.de/media/presse_pdf/Deutscher_Kaffeemarkt_2025.pdf | Search summary |
| S15 | Fortune Business Insights, Europe specialty coffee market. https://www.fortunebusinessinsights.com/europe-specialty-coffee-market-114213 | Search summary |
| S16 | Perfect Daily Grind, 11 June 2026. https://perfectdailygrind.com/2026/06/germany-coffee-habits-changing/ | Search summary |
| S17 | roastmarket affiliate programme and its Awin profile. https://www.roastmarket.de/affiliate/ ; https://ui.awin.com/merchant-profile/16916 | Search summary |
| S18 | Cropster pricing. https://cropster.com/pricing/roast | Search summary |
| S19 | Whiskybase Plus price. https://support.whiskybase.com/support/solutions/articles/33000289048-how-much-does-whiskybase-plus-cost ; Delectable. https://apps.apple.com/US/app/id512106648 | Search summary |
| S20 | Apple, set up offer codes. https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-subscription-offer-codes | Search summary |
| S21 | Apple, set up win-back offers. https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-win-back-offers/ | Fetched |
| S22 | Apple Ads, Attribution API. https://ads.apple.com/app-store/help/reporting/0028-apple-ads-attribution-api | Search summary |
| S23 | Article 29 Working Party, Opinion 05/2014 on anonymisation techniques. https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2014/wp216_en.pdf ; EDPB guidelines on anonymisation (2026). https://www.edpb.europa.eu/system/files/2026-09/edpb_guidelines_202602_anonymisation_v1_en_0.pdf | Search summary |
| S24 | Reports on the Federal Court of Justice decision that the cancellation button applies to apps (I ZR 243/25; the date differs between reports). https://www.ra-plutte.de/bgh-kuendigungsbutton-gilt-auch-fuer-apps/ ; https://www.it-recht-kanzlei.de/kuendigungsbutton-in-apps-ab-wann-pflicht.html | Search summary |
| S25 | Verbraucherzentrale on the withdrawal right for digital content. https://www.verbraucherzentrale.de/urteilsdatenbank/digitale-welt/videos-im-google-play-store-widerrufsrecht-erlischt-nicht-automatisch-38673 ; Heuking. https://www.heuking.de/de/news-events/newsletter-fachbeitraege/artikel/vorsicht-bei-widerrufsbelehrungen-bei-digitalen-inhalten-und-dienstleistungen.html | Search summary |
| S26 | Withdrawal button from 19 June 2026 (Directive (EU) 2023/2673). https://cm.twobirds.com/en/insights/2026/germany/mandatory-withdrawal-button-upcoming-in-germany-key-implications-for-online-sellers ; https://heuking.de/en/news-events/newsletter-articles/detail/new-cancellation-button-what-companies-must-implement-by-june-19-2026.html | Search summary |
| S27 | Vivino and Untappd business models and user counts. https://www.vivino.com/en/about ; https://en.wikipedia.org/wiki/Untappd ; https://lounge.untappd.com/what-is-untappd-for-business-a-complete-guide/ | Search summary |

Not found or not confirmed in this session, so not used as facts: a subscription-price median for hobby apps; the share of specialty coffee in German retail; the number of home espresso households; the Apple developer membership fee; how Apple computes proceeds against VAT; Apple's refund practice in the EU.
