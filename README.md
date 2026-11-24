# Cupmark

Know how a bean tastes and how to brew it before you open the bag.

A native iOS app where coffee drinkers scan a bag, tap through how they brewed it, and score the cup on eight fixed criteria. Every input is a scan, a pick, a slider, a stepper or a timer. There is no text field anywhere in the app.

- **Free tier:** unlimited personal catalogue, brew log and own statistics.
- **Paid tier (subscription):** aggregated community data per bean: score profile, best brew method, most successful recipes, rankings.
- **Platform:** serverless on AWS in Frankfurt: Cognito, API Gateway HTTP API, Lambda, DynamoDB, S3.
- **Running cost:** roughly 1 to 5 USD a month up to 10,000 monthly active users.

"Cupmark" is a working name.

## Status

This repository holds the product documents and the agent team that builds the app. No product code exists yet.

Current goal: **iteration 1**, the app installed on your iPhone with the core loop working offline ([details](docs/08-iteration-1.md)). Where things stand is always in [backlog/STATE.md](backlog/STATE.md).

## Documents

| Document | What it answers |
| --- | --- |
| [Personas](docs/01-personas.md) | Who has a stake and what they want |
| [USP iterations](docs/02-usp.md) | Why anyone would use or pay for this |
| [Project brief](docs/03-project-brief.md) | Goals, scope, tiers, metrics, risks |
| [Specification](docs/04-specification.md) | The four flows and the no-free-text input model |
| [System design](docs/05-system-design.md) | AWS architecture, data model, security, recovery |
| [Cost estimate](docs/06-cost-estimate.md) | Monthly cost at three usage levels |
| [Open questions](docs/07-open-questions.md) | Questions the master agent decides, with defaults |
| [Iteration 1](docs/08-iteration-1.md) | Scope and exit criteria for the first build on a phone |
| [Decisions](docs/decisions/README.md) | ADRs |

## The agent team

The team runs on [Claude Code](https://code.claude.com/docs). A master agent runs the project: it decides, delegates to specialists, has every change reviewed independently, merges, and moves on. It asks you for one thing only: access.

| Agent | Role |
| --- | --- |
| `master` | Owns the goal. Decides, delegates, merges, records decisions, files access requests |
| `planner` | Breaks a milestone into small, testable tasks |
| `contract-keeper` | Owns the closed vocabulary and the API definition |
| `ios-engineer` | SwiftUI app, local store, scanner, later sync and StoreKit |
| `backend-engineer` | Lambda code, DynamoDB access, aggregation, App Store verification |
| `infra-engineer` | AWS CDK stack, CI, deploy pipeline |
| `reviewer` | Independent review against the task, the invariants, security and cost |

### Start it

On your machine, in this folder:

```
claude --agent master --permission-mode acceptEdits     # watch and steer
scripts/run-master.sh                                    # one unattended session
SESSIONS=4 MAX_TURNS=300 scripts/run-master.sh           # several sessions back to back
```

Each session picks up from `backlog/STATE.md`, does up to three tasks, checkpoints after each, and stops. Run it again to continue.

Inside a session you can also use `/status`, `/next-task` (or `/next-task I1-T3`) and `/plan-milestone M0`.

### Your part

- Tick off the items in [ACCESS.md](ACCESS.md). That file is the only place the agents ask you for anything.
- Your AWS and fal.ai credentials stay in `../derschweigert/.env`. Agents use them through `scripts/with-env.sh` and never open the file. If the file is elsewhere, set `CUPMARK_ENV_FILE`.
- Read `docs/decisions/` when you want to see what the master decided. Overturn anything by telling it.

### Session budgets

- Every subagent has a turn limit.
- The master runs under `--max-turns` and, optionally, `--max-budget-usd` (`BUDGET_USD=8 scripts/run-master.sh`).
- Signed in with a Claude subscription, runs draw on its usage allowance; an API key is billed per token.

### What no agent may do

- Change the invariants in [CLAUDE.md](CLAUDE.md), including "no free text" and "no fixed monthly fees".
- Deploy a production stage, or touch AWS resources this project did not create.
- Read or print your credentials.
- Delete data or force-push.
