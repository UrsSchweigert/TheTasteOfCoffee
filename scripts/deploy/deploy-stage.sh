#!/usr/bin/env bash
# Deploys one stage stack, cupmark-<stage>-core (M1-T7, ADR 0019). Run only by
# .github/workflows/deploy.yml, in the job of the GitHub environment of the same name,
# after configure-aws-credentials has assumed CupmarkGitHubDeploy. Never by an agent,
# never from a laptop (infra/README.md, "Deploy pipeline").
#
#   OFF_CONTACT=<mailbox> [OFF_LOOKUP_CAP=<0..10000>] scripts/deploy/deploy-stage.sh dev|prod
#
# What it does, in this order, and nothing else:
# 1. checks the stage, the region (eu-central-1) and that OFF_CONTACT is set;
# 2. reads the account from the assumed identity (`aws sts get-caller-identity`) and
#    checks that the identity is CupmarkGitHubDeploy. The account id is never committed;
#    in GitHub Actions it is masked (::add-mask::) before any CDK output. OFF_CONTACT is
#    an environment secret, which GitHub masks itself;
# 3. `cdk diff` of the one stack, for the log;
# 4. `cdk deploy` of the one stack, named explicitly (selector `<stage>/core`), never --all, in deploy mode
#    (-c cupmark:deploy=<stage>), on the Cupmark bootstrap (qualifier cupmark, stack
#    CDKToolkit-cupmark). Deploy mode makes the synth fail without a valid contact.
#
# Exit 2: usage or configuration error, before any AWS call that changes anything.
set -euo pipefail

REGION="eu-central-1"
TOOLKIT_STACK="CDKToolkit-cupmark"
DEPLOY_ROLE="CupmarkGitHubDeploy"
HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$HERE/../../infra"
export AWS_PAGER=""

usage() {
  echo "Usage: $0 dev|prod   (with OFF_CONTACT set; OFF_LOOKUP_CAP optional)" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage
STAGE="$1"
case "$STAGE" in
  dev | prod) ;;
  *) usage ;;
esac
STACK="cupmark-$STAGE-core"
# The CDK CLI selects a stack inside a Stage by its hierarchical id (`dev/core`), not by
# its stack name: `cdk deploy cupmark-dev-core` answers "No stacks match". With
# -c stage=<stage> the app holds only this stage, so the selector is exactly $STACK.
SELECTOR="$STAGE/core"

# configure-aws-credentials sets AWS_REGION from its literal aws-region input (invariant 6).
if [[ "${AWS_REGION:-}" != "$REGION" ]]; then
  echo "AWS_REGION must be $REGION; got '${AWS_REGION:-}'." >&2
  exit 2
fi
if [[ -z "${OFF_CONTACT:-}" ]]; then
  echo "OFF_CONTACT is not set. Set the secret OFF_CONTACT in the GitHub environment '$STAGE' (infra/README.md)." >&2
  exit 2
fi

in_actions() { [[ "${GITHUB_ACTIONS:-}" == "true" ]]; }
# OFF_CONTACT comes from an environment secret, so GitHub already masks it; this mask only
# covers a run where it was passed some other way. The account is masked below.
if in_actions; then echo "::add-mask::$OFF_CONTACT"; fi

identity="$(aws sts get-caller-identity --region "$REGION" --query '[Account,Arn]' --output text)"
read -r ACCOUNT ARN <<<"$identity"
if [[ ! "$ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  echo "Could not read the account id from the assumed identity." >&2
  exit 2
fi
if in_actions; then echo "::add-mask::$ACCOUNT"; fi
if [[ "$ARN" != "arn:aws:sts::$ACCOUNT:assumed-role/$DEPLOY_ROLE/"* ]]; then
  echo "The caller is not the role $DEPLOY_ROLE; refusing to deploy." >&2
  exit 2
fi

context=(
  -c "stage=$STAGE"
  -c "cupmark:deploy=$STAGE"
  -c "cupmark:$STAGE:account=$ACCOUNT"
  -c "cupmark:offContact=$OFF_CONTACT"
)
if [[ -n "${OFF_LOOKUP_CAP:-}" ]]; then
  context+=(-c "cupmark:offLookupCap=$OFF_LOOKUP_CAP")
fi
common=(--toolkit-stack-name "$TOOLKIT_STACK" --no-lookups)

cd "$INFRA"

echo "== cdk diff $STACK"
npx cdk diff "$SELECTOR" "${context[@]}" "${common[@]}"

echo "== cdk deploy $STACK"
npx cdk deploy "$SELECTOR" "${context[@]}" "${common[@]}" --exclusively --require-approval never --ci

echo "Deployed $STACK."
