---
name: status
description: Report project progress from backlog/BACKLOG.md - done, in progress, blocked, and what the human needs to do next. Use when asked where the project stands.
---

# Status

Read-only. Change nothing.

1. Read `backlog/BACKLOG.md` and `docs/07-open-questions.md`. Check `git log --oneline -20` and open pull requests if `gh` is available.
2. Reply with:
   - One line per milestone: tasks done out of total.
   - Tasks `in-progress`, `blocked` and `needs-mac-verification`, each with the reason.
   - **Waiting on you:** every open human task and undecided question that is now blocking work, most urgent first.
   - The next task `/next-task` would pick.

Keep it under 20 lines.
