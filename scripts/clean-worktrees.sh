#!/usr/bin/env bash
# Remove finished agent worktrees under .claude/worktrees/. Run by hand, and by the
# SessionStart hook in .claude/settings.json (with --apply --quiet).
#
#   scripts/clean-worktrees.sh                 # dry run: says what it would remove
#   scripts/clean-worktrees.sh --apply         # removes
#   scripts/clean-worktrees.sh --min-age 0     # do not wait for a quiet period
#
# A worktree is removed only when nothing can be lost and no agent is likely still in it:
#   1. it lives under <repo>/.claude/worktrees/ (the main checkout and any other path are
#      never touched);
#   2. `git status` is clean (no changes, no untracked files that are not ignored);
#   3. its HEAD commit is on a branch of origin (it was pushed);
#   4. no file in it (node_modules and .git aside) changed in the last --min-age minutes
#      (default 30, or CLEAN_WORKTREES_MIN_AGE_MIN), so a running agent is left alone.
# Local branches named worktree-agent-* whose tip is on an origin branch are deleted too.
# Nothing else is deleted, nothing is pushed, and a worktree that fails a check is kept and
# the reason is printed.
set -euo pipefail

APPLY=0
QUIET=0
MIN_AGE="${CLEAN_WORKTREES_MIN_AGE_MIN:-30}"

usage() {
  echo "Usage: $0 [--apply] [--quiet] [--min-age MINUTES]   (without --apply: dry run)" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --min-age)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || usage
      MIN_AGE="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$MIN_AGE" =~ ^[0-9]+$ ]] || usage

say() { if [[ $QUIET -eq 0 ]]; then echo "$@"; fi; }

# The main checkout, even when this runs from inside a worktree.
COMMON="$(git rev-parse --git-common-dir 2>/dev/null)" || { echo "not in a git repository" >&2; exit 1; }
ROOT="$(cd "$COMMON/.." && pwd -P)"
BASE="$ROOT/.claude/worktrees"
[[ -d "$BASE" ]] || exit 0
BASE="$(cd "$BASE" && pwd -P)"

# Fresh remote refs make "was it pushed" accurate. Offline is fine: the refs we have are used.
git -C "$ROOT" fetch --quiet origin 2>/dev/null || say "note: could not fetch origin; using the remote refs already here"

removed=0
kept=0
paths=()
while IFS= read -r line; do
  case "$line" in
    "worktree "*) paths+=("${line#worktree }") ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain)

for p in ${paths[@]+"${paths[@]}"}; do
  [[ -d "$p" ]] || continue
  real="$(cd "$p" && pwd -P)"
  case "$real" in
    "$BASE"/*) ;;
    *) continue ;;
  esac
  name="${real#"$BASE"/}"

  if [[ -n "$(git -C "$real" status --porcelain 2>/dev/null)" ]]; then
    say "keep   $name: uncommitted or untracked changes"
    kept=$((kept + 1)); continue
  fi
  head="$(git -C "$real" rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$head" ]]; then
    say "keep   $name: cannot read HEAD"
    kept=$((kept + 1)); continue
  fi
  if [[ -z "$(git -C "$ROOT" branch -r --contains "$head" 2>/dev/null)" ]]; then
    say "keep   $name: HEAD ${head:0:7} is not on any origin branch (not pushed)"
    kept=$((kept + 1)); continue
  fi
  if [[ "$MIN_AGE" -gt 0 ]]; then
    recent="$(find "$real" \( -name .git -o -name node_modules \) -prune -o -type f -mmin "-$MIN_AGE" -print -quit 2>/dev/null || true)"
    if [[ -n "$recent" ]]; then
      say "keep   $name: changed in the last $MIN_AGE minutes (an agent may still be working)"
      kept=$((kept + 1)); continue
    fi
  fi

  if [[ $APPLY -eq 1 ]]; then
    git -C "$ROOT" worktree unlock "$real" 2>/dev/null || true
    if git -C "$ROOT" worktree remove --force "$real" 2>/dev/null; then
      say "remove $name"
      removed=$((removed + 1))
    else
      say "keep   $name: git could not remove it"
      kept=$((kept + 1))
    fi
  else
    say "would remove $name"
    removed=$((removed + 1))
  fi
done

if [[ $APPLY -eq 1 ]]; then
  git -C "$ROOT" worktree prune
  # Local branches an agent worktree left behind (worktree-agent-*). A branch whose tip is on an
  # origin branch loses nothing when it is deleted (the work is on the remote).
  git -C "$ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/worktree-agent-*' | while IFS= read -r b; do
    if [[ -n "$(git -C "$ROOT" branch -r --contains "$b" 2>/dev/null)" ]]; then
      if git -C "$ROOT" branch -D "$b" >/dev/null 2>&1; then say "delete branch $b (its commits are on origin)"; fi
    fi
  done
fi

if [[ $APPLY -eq 1 ]]; then
  say "Done: $removed removed, $kept kept."
else
  say "Dry run: $removed would be removed, $kept kept. Run with --apply to remove."
fi
