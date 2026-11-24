---
name: next-task
description: Implement the next unblocked task from backlog/BACKLOG.md end to end - delegate to the owner agent, get an independent review, open and merge a pull request, checkpoint. Use when asked to continue building, to pick up the next task, or to implement a specific task id.
---

# Next task

You coordinate; the specialist agents do the work. Argument: an optional task id (for example `I1-T3`). Without one, pick the task yourself.

## 1. Pick

- Read `backlog/STATE.md`, then the relevant part of `backlog/BACKLOG.md`.
- If a task id was given, use it. Otherwise take the first task with `status: todo` whose `depends` are all `done`.
- If the task has `needs: access` and that access has not arrived, make sure the request is in `ACCESS.md`, do the part of the task that does not need it if there is one, and pick the next task.
- If a milestone has no tasks yet, run the `planner` agent on it first.
- If nothing can move without access, stop and report exactly which `ACCESS.md` items are blocking.

## 2. Prepare

- `git switch main && git pull`, then `git switch -c task/<id>-<short-slug>`.
- Set the task to `in-progress` in the backlog.

## 3. Build

- If the task changes the vocabulary or an API route, run `contract-keeper` first.
- Run the owner agent named in the task. Give it the task block verbatim, the doc sections it cites, and what earlier tasks built that it depends on. Nothing more.
- If the agent raises a choice, decide it yourself, write the ADR, and tell the agent. Do not pass the question to the owner.
- If the agent returns partial work (turn limit), resume it once. If still unfinished, split the task in the backlog and finish the first part.
- When it returns, run the tests yourself. Do not accept "tests pass" without seeing it.

## 4. Review

- Run the `reviewer` agent on the branch.
- If the verdict is `changes-required`, send the blocking findings back to the owner agent, then review again. At most three rounds; after that, shrink the task or simplify the design, record why, and continue.

## 5. Merge and checkpoint

- Set the task status: `done`, or `needs-mac-verification` for iOS work that could not be built here.
- Commit, push the branch, open a pull request whose body lists the task id, each acceptance criterion with how it was verified, the reviewer verdict, and any decision made.
- When the reviewer has approved and checks pass, squash-merge it: `gh pr merge --squash --delete-branch`. Never merge with a blocking finding or a failing check. Never push to `main` directly and never force-push.
- Rewrite `backlog/STATE.md` and commit it with the merge or straight after.

## 6. Report

Reply with three lines: what was built and merged, any decision made, and the next task in the queue (or which access is blocking it).
