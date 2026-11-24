# Open questions

The master agent decides these. It builds to the default below unless it finds a reason to choose otherwise, and records each choice as an ADR in `docs/decisions/`. The owner can overturn any ADR afterwards.

| Id | Question | Default |
| --- | --- | --- |
| D1 | Opt-out or opt-in for contributing to aggregates? Opt-in is safer under GDPR but shrinks the data set. | Opt-in, asked once at onboarding |
| D2 | What happens to a deleted user's contribution to aggregates? | Subtract it, then delete |
| D3 | Who curates the catalogue? | The operator, through a CLI script |
| D4 | Price points | 2.99 EUR a month, 19.99 EUR a year |
| D5 | How does Open Food Facts share-alike apply to the bean catalogue? | Tag source per field, keep the catalogue separate from ratings; flag for a lawyer before launch |
| D6 | Keep the give-to-get teaser for free users? | Yes |
| D7 | Content of version 1 of the flavour vocabulary and the starter roaster and grinder lists | Master approves the contract-keeper's proposal |

## What the owner still does

Only access, listed in `ACCESS.md`, plus three things no agent may do:

- Deploy a production stage.
- Publish the privacy policy and terms and submit to the App Store.
- Get the legal check for D5.

## Order of work

1. Iteration 1: the app on the phone, local-first (`docs/08-iteration-1.md`).
2. The owner tests with `docs/test-script-iteration-1.md`; findings become tasks.
3. Iteration 2: backend, sign-in and sync.
4. Iteration 3: aggregation and the paid tier.
5. Iteration 4: hardening and launch.
