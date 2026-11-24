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

Record each answer as an ADR in `docs/decisions/`.

## Things only a human can do

- [ ] Enrol in the Apple Developer Program and the Small Business Program.
- [ ] Create the App ID, the Sign in with Apple service and key, and the subscription products in App Store Connect.
- [ ] Create the AWS accounts (dev, prod), enable MFA on root, set up the GitHub OIDC deploy role.
- [ ] Add repository secrets: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and the AWS role ARN.
- [ ] Approve every production deployment.
- [ ] Review and approve version 1 of the flavour vocabulary before it ships (it is expensive to change later).
- [ ] Write and publish the privacy policy and terms.

## Suggested order of work

1. Interview five people per persona; test the 30-second flow with a paper prototype.
2. Fix version 1 of the criteria and the flavour vocabulary.
3. Build the free tier end to end: scan, shelf, brew, rate, sync.
4. Ship to TestFlight; measure scan coverage and time per log.
5. Add aggregation and the paid tier once the first beans pass the 5-rater threshold.
