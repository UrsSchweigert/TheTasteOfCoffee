#!/usr/bin/env bash
# Smoke test after a deploy (M1-T7): GET /health of a stage's API must answer 200 with
# the contract's HealthStatus, exactly {"status":"ok"} (ADR 0007). Read-only.
#
#   scripts/smoke/health.sh dev|prod
#
# The API URL is the stack output ApiUrl of cupmark-<stage>-core (infra/src/api.ts,
# API_URL_OUTPUT), read with `aws cloudformation describe-stacks`. CupmarkGitHubDeploy may
# only assume the cdk-cupmark-* roles, so when the caller is that role, the read runs as
# the bootstrap's read-only lookup role (cdk-cupmark-lookup-role-<account>-eu-central-1).
# Any other caller (the owner) reads with its own credentials.
#
# Retries with backoff (SMOKE_ATTEMPTS, default 5; SMOKE_DELAY_S, default 3, doubled after
# each attempt), because a new API or function can take a moment to answer.
set -euo pipefail

REGION="eu-central-1"
OUTPUT_KEY="ApiUrl"
export AWS_PAGER=""

usage() {
  echo "Usage: $0 dev|prod" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage
STAGE="$1"
case "$STAGE" in
  dev | prod) ;;
  *) usage ;;
esac
STACK="cupmark-$STAGE-core"
ATTEMPTS="${SMOKE_ATTEMPTS:-5}"
DELAY="${SMOKE_DELAY_S:-3}"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]?$ && "$DELAY" =~ ^[0-9]{1,3}$ ]] || usage

in_actions() { [[ "${GITHUB_ACTIONS:-}" == "true" ]]; }

identity="$(aws sts get-caller-identity --region "$REGION" --query '[Account,Arn]' --output text)"
read -r ACCOUNT ARN <<<"$identity"
if [[ ! "$ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  echo "Could not read the account id from the caller identity." >&2
  exit 1
fi
if in_actions; then echo "::add-mask::$ACCOUNT"; fi

if [[ "$ARN" == "arn:aws:sts::$ACCOUNT:assumed-role/CupmarkGitHubDeploy/"* ]]; then
  creds="$(aws sts assume-role --region "$REGION" \
    --role-arn "arn:aws:iam::$ACCOUNT:role/cdk-cupmark-lookup-role-$ACCOUNT-$REGION" \
    --role-session-name "cupmark-smoke-$STAGE" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  read -r key secret token <<<"$creds"
  if in_actions; then
    echo "::add-mask::$secret"
    echo "::add-mask::$token"
  fi
  export AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token"
fi

URL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$OUTPUT_KEY'].OutputValue | [0]" --output text)"
if [[ ! "$URL" =~ ^https://[a-z0-9]{10}\.execute-api\.eu-central-1\.amazonaws\.com$ ]]; then
  echo "The output $OUTPUT_KEY of $STACK is not an HTTP API URL in $REGION: '$URL'." >&2
  exit 1
fi
echo "API of $STACK: $URL"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

attempt=1
while :; do
  : >"$tmp/body"
  : >"$tmp/headers"
  : >"$tmp/error"
  status="$(curl -sS --max-time 10 -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' "$URL/health" 2>"$tmp/error" || true)"
  content_type="$(tr -d '\r' <"$tmp/headers" | awk -F': *' 'tolower($1) == "content-type" { print tolower($2) }' | tail -n 1 || true)"
  body="$(jq -c . "$tmp/body" 2>/dev/null || true)"
  if [[ "$status" == "200" && "$content_type" == application/json* && "$body" == '{"status":"ok"}' ]]; then
    echo "GET /health: 200 {\"status\":\"ok\"} (attempt $attempt)"
    exit 0
  fi
  error="$(head -c 200 "$tmp/error" | tr -d '\n')"
  echo "GET /health, attempt $attempt of $ATTEMPTS: status ${status:-none}, content type ${content_type:-none}${error:+, $error}"
  if ((attempt >= ATTEMPTS)); then
    echo "The health check failed after $ATTEMPTS attempts." >&2
    exit 1
  fi
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
  attempt=$((attempt + 1))
done
