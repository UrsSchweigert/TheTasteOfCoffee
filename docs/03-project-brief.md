# Project brief

Build an iOS app that turns private coffee logging into a comparable, anonymous data set, and sell access to the aggregates as a subscription.

## Problem

Coffee feedback is prose and stars. It cannot be compared across people, it ignores how the coffee was brewed, and it needs moderation.

## Goals for version 1

- A scan-to-rated-brew flow that takes under 30 seconds for a repeat brew.
- Zero free-text fields, including sign-up, bean entry and support.
- A paid tier that is useful for the 500 most-logged beans within six months of launch.
- AWS cost under 5 USD a month up to 10,000 monthly active users.

## In scope

- iPhone app (SwiftUI, iOS 17 or later), German and English at launch.
- Sign in with Apple only.
- Barcode scan, bean catalogue, brew log, rating, personal statistics.
- Auto-renewing subscription through Apple In-App Purchase.
- Aggregates per bean, per bean and method, and rankings.

## Out of scope for version 1

- Android and web clients (the API is client-neutral, so they can follow).
- Social features: profiles, followers, comments, sharing of individual logs.
- Roaster self-service portal and a business tier.
- A shop or affiliate links.

## Tiers

| | Free | Paid |
| --- | --- | --- |
| Scan, catalogue, brew log, rating | Unlimited | Unlimited |
| Own statistics and taste profile | Yes | Yes |
| Export own data (CSV) | Yes | Yes |
| Community overall score | Only for beans you rated | All beans |
| Score profile on all 8 criteria | No | Yes |
| Best method and top recipes per bean | No | Yes |
| Rankings and filters (origin, process, roast level) | No | Yes |
| Suggested price | 0 | 2.99 EUR a month or 19.99 EUR a year (assumption) |

## Success metrics

- Activation: 60% of new users log a first rated brew on day one.
- Retention: 30% of users log at least 4 brews in their fourth week.
- Coverage: 70% of scans resolve to a known bean without manual entry.
- Conversion: 3% of monthly active users subscribe.

## Risks

| Risk | Mitigation |
| --- | --- |
| Cold start: aggregates are empty at launch | Give-to-get teaser; seed with roaster partnerships; show the paid tier only for beans that pass the 5-rater threshold |
| Specialty bags often have no barcode or share one across lots | Fallback entry by pick lists plus a label photo; operator curates |
| Rating manipulation by roasters or fans | Every cup counts, but a user's cups of one bean on one day share one vote (at most 10 cups a day count); automatic plausibility rules; App Attest |
| Free users object to their data being sold | Plain consent at onboarding; aggregates only; an opt-out that keeps the personal log working |
| App Store commission cuts the margin | Enrol in the Small Business Program (15% instead of the standard rate) |
