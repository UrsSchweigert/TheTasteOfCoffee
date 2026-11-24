---
name: plan-milestone
description: Break one milestone in backlog/BACKLOG.md into ordered, testable tasks using the planner agent. Use when a milestone has no tasks, or when asked to plan or re-plan a milestone.
---

# Plan milestone

Argument: a milestone id (for example `M2`). Without one, use the first milestone that has no tasks.

1. Read `CLAUDE.md`, `backlog/BACKLOG.md` and `docs/07-open-questions.md`.
2. Run the `planner` agent for that milestone. Pass it the milestone block verbatim and the list of tasks already `done`.
3. Check its output yourself: every task has an owner, dependencies, testable acceptance criteria and a doc reference; contract tasks come before the code that uses them; nothing breaks an invariant; nothing is in scope that the docs do not contain.
4. Commit the backlog change on a branch `plan/<milestone>`, open a pull request and squash-merge it. Planning changes need no `reviewer` pass.
5. Reply with: the number of tasks, the critical path, and every item waiting on access.
