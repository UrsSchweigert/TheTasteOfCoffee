# 0019 Deploys run after CI through workflow_run; the operator mailbox comes from context in an explicit deploy mode

- Status: accepted
- Date: 2026-11-25
- Decided by: lead (ADR 0014), task M1-T7; no cloud cost

## Context

M1-T7 builds the deploy pipeline: dev on every push to `main` after CI passed, prod only by hand with the owner's approval, both through `CupmarkGitHubDeploy` (ADR 0018). Three things had to be decided.

- **How the deploy waits for CI.** Either a `workflow_run` on the CI workflow, or a reusable CI called with `needs` from the deploy workflow.
- **How `OFF_CONTACT` reaches the API function.** The operator mailbox for the Open Food Facts User-Agent is not secret as such, but docs/05 keeps it out of the repository. The API reads it from its environment and answers 503 for uncached lookups without it. CI synthesises without it, offline and without credentials.
- **How a stage stack is named on the command line.** The task asked for `cdk deploy cupmark-<stage>-core`. The CDK CLI (2.1149.0) selects a stack inside a `Stage` by its hierarchical id, `dev/core`, not by its stack name: `cdk ls cupmark-dev-core` matches nothing.

## Decision

1. **`workflow_run` on CI**, in `.github/workflows/deploy.yml`, with `branches: [main]`. A `gate` job, which has no AWS step, no checkout and only read scopes, deploys only when all of these hold:
   - the CI run concluded `success`;
   - its event was `push`, its branch `main`, its repository this one, and its file `.github/workflows/ci.yml`;
   - its `head_sha` is still the tip of `main`. Otherwise the run is skipped as superseded, because the newer commit deploys after its own CI.

   A fork's pull request runs CI with the event `pull_request`, even if its branch is called `main`, so it never deploys; the gate decides `deploy=false` quietly for any CI run that is not a push. "Re-run failed jobs" would reuse the gate's old outputs, so each deploy job first checks the switch again and, for `workflow_run`, the tip of `main`, before checkout and credentials; the owner uses "Re-run all jobs". The deploy job checks out exactly that `head_sha`.
2. **Prod and rollbacks by `workflow_dispatch` from `main`.** The inputs are the stage (`dev` or `prod`) and an optional commit. The gate accepts a full SHA only, and only if it is `main` or an ancestor of it (the compare API) and CI succeeded for a push of it. Prod runs in the environment `prod`, whose required reviewer is the owner. Each stage has its own job with the literal environment, `id-token: write` and `contents: read` only, and a concurrency group that never cancels a running deploy.
3. **The logic is in tested scripts.** `scripts/deploy/deploy-stage.sh` takes the account from the assumed identity, never from the repo, and checks that the identity is `CupmarkGitHubDeploy`. It masks the account id (`::add-mask::`) before any CDK output, runs `cdk diff`, then `cdk deploy <stage>/core --exclusively`, never `--all`, with `--toolkit-stack-name CDKToolkit-cupmark`. `scripts/smoke/health.sh` reads the stack output `ApiUrl` (logical id now pinned) as the bootstrap's read-only lookup role, because the GitHub role may only assume bootstrap roles. It then expects `GET /health` to answer 200 `{"status":"ok"}`, with retries and backoff.
4. **The mailbox comes from context, `-c cupmark:offContact=<address>`**, which the deploy script passes from the GitHub *environment secret* `OFF_CONTACT`. It is a secret only for masking: GitHub prints a step's `env:` values in clear in the public log header, before any `::add-mask::` could run, while secrets are masked everywhere, including the `cdk diff` of the function environment (M1-T7 review). `OFF_LOOKUP_CAP` is optional, as `-c cupmark:offLookupCap=<n>` from the environment variable of the same name; it is not personal. Infra validates both with the backend's own rules, never echoes the mailbox in an error, and sets them on the API function only.
5. **An explicit deploy mode, not a placeholder.** `-c cupmark:deploy=<stage>` is set only by the deploy script. In deploy mode the synth fails unless all of these are given:
   - `-c stage=` with the same stage;
   - `cupmark:<stage>:account` in context;
   - a valid contact.

   Without deploy mode, a synth is "not for deploy". The contact may be missing; the function then has no `OFF_CONTACT`, and the synth prints the warning `cupmark:offContactMissing`. CI, the tests and the owner's import synth stay as they are.
6. **An off switch, default off.** The gate deploys nothing unless the repository variable `CUPMARK_DEPLOY_ENABLED` is exactly `true`. It is read from `vars` only, never from an input, and checked before anything else. Otherwise the gate ends successfully with a notice that deploys are off and how to turn them on. The owner sets it as the last prerequisite. So merging is safe whatever state the GitHub settings are in, even with `AWS_DEPLOY_ROLE_ARN` already set. A required reviewer on `dev` for the first deploy stays as a second safeguard.
7. **No npm cache in deploy jobs.** Installs and the backend build run before any AWS credentials exist in the job.

## Alternatives

- **Reusable CI with `needs`:** rejected. Every push to `main` would run CI twice, including the macOS job. `ci.yml` would gain a `workflow_call` path, and the deploy would share a workflow run with the checks of untrusted code.
- **A placeholder contact for CI** (for example `ops@example.invalid` in cdk.json): rejected. A placeholder that synthesises can also be deployed: the API would then send a fake contact to Open Food Facts instead of failing closed.
- **Making the contact required whenever an account is known:** rejected. `CDK_DEFAULT_ACCOUNT` is set whenever credentials are present, so the owner's CloudShell synth for the role import would fail. It is also implicit, and a reviewer cannot see it in the command.
- **Secrets Manager or a SecureString for the mailbox:** Secrets Manager has a fee (invariant 5), and the value is not secret.
- **`cdk deploy --outputs-file` for the smoke URL:** possible, but the task asked for `describe-stacks`. The lookup role keeps that read-only.

## Consequences

- The owner sets the environment secret `OFF_CONTACT` in `dev` and `prod` (and optionally the variable `OFF_LOOKUP_CAP`). A missing one fails the deploy before CloudFormation is called.
- A stage stack deployed by hand without the deploy script has no `OFF_CONTACT`. That fails closed (503), and the synth warns about it. Deploys go through the workflow only.
- Nothing deploys until the owner sets `CUPMARK_DEPLOY_ENABLED` to `true`, after #45, #46 and #48. For the first deploy the owner is also a required reviewer of `dev` (infra/README.md, Deploy pipeline). Unsetting the variable stops every deploy at once.
- A rollback redeploys an earlier commit's code and template. It does not undo data changes, and it cannot go back before M1-T7, because older code ignores deploy mode.
- dev and prod are still not separated in IAM (ADR 0018). The workflow keeps prod behind the `prod` environment, and `scripts/check-workflows.mjs` fails a job whose deploy or smoke command names another stage than its environment.
- Revisit when a bootstrap per stage or a separate prod account exists.

## Addendum (2026-11-26): an automatic dev deploy only when something deployable changed

Decided by: lead (ADR 0014), at the owner's request; no cloud cost (it saves approvals and Actions minutes).

Every merge to `main` that passed CI started a dev deploy that waited for the owner's approval, though most merges change only the iOS app or the docs. When another merge arrived meanwhile, the waiting deploy failed on purpose as superseded. Now, for the `workflow_run` event only, the `gate` job has one more step, `changes`, after all existing checks (CI succeeded, push to `main`, tip of `main`):

- **The rule.** The deploy runs only if a file changed under `backend/`, `infra/`, `contracts/`, `scripts/deploy/`, `.nvmrc` or `.github/workflows/deploy.yml` (a rename counts through its old path too). `ios/`, `docs/`, `backlog/`, `scripts/aws/`, `scripts/smoke/`, other scripts, `.claude/` and other workflows do not count. Otherwise the gate ends with the notice "nothing deployable changed since the last deployed commit", `deploy=false`, no deploy job and no approval request.
- **BASE is the last deployed commit, not the parent.** The gate lists recent successful runs of `deploy.yml` started by `workflow_run` on `main` (at most two pages of 50, at most 40 candidates) and takes the newest one whose job `deploy dev` has conclusion `success`. A run whose gate said `deploy=false` also ends successfully, but its `deploy dev` job is `skipped`, so it is passed over, as are failed and cancelled ones. So an infrastructure change that was superseded or never approved is compared again by the next merge and is not dropped by a later docs-only commit. The run's `head_sha` is taken as the deployed commit: a deploy only runs when the CI commit is the tip of `main`, so both are the same. Manual runs are not BASE, because a rollback's `head_sha` is not what it deployed.
- **Fail open.** If no earlier deploy is found, an API call fails, the compare is not `ahead` or `identical` (diverged, behind), or lists 300 files or more (the compare API truncates there), the gate deploys. A wrong answer may cost one approval, never a skipped infrastructure change.
- **Manual runs always deploy.** `workflow_dispatch` (a redeploy, a rollback, prod) is not affected by the rule. The owner can start any deploy by hand.
- **Same safety as before.** The step is read-only with the `actions: read` and `contents: read` the gate already had, no checkout, no secrets, no AWS. API values are validated (SHAs, numeric ids) and passed through variables only. The off switch, the tip-of-main check, the deploy job's re-check and the environments are unchanged.
- **The script lives in the workflow.** The gate has no checkout, so a script under `scripts/deploy/` is not available to it. The step is inline, and `scripts/deploy-gate.test.mjs` extracts it from the workflow and runs it against canned API answers (run in CI with the other workflow checks).
- **First run after this change.** Earlier deploys ran with the old gate, and their `deploy dev` jobs count. If none succeeded, the first merge deploys.
