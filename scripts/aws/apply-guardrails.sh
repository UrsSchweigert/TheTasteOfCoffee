#!/usr/bin/env bash
# Operator tool. Run by a human, never by an agent in CI (CLAUDE.md: anything that
# touches a real AWS account). Creates the Cupmark-only guardrails in the shared
# account and a separate CDK bootstrap that uses them. Does not modify any
# existing resource, including the shared CDKToolkit stack (invariant 9).
#
#   scripts/aws/apply-guardrails.sh            # dry run: prints what it would do
#   scripts/aws/apply-guardrails.sh --apply    # does it
set -euo pipefail

REGION="eu-central-1"
QUALIFIER="cupmark"
TOOLKIT_STACK="CDKToolkit-cupmark"
DEPLOY_ROLE="CupmarkGitHubDeploy"
HERE="$(cd "$(dirname "$0")" && pwd)"
APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) echo "Usage: $0 [--apply]   (without --apply: dry run, changes nothing)" >&2; exit 2 ;;
esac

export AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ARN="$(aws sts get-caller-identity --query Arn --output text)"
if [[ "$ARN" == *":root" && "${ALLOW_ROOT:-}" != "1" ]]; then
  echo "Refusing to run as the account root user. Use an admin IAM or SSO identity," >&2
  echo "or set ALLOW_ROOT=1 once, knowingly, and delete the root access keys afterwards." >&2
  exit 1
fi

render() { sed -e "s/\${ACCOUNT}/$ACCOUNT/g" -e "s/\${REGION}/$REGION/g" "$1"; }
# Prints every change; runs it only with --apply. A failed change stops the script
# (set -e), so a partial apply is never reported as done.
run() { echo "+ $*"; if [[ $APPLY -eq 1 ]]; then "$@"; fi; }

upsert_policy() { # name file
  local name="$1" file="$2" arn="arn:aws:iam::$ACCOUNT:policy/$1" tmp
  tmp="$(mktemp)"; render "$file" > "$tmp"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    # keep at most 5 versions: drop the oldest non-default first
    local old
    old="$(aws iam list-policy-versions --policy-arn "$arn" \
      --query 'Versions[?!IsDefaultVersion]|[-1].VersionId' --output text)"
    [[ "$old" != "None" ]] && run aws iam delete-policy-version --policy-arn "$arn" --version-id "$old"
    run aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$tmp" --set-as-default
  else
    run aws iam create-policy --policy-name "$name" --policy-document "file://$tmp" \
      --tags Key=project,Value=cupmark
  fi
}

echo "Account $ACCOUNT, region $REGION, apply=$APPLY"

# 1. Managed policies (IAM only, free)
upsert_policy CupmarkBoundary "$HERE/cupmark-boundary-policy.json"
upsert_policy CupmarkCfnExecution "$HERE/cupmark-cfn-execution-policy.json"

# 2. Separate CDK bootstrap: own bucket and roles (cdk-cupmark-*), CloudFormation
#    executes with CupmarkCfnExecution instead of AdministratorAccess.
run npx cdk bootstrap "aws://$ACCOUNT/$REGION" \
  --qualifier "$QUALIFIER" \
  --toolkit-stack-name "$TOOLKIT_STACK" \
  --cloudformation-execution-policies "arn:aws:iam::$ACCOUNT:policy/CupmarkCfnExecution" \
  --trust "$ACCOUNT" \
  --tags project=cupmark

# 3. The GitHub deploy role CupmarkGitHubDeploy is owned by the CDK stack
#    cupmark-github-oidc since M1-T9 (ADR 0009, ADR 0018): its trust and its inline
#    policy AssumeCdkBootstrapRoles are defined in infra/src/github-oidc.ts and changed
#    only through that stack (infra/README.md, "The GitHub deploy role"). This script
#    never writes, tags or deletes the role, so it cannot drift from the stack.
echo "= $DEPLOY_ROLE: owned by the stack cupmark-github-oidc (infra/src/github-oidc.ts); not changed here."

if [[ $APPLY -eq 0 ]]; then
  echo "Dry run only. Re-run with --apply to make these changes."
else
  echo "Applied."
fi
