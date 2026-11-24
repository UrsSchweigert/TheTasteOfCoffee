# Cupmark

Know how a bean tastes and how to brew it before you open the bag.

A native iOS app where coffee drinkers scan a bag, tap through how they brewed it, and score the cup on eight fixed criteria. Every input is a scan, a pick, a slider, a stepper or a timer. There is no text field anywhere in the app.

- **Free tier:** unlimited personal catalogue, brew log and own statistics.
- **Paid tier (subscription):** aggregated community data per bean: score profile, best brew method, most successful recipes, rankings.
- **Platform:** serverless on AWS in Frankfurt: Cognito, API Gateway HTTP API, Lambda, DynamoDB, S3.
- **Running cost:** roughly 1 to 5 USD a month up to 10,000 monthly active users.

"Cupmark" is a working name.

## Status

This repository holds the product documents and the agent team that will build the app. No product code exists yet. The first task is `M0-T1` in `backlog/BACKLOG.md`.

## Documents

| Document | What it answers |
| --- | --- |
| [Personas](docs/01-personas.md) | Who has a stake and what they want |
| [USP iterations](docs/02-usp.md) | Why anyone would use or pay for this |
| [Project brief](docs/03-project-brief.md) | Goals, scope, tiers, metrics, risks |
| [Specification](docs/04-specification.md) | The four flows and the no-free-text input model |
| [System design](docs/05-system-design.md) | AWS architecture, data model, security, recovery |
| [Cost estimate](docs/06-cost-estimate.md) | Monthly cost at three usage levels |
| [Open questions](docs/07-open-questions.md) | Decisions and tasks only the owner can do |
| [Decisions](docs/decisions/README.md) | ADRs |

## The agent team

The team runs on [Claude Code](https://code.claude.com/docs). The lead session coordinates; specialist subagents do the work; a separate reviewer checks it.

| Agent | Role |
| --- | --- |
| `planner` | Breaks a milestone into small, testable tasks |
| `contract-keeper` | Owns the closed vocabulary and the API definition |
| `backend-engineer` | Lambda code, DynamoDB access, aggregation, App Store verification |
| `infra-engineer` | AWS CDK stack, CI, deploy pipeline |
| `ios-engineer` | SwiftUI app, offline store, scanner, StoreKit |
| `reviewer` | Independent review against the task, the invariants, security and cost |

| Command | What it does |
| --- | --- |
| `/next-task` | Implements the next unblocked task end to end and opens a pull request |
| `/next-task M1-T3` | Implements that task |
| `/plan-milestone M2` | Breaks a milestone into tasks |
| `/status` | Shows progress and what is waiting on you |

The rules every agent follows are in [CLAUDE.md](CLAUDE.md). The work queue is [backlog/BACKLOG.md](backlog/BACKLOG.md).

### Run it

Locally (needed for iOS work, which only builds on a Mac):

```
git clone <this repo> && cd cupmark
claude
> /status
> /next-task
```

From GitHub: install the Claude GitHub App on this repository, add the `ANTHROPIC_API_KEY` secret (or `CLAUDE_CODE_OAUTH_TOKEN`, see `.github/workflows/claude.yml`), then comment `@claude /next-task` on an issue.

### What the agents will not do

- Deploy to AWS, touch App Store Connect, or handle credentials. Deployments run through a workflow you approve.
- Merge their own pull requests or push to `main`.
- Decide the open questions in `docs/07-open-questions.md`.
- Mark iOS work as done without a build on macOS.

### Before the first run

Work through the human tasks in [docs/07-open-questions.md](docs/07-open-questions.md). Tasks M0-T1 to M0-T6 can start without them.
