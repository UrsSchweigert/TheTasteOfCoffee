# Cost estimate

AWS costs stay in single-digit USD a month up to 10,000 monthly active users, then sign-in dominates. All figures are approximate, in USD per month, and should be re-run in the AWS Pricing Calculator for Frankfurt.

The nightly job adds a table Scan (about 3 USD a month at 50,000 users, an order-of-magnitude figure accepted by the owner; re-run it in the Pricing Calculator) and one write per changed aggregate item plus one write and one delete per ranking item each night. That rewrite is bounded by the number of aggregate items (beans and methods) and rankings, not by the number of brews; the `AGG#` items are written only when changed (or to refresh their stamp), the ranking items are new every night. The Scan is included in the DynamoDB line below: the earlier figure of about 3 USD for requests and storage at 50,000 users did not contain it, so the line is raised by the Scan to about 6 USD (3 + 3), and the total from about 235 to about 238 (about 235 + 3). Both are estimates. The two failure alarms and their topic cost 0 USD while the flag `failureAlarms.enabled` is false (the default) and about 0.20 USD per stage per month as an estimate once it is on (ADR 0035, Addendum 2); they are not in the table.

Assumptions: each active user makes 60 API calls and logs 8 brews a month; a brew causes about four write units in one transaction (the brew, its pointer and the shelf entry count; ADR 0010, ADR 0012) and no aggregate writes, because community aggregates are rebuilt by the nightly job (ADR 0035); label photos average 300 KB.

| Line item | 1,000 users | 10,000 users | 50,000 users |
| --- | --- | --- | --- |
| Cognito, Lite tier | 0 | 0 | about 220 |
| API Gateway HTTP API | under 0.10 | under 1 | about 4 |
| Lambda | 0 | 0 | about 1 |
| DynamoDB requests and storage, including the nightly Scan | under 0.10 | under 1 to about 2 | about 6 |
| Point-in-time recovery and exports | under 0.10 | under 0.50 | about 2 |
| S3 photos and backups | under 0.10 | under 0.50 | about 2 |
| CloudWatch logs and alarms | under 0.50 | about 1 | about 4 |
| **Total** | **about 1** | **about 3 to 6** | **about 238** |

## How the figures were derived

- **Cognito:** [AWS lists](https://aws.amazon.com/cognito/pricing) a free tier of 10,000 monthly active users for direct and social sign-in on the Lite and Essentials tiers. Above that, a [published breakdown](https://builder.aws.com/content/3KlTXfJhkIuYFkyPkM2P16amtXC/sign-in-for-10000-users-at-dollar0-with-amazon-cognito) gives 0.0055 USD per user on Lite and 0.015 on Essentials. 40,000 billable users on Lite is 220 USD.
- **DynamoDB:** on-demand requests have no free allowance, but volumes are small. Point-in-time recovery is quoted at about [0.20 USD per GB-month](https://www.bytebase.com/blog/understanding-dynamodb-pricing/), and the table stays under a few GB.
- **Lambda, API Gateway, S3, CloudWatch:** estimated from memory of list prices, not re-checked.

## Costs outside AWS

- Apple Developer Program membership (yearly fee).
- App Store commission. Apple's [Small Business Program](https://developer.apple.com/app-store/small-business-program/) reduces it to 15%. Apple's [August 2026 EU terms](https://www.apple.com/newsroom/2026/08/apple-announces-changes-for-apps-in-the-european-union/) set 26% for In-App Purchase in the EU outside such programmes.
- A domain for the privacy policy and support address.
- Claude usage for the agent team that builds the app (subscription or API tokens).

## Break-even

At 19.99 EUR a year and 15% commission, one subscriber nets about 1.20 EUR a month after 19% German VAT. Four subscribers cover AWS at 10,000 users. At 50,000 users and 3% conversion, 1,500 subscribers bring in roughly 1,800 EUR a month against 235 USD of AWS cost.

## Cost guardrails

- AWS Budgets alerts at 10, 25 and 50 USD.
- Log retention set to 14 days; logs contain no payloads.
- Lambda reserved concurrency capped; API throttled per stage and per user.
- Photo bucket lifecycle: delete label photos 90 days after the bean is verified.

## Sources

- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing)
- [Amazon DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing)
- [Open Food Facts API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api)
- [Open Food Facts conditions of use](https://forum.openfoodfacts.org/t/conditions-to-use-the-open-food-facts-api/443)

These were read as search summaries on 24 November 2026, not opened in full.
