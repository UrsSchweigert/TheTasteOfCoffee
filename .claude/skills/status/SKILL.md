---
name: status
description: Report project progress from backlog/BACKLOG.md - done, in progress, blocked, and what the human needs to do next. Use when asked where the project stands.
---

# Status

Read-only. Change nothing.

1. Read `backlog/STATE.md`, `backlog/BACKLOG.md` and `ACCESS.md`. Check `git log --oneline -20` and open pull requests if `gh` is available.
2. Reply with:
   - One line per milestone: tasks done out of total.
   - Tasks `in-progress`, `blocked` and `needs-mac-verification`, each with the reason.
   - **Waiting on you:** every unticked `ACCESS.md` item that is now blocking work, most urgent first.
   - Decisions the master made since the last report (ADR number and one line).
   - The next task `/next-task` would pick.

Keep it under 20 lines.
