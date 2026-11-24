#!/usr/bin/env bash
# Runs a command with the owner's credentials loaded from an env file that
# lives OUTSIDE this repository, so agents can use access without ever reading
# or printing the secret values.
#
#   scripts/with-env.sh npx cdk deploy 'cupmark-dev-*'
#
# The file is looked up in this order:
#   1. $CUPMARK_ENV_FILE
#   2. ../derschweigert/.env   (sibling folder of this repo)
#   3. ../DerSchweigert/.env
#
# Expected keys (any that are present are exported):
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_PROFILE
#   FAL_KEY
#
# The region is always forced to eu-central-1 (CLAUDE.md, invariant 6).
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-env.sh <command> [args...]" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
parent="$(dirname "$root")"

env_file="${CUPMARK_ENV_FILE:-}"
if [ -z "$env_file" ]; then
  for candidate in "$parent/derschweigert/.env" "$parent/DerSchweigert/.env"; do
    if [ -f "$candidate" ]; then env_file="$candidate"; break; fi
  done
fi
if [ -z "$env_file" ] || [ ! -f "$env_file" ]; then
  echo "with-env: no env file found. Set CUPMARK_ENV_FILE or create ../derschweigert/.env" >&2
  exit 3
fi

# Guard rails. Defence in depth, not a security boundary.
joined=" $* "
case "$joined" in
  *" destroy "*|*" delete-"*|*" rb "*|*" rm "*|*"prod"*)
    echo "with-env: refused. Destructive and production commands are outside the agents' authority (CLAUDE.md)." >&2
    exit 4
    ;;
esac

# Parse KEY=VALUE lines only; the file is never executed as a script.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
  esac
  line="${line#export }"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
  esac
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  export "$key=$value"
done < "$env_file"

export AWS_REGION="eu-central-1"
export AWS_DEFAULT_REGION="eu-central-1"

exec "$@"
