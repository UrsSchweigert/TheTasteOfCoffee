#!/usr/bin/env bash
# Runs one bounded, unattended session of the master agent.
#
#   scripts/run-master.sh                 # one session, default budget
#   MAX_TURNS=300 scripts/run-master.sh   # larger turn budget
#   BUDGET_USD=8 scripts/run-master.sh    # also cap estimated spend
#   SESSIONS=4 scripts/run-master.sh      # up to four sessions back to back
#
# Each session picks up from backlog/STATE.md, so running it again continues
# the work. It stops early when nothing can move without access (ACCESS.md).
#
# For an interactive session where you can watch and steer, run instead:
#   claude --agent master --permission-mode acceptEdits
set -euo pipefail

cd "$(dirname "$0")/.."

MAX_TURNS="${MAX_TURNS:-200}"
BUDGET_USD="${BUDGET_USD:-}"
SESSIONS="${SESSIONS:-1}"

args=(-p --agent master --permission-mode acceptEdits --max-turns "$MAX_TURNS")
if [ -n "$BUDGET_USD" ]; then
  args+=(--max-budget-usd "$BUDGET_USD")
fi

prompt="Continue toward the current iteration goal. Follow your session protocol. \
Your budget for this session is ${MAX_TURNS} turns${BUDGET_USD:+ and about ${BUDGET_USD} USD}. \
If nothing can move without access, say BLOCKED-ON-ACCESS on the last line."

for i in $(seq 1 "$SESSIONS"); do
  echo "== master session $i of $SESSIONS =="
  out="$(claude "${args[@]}" "$prompt" | tee /dev/stderr)" || {
    echo "== session $i ended with an error (often the turn or spend cap). State is in backlog/STATE.md =="
  }
  if printf '%s' "$out" | tail -n 3 | grep -q "BLOCKED-ON-ACCESS"; then
    echo "== stopped: waiting on access. See ACCESS.md =="
    break
  fi
done
