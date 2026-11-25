---
name: next-task
description: Implement the next unblocked task from backlog/BACKLOG.md end to end - delegate to the owner agent, get an independent review, open a pull request. Use when asked to continue building, to pick up the next task, or to implement a specific task id.
---

# Next task

You are the lead. You coordinate; the specialist agents do the work. Argument: an optional task id (for example `M1-T3`). Without one, pick the task yourself.

## 1. Pick

- Read `CLAUDE.md` and `backlog/BACKLOG.md`.
- If a task id was given, use it. Otherwise take the first task with `status: todo` whose `depends` are all `done`.
- If the task has `needs: human`, do not start it. Set it to `blocked`, say what the human must do, and pick the next one.
- If a milestone has no tasks yet, run the `planner` agent on it first, commit the backlog change, then pick.
- If nothing is unblocked, stop and report what is blocking.

## 2. Prepare

- `git switch main && git pull` (skip the pull if there is no remote), then `git switch -c task/<id>-<short-slug>`.
- Set the task to `in-progress` in the backlog.

## 3. Build

- If the task changes an API route, a field or a list, run `contract-keeper` first.
- Run the owner agent named in the task. Give it: the task block verbatim, the doc sections it cites, and what earlier tasks already built that it depends on.
- When it returns, run the tests yourself. Do not accept "tests pass" without seeing it.

## 4. Review

- Run the `reviewer` agent on the branch.
- If the verdict is `changes-required`, send the blocking findings back to the owner agent, then review again. At most three rounds; after that, set the task to `blocked` and report why.

## 5. Finish

- Set the task status: `done`, or `needs-mac-verification` for iOS work that could not be built here.
- Commit with a message that says what changed and why. Push the branch and open a pull request whose body lists: the task id, the acceptance criteria with how each was verified, the reviewer verdict, and anything a human must do.
- Merge the pull request yourself (squash) when the work needs it to progress, as the owner decided on 2026-11-25. Merge only when all of these hold:
  - `reviewer` approved with no open blocking findings;
  - every CI check on the head commit is green;
  - there is no merge conflict;
  - nothing is left that a human must do first.
  Otherwise leave it open and say what is missing. Never merge a pull request that needs a human decision, spends money or touches a real account (for example a deploy). Never push to `main` directly.

## 6. Report

Reply with three lines: what was built, the pull request link, and the next task in the queue (or what is blocking it).

## 7. Continue

If the pull request was merged and the next task in the queue is unblocked, start it right away at step 1 without waiting to be asked (the owner decided this on 2026-11-25). Stop only when one of these holds:

- the next task is blocked or needs a human;
- a pull request cannot be merged under the rules in step 5;
- the owner says stop.

When you stop, report what is blocking.
