# Open questions and human tasks

## Decisions only the owner can make

Agents must not decide these. Until one is answered, agents build to the stated default and mark the code path with the decision id.

| Id | Question | Default the agents build to |
| --- | --- | --- |
| D1 | Opt-out or opt-in for contributing to aggregates? Opt-in is safer under GDPR but shrinks the data set. | Opt-in, asked once at onboarding |
| D2 | What happens to a deleted user's contribution to aggregates? | Subtract it, then delete |
| D3 | Who curates the catalogue? | The operator, through a CLI script |
| D4 | Price points | 2.99 EUR a month, 19.99 EUR a year |
| D5 | How does Open Food Facts share-alike apply to the bean catalogue? | Tag source per field, keep catalogue separate from ratings; lawyer to confirm |
| D6 | Keep the give-to-get teaser for free users? | Yes |
| D7 | F1 step 3 stores an Open Food Facts hit as a catalogue entry (name, brand), and docs/05 caches results in the catalogue, but the API accepts no free text. May Open Food Facts name and brand be stored and returned once fetched by the server or verified by the operator, or does F1 step 3 need a roaster pick list instead? | **Answered 2026-11-25 (ADR 0005):** store and show what Open Food Facts has; the backend fetches it, and the app has no free-text input. Until M1-T8 lands, the contract still carries no Open Food Facts text. |
| D8 | docs/04 F1 and the docs/05 data model need roaster, origin and variety lists (with a curated roaster list), but vocabulary v1 has none of them, so F1 cannot describe a bean fully. When does a vocabulary v2 with these lists come, and who curates the roaster list? | **Answered 2026-11-25 (ADR 0006):** origin and variety lists go into vocabulary v2; roaster comes from the Open Food Facts brand and is curated by the operator. Until M1-T8 lands, these fields stay out of the API. |
| D9 | Should the health route (M0-T3, smoke test in M1-T7) be reachable without a token? | **Answered 2026-11-25 (ADR 0007):** `GET /health` needs no token and returns only `{"status":"ok"}`. It is added to the contract in M1-T8 as the single documented lint exception. |

Record each answer as an ADR in `docs/decisions/`.

## Things only a human can do

- [ ] Enrol in the Apple Developer Program and the Small Business Program.
- [ ] Create the App ID, the Sign in with Apple service and key, and the subscription products in App Store Connect.
- [ ] In the shared AWS account (ADR 0009): confirm MFA on root, run `scripts/aws/apply-guardrails.sh --apply`, check whether a GitHub OIDC provider already exists, then deploy `cupmark-github-oidc` once by hand.
- [ ] Add repository secrets: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and the AWS role ARN.
- [ ] Approve every production deployment.
- [x] Review and approve version 1 of the flavour vocabulary before it ships (it is expensive to change later). Approved by the owner on 2026-11-25.
- [ ] Write and publish the privacy policy and terms.

## Suggested order of work

1. Interview five people per persona; test the 30-second flow with a paper prototype.
2. Fix version 1 of the criteria and the flavour vocabulary.
3. Build the free tier end to end: scan, shelf, brew, rate, sync.
4. Ship to TestFlight; measure scan coverage and time per log.
5. Add aggregation and the paid tier once the first beans pass the 5-rater threshold.
