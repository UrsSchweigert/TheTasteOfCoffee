#!/usr/bin/env bash
# Operator tool: the AWS steps before the first deploy, in one script (M1-T7). Run by the
# owner in AWS CloudShell (eu-central-1), from the root of a clean `main` checkout. Never
# by an agent or CI. infra/README.md, "First-deploy setup (one script)".
#
#   ALLOW_ROOT=1 scripts/aws/first-deploy-setup.sh            # dry run: changes nothing
#   ALLOW_ROOT=1 scripts/aws/first-deploy-setup.sh --apply    # does it
#
# Steps, each stopping at the first mismatch:
#   0. preflight: identity, region, Node, clean main checkout, backend build, infra install;
#   1. issue #45: scripts/aws/apply-guardrails.sh (CupmarkBoundary, CupmarkCfnExecution);
#   2. issue #46, trust part: the `sub` condition of CupmarkGitHubDeploy's trust becomes
#      exactly the two environment subjects of the import template (immutable form
#      repo:<owner>@<id>/<repo>@<id>:environment:dev|prod, StringEquals). Only two known
#      old documents are rewritten (plain subjects with StringEquals; immutable subjects
#      with StringLike); any other difference stops and overwrites nothing;
#   3. issue #48: check the role, `cdk import` it into cupmark-github-oidc, drift detection
#      (IN_SYNC), `cdk diff`, `cdk deploy` (the tag), then tags and termination protection;
#   4. a summary to paste into the issues.
#
# It never deletes anything, and it changes only CupmarkBoundary and CupmarkCfnExecution
# (through apply-guardrails.sh, which also re-runs the cupmark bootstrap unchanged), the
# trust of CupmarkGitHubDeploy and the stack cupmark-github-oidc. Running it again is safe:
# each step checks first and skips what is already done. Account ids are masked in every
# line except the assumed identity. Synth output goes to a temporary directory.
set -euo pipefail

REGION="eu-central-1"
ROLE="CupmarkGitHubDeploy"
STACK="cupmark-github-oidc"
TOOLKIT_STACK="CDKToolkit-cupmark"
OIDC_HOST="token.actions.githubusercontent.com"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
POLL_S="${FIRST_DEPLOY_POLL_S:-5}"
export AWS_PAGER=""

APPLY=0
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [--apply]   (without --apply: dry run, changes nothing)" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) echo "Usage: $0 [--apply]   (without --apply: dry run, changes nothing)" >&2; exit 2 ;;
esac

mask() { sed -E 's/[0-9]{12}/<account>/g'; }
step() { printf '\nStep %s: %s\n' "$1" "$2"; }
die() { echo "STOP: $*" >&2; exit 1; }
SUMMARY=()
note() { SUMMARY+=("$1"); echo "  $1"; }
# A change: printed always, run only with --apply.
change() { echo "  + $*" | mask; if [[ $APPLY -eq 1 ]]; then "$@" 2>&1 | mask; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---------------------------------------------------------------------------------------
step 0 "Preflight"
identity="$(aws sts get-caller-identity --output json)"
ACCOUNT="$(jq -r .Account <<<"$identity")"
ARN="$(jq -r .Arn <<<"$identity")"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || die "could not read the account id"
echo "  Assumed identity: $ARN"
if [[ "$ARN" == *":root" ]]; then
  if [[ "${ALLOW_ROOT:-}" != "1" ]]; then
    die "running as the account root user. Use an admin IAM or SSO identity, or set ALLOW_ROOT=1 knowingly."
  fi
  echo "  WARNING: running as root (ALLOW_ROOT=1). Prefer an admin IAM or SSO identity; delete any root access keys afterwards."
fi
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
[[ "$region" == "$REGION" ]] || die "the region is '${region:-unset}', not $REGION. Open CloudShell in Frankfurt (eu-central-1)."
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
echo "  Region: $REGION"

node_version="$(node --version 2>/dev/null || true)"
if [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
  major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
else
  major=0 minor=0
fi
if ! { [[ $major -eq 22 && $minor -ge 18 ]] || [[ $major -ge 24 ]]; }; then
  die "Node ${node_version:-none} is too old; infra needs 22.18 or later. Run: nvm install 22 && nvm use 22, then start again."
fi
echo "  Node: $node_version"

[[ "$(pwd -P)" == "$ROOT" ]] || die "run this from the repository root ($ROOT), as scripts/aws/first-deploy-setup.sh"
[[ "$(git rev-parse --show-toplevel)" == "$ROOT" ]] || die "$ROOT is not the top of a git checkout"
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "the checkout is on '$branch', not main. Run: git checkout main && git pull"
[[ -z "$(git status --porcelain)" ]] || die "the checkout has uncommitted changes (git status). Use a clean clone of main."
echo "  Checkout: main at $(git log -1 --format='%h %s')"

if [[ -f backend/dist/api/index.mjs && -d backend/node_modules ]]; then
  echo "  Backend: already built"
else
  (cd backend && npm ci && npm run build) 2>&1 | mask || die "the backend build failed"
  echo "  Backend: built"
fi
if [[ -d infra/node_modules ]]; then
  echo "  Infra: already installed"
else
  (cd infra && npm ci) 2>&1 | mask || die "npm ci in infra failed"
  echo "  Infra: installed"
fi
note "Preflight: $REGION, Node $node_version, main at $(git log -1 --format=%h)$([[ "$ARN" == *":root" ]] && echo ', as root')"

# ---------------------------------------------------------------------------------------
step 1 "Guardrails (#45): scripts/aws/apply-guardrails.sh"
guard_args=()
[[ $APPLY -eq 1 ]] && guard_args=(--apply)
# ${arr[@]+"${arr[@]}"}: macOS bash 3.2 treats an empty array as unbound under set -u.
"$HERE/apply-guardrails.sh" ${guard_args[@]+"${guard_args[@]}"} 2>&1 | mask || die "apply-guardrails.sh failed; see its output above"
if [[ $APPLY -eq 1 ]]; then note "#45: guardrails applied (CupmarkBoundary, CupmarkCfnExecution)"; else note "#45: guardrails dry run"; fi

# ---------------------------------------------------------------------------------------
step 2 "Trust of $ROLE (#46, the AWS part)"
# The import template is the source of the subjects (infra/src/github-oidc.ts).
(cd infra && npx cdk synth --no-lookups --quiet -c cupmark:githubOidcImport=true --output "$tmp/cdk.out-import") 2>&1 | mask \
  || die "the import template did not synthesise"
IMPORT_TEMPLATE="$tmp/import.template.json"
cp "$tmp/cdk.out-import/$STACK.template.json" "$IMPORT_TEMPLATE"

# Fn::Join of literals and Ref AWS::AccountId only, as check-github-deploy-role.sh renders it.
RENDER='walk(if type == "object" and has("Fn::Join") then
  (.["Fn::Join"] as [$sep, $parts] | $parts
    | map(if type == "string" then . elif (type == "object" and .Ref == "AWS::AccountId") then $acct
          else error("unexpected intrinsic") end)
    | join($sep))
  else . end)'
NORM='walk(if type == "array" and length > 0 and all(.[]; type == "string") then sort else . end)'
SUB_KEY="$OIDC_HOST:sub"
jq -S --arg acct "$ACCOUNT" "$RENDER | .Resources.DeployRole.Properties.AssumeRolePolicyDocument | $NORM" "$IMPORT_TEMPLATE" >"$tmp/trust.target"
NEW_SUBS="$(jq -c --arg k "$SUB_KEY" '.Statement[0].Condition.StringEquals[$k] | sort' "$tmp/trust.target")"
REPO_SUBJECT="$(jq -r --arg k "$SUB_KEY" '.Statement[0].Condition.StringEquals[$k][0] | sub(":environment:[a-z]+$"; "")' "$tmp/trust.target")"
[[ "$NEW_SUBS" == "[\"$REPO_SUBJECT:environment:dev\",\"$REPO_SUBJECT:environment:prod\"]" ]] \
  || die "the import template does not hold exactly the two environment subjects: $NEW_SUBS"
[[ "$REPO_SUBJECT" =~ ^repo:[^@/:]+@[0-9]+/[^@/:]+@[0-9]+$ ]] \
  || die "the import template's subjects are not in the immutable form repo:<owner>@<id>/<repo>@<id>: $REPO_SUBJECT"
# The same prefix without the numeric ids: the plain form the role had first.
PLAIN_SUBJECT="$(sed -E 's/@[0-9]+//g' <<<"$REPO_SUBJECT")"
OLD_SUBS_IMMUTABLE="$(jq -cn --arg r "$REPO_SUBJECT" '[$r + ":environment:dev", $r + ":ref:refs/heads/main"] | sort')"
OLD_SUBS_PLAIN="$(jq -cn --arg r "$PLAIN_SUBJECT" '[$r + ":environment:dev", $r + ":ref:refs/heads/main"] | sort')"

aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json >"$tmp/trust.raw" \
  || die "could not read the role $ROLE"
jq -S "$NORM" "$tmp/trust.raw" >"$tmp/trust.current"
# The documents this script knows as "old": the target with only the sub condition different.
#   plain:     the original, StringEquals with the plain subjects (docs/07);
#   immutable: the role as GitHub's immutable subject form made it live (ADR 0018, addendum):
#              aud in StringEquals, the two immutable subjects (environment:dev and
#              ref:refs/heads/main) in StringLike.
jq -S --arg k "$SUB_KEY" --argjson subs "$OLD_SUBS_PLAIN" '.Statement[0].Condition.StringEquals[$k] = $subs' "$tmp/trust.target" >"$tmp/trust.expected-old-plain"
jq -S --arg k "$SUB_KEY" --argjson subs "$OLD_SUBS_IMMUTABLE" \
  'del(.Statement[0].Condition.StringEquals[$k]) | .Statement[0].Condition.StringLike = {($k): $subs}' "$tmp/trust.target" >"$tmp/trust.expected-old-immutable"

TRUST_PENDING=0
if cmp -s "$tmp/trust.current" "$tmp/trust.target"; then
  note "#46: the trust already lists exactly environment:dev and environment:prod; skipped"
elif cmp -s "$tmp/trust.current" "$tmp/trust.expected-old-plain" || cmp -s "$tmp/trust.current" "$tmp/trust.expected-old-immutable"; then
  # Identical to the current document except the sub condition, which becomes StringEquals
  # with the two environment subjects (a StringLike block, if any, is dropped).
  jq --arg k "$SUB_KEY" --argjson subs "$NEW_SUBS" 'del(.Statement[0].Condition.StringLike) | .Statement[0].Condition.StringEquals[$k] = $subs' "$tmp/trust.raw" >"$tmp/trust.new"
  jq -S "$NORM" "$tmp/trust.new" | cmp -s - "$tmp/trust.target" || die "internal: the new trust would not match the import template"
  echo "  The trust is a known old document (docs/07, ADR 0018). The change (only the sub condition):"
  diff -u --label "current trust" --label "new trust" "$tmp/trust.current" "$tmp/trust.target" | mask || true
  change aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$tmp/trust.new" || die "update-assume-role-policy failed"
  if [[ $APPLY -eq 1 ]]; then
    aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json | jq -S "$NORM" | cmp -s - "$tmp/trust.target" \
      || die "after the update the trust still differs from the import template"
    note "#46: trust updated: sub is now exactly environment:dev and environment:prod"
  else
    TRUST_PENDING=1
    note "#46: dry run: the trust would be updated (sub condition only)"
  fi
else
  echo "  The trust is neither a known old document nor the target. Difference to the known old one in the immutable form:" >&2
  diff -u --label "expected old (docs/07, ADR 0018)" --label "actual" "$tmp/trust.expected-old-immutable" "$tmp/trust.current" | mask >&2 || true
  echo "  Difference to the original plain form:" >&2
  diff -u --label "expected old, plain" --label "actual" "$tmp/trust.expected-old-plain" "$tmp/trust.current" | mask >&2 || true
  die "unexpected trust on $ROLE; it is not overwritten. Report this difference."
fi

# ---------------------------------------------------------------------------------------
step 3 "Import $ROLE into the stack $STACK (#48)"
(cd infra && npx cdk synth --no-lookups --quiet --output "$tmp/cdk.out") 2>&1 | mask || die "the committed app did not synthesise"
echo "  Synthesised offline in both modes (import and committed)."

status_err="$tmp/describe.err"
if stack_status="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>"$status_err")"; then
  :
elif grep -q "does not exist" "$status_err"; then
  stack_status="NONE"
else
  mask <"$status_err" >&2
  die "could not read the stack $STACK"
fi
echo "  Stack $STACK: $stack_status"

drift_check() { # label
  local id state
  id="$(aws cloudformation detect-stack-drift --stack-name "$STACK" --query StackDriftDetectionId --output text)"
  for _ in $(seq 1 60); do
    state="$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$id" \
      --query '[DetectionStatus,StackDriftStatus]' --output text)"
    [[ "$state" == DETECTION_IN_PROGRESS* ]] || break
    sleep "$POLL_S"
  done
  if [[ "$(tr -s '\t ' ' ' <<<"$state")" != "DETECTION_COMPLETE IN_SYNC" ]]; then
    aws cloudformation describe-stack-resource-drifts --stack-name "$STACK" --output json 2>&1 | mask >&2 || true
    die "drift detection ($1) reports '$state', not IN_SYNC. Do not deploy; report the difference (infra/README.md, One-time import)."
  fi
  echo "  Drift detection ($1): IN_SYNC"
}

case "$stack_status" in
  NONE)
    if [[ $TRUST_PENDING -eq 1 ]]; then
      echo "  Dry run: check-github-deploy-role.sh runs after the trust update in --apply mode (it cannot pass before)."
    else
      "$HERE/check-github-deploy-role.sh" "$IMPORT_TEMPLATE" 2>&1 | mask || die "the role differs from the import template; do not import. Report the difference."
    fi
    change bash -c "cd infra && npx cdk import $STACK -c cupmark:githubOidcImport=true --resource-mapping import/$STACK.json --toolkit-stack-name $TOOLKIT_STACK --no-lookups --output '$tmp/cdk.out-import'" || die "cdk import failed (infra/README.md, One-time import, Rolling back)"
    if [[ $APPLY -eq 1 ]]; then
      stack_status="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"
      [[ "$stack_status" == "IMPORT_COMPLETE" ]] || die "after the import the stack is $stack_status, not IMPORT_COMPLETE (infra/README.md, Rolling back)"
      note "#48: role imported into $STACK (IMPORT_COMPLETE)"
    else
      note "#48: dry run: the role would be imported into $STACK"
    fi
    ;;
  IMPORT_COMPLETE | UPDATE_COMPLETE)
    note "#48: $STACK already exists ($stack_status); import skipped"
    ;;
  *)
    die "the stack $STACK is in $stack_status. See infra/README.md, One-time import, Rolling back; nothing was changed."
    ;;
esac

if [[ $APPLY -eq 1 ]]; then
  drift_check "after the import"
  (cd infra && npx cdk diff "$STACK" --toolkit-stack-name "$TOOLKIT_STACK" --no-lookups --output "$tmp/cdk.out") 2>&1 | mask \
    || die "cdk diff failed"
  echo "  Expected diff: only the tag project=cupmark on DeployRole (and the stack tag), or nothing on a second run."
  (cd infra && npx cdk deploy "$STACK" --toolkit-stack-name "$TOOLKIT_STACK" --no-lookups --output "$tmp/cdk.out") 2>&1 | mask \
    || die "cdk deploy failed; CloudFormation rolls a failed update back on its own"
  tag="$(aws iam list-role-tags --role-name "$ROLE" --query "Tags[?Key=='project'].Value | [0]" --output text)"
  [[ "$tag" == "cupmark" ]] || die "the role has no tag project=cupmark after the deploy (got '$tag')"
  protection="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].EnableTerminationProtection' --output text)"
  [[ "$protection" == "True" ]] || die "termination protection of $STACK is '$protection', not on. Report it."
  drift_check "after the deploy"
  note "#48: deployed $STACK: tag project=cupmark on $ROLE, termination protection on, IN_SYNC"
else
  echo "  + drift detection on $STACK (must be IN_SYNC)"
  echo "  + (cd infra && npx cdk diff $STACK --toolkit-stack-name $TOOLKIT_STACK)"
  echo "  + (cd infra && npx cdk deploy $STACK --toolkit-stack-name $TOOLKIT_STACK)"
  echo "  + check: tag project=cupmark on $ROLE, termination protection on, drift IN_SYNC"
fi

# ---------------------------------------------------------------------------------------
step 4 "Summary"
for line in "${SUMMARY[@]}"; do echo "  - $line"; done
if [[ $APPLY -eq 1 ]]; then
  echo
  echo "Done. Comment \"done\" on the GitHub issues #45, #46 and #48 and paste this summary."
  echo "The first half of #46 is in the GitHub web UI, not here: the environments dev and prod,"
  echo "both limited to the branch main, and you as the required reviewer of prod."
  echo "Then run the \"AWS OIDC check\" workflow on main."
else
  echo
  echo "Dry run only: nothing was changed. If every step above looks right, run again with --apply."
fi
