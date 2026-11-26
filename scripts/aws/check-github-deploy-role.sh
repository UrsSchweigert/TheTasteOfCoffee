#!/usr/bin/env bash
# Operator tool, read-only. Run by the owner before `cdk import cupmark-github-oidc`
# (infra/README.md, "One-time import", step 2; ADR 0018). It compares the existing role
# CupmarkGitHubDeploy with the import template and exits non-zero on any difference,
# because an import never changes the role: a difference would stay as silent drift.
# It only calls `aws sts get-caller-identity` and `aws iam get-*` / `list-*`. It also
# checks that the GitHub OIDC provider's ClientIDList contains sts.amazonaws.com (M1-T7).
#
#   (cd infra && npx cdk synth --no-lookups --quiet -c cupmark:githubOidcImport=true)
#   scripts/aws/check-github-deploy-role.sh [template]
#
# Exit 0: the role matches. Exit 1: a difference (printed as a diff). Exit 2: usage error,
# for example a template synthesised without the import flag.
set -euo pipefail

ROLE="CupmarkGitHubDeploy"
PROVIDER_HOST="token.actions.githubusercontent.com"
HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="${1:-$HERE/../../infra/cdk.out/cupmark-github-oidc.template.json}"
export AWS_PAGER=""

if [[ ! -f "$TEMPLATE" ]]; then
  echo "No template at $TEMPLATE. Run in infra/: npx cdk synth --no-lookups --quiet -c cupmark:githubOidcImport=true" >&2
  exit 2
fi
# The import template holds only the role, with exactly these properties (no Tags).
shape="$(jq -c '[(.Resources | keys), (.Resources.DeployRole.Properties | keys)]' "$TEMPLATE")"
if [[ "$shape" != '[["DeployRole"],["AssumeRolePolicyDocument","Policies","RoleName"]]' ]]; then
  echo "$TEMPLATE is not the import template ($shape)." >&2
  echo "Synthesise with -c cupmark:githubOidcImport=true and the committed cupmark:githubOidcProvider=reference." >&2
  exit 2
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fn::Join with literal parts and Ref AWS::AccountId only; anything else is an error.
RENDER='walk(if type == "object" and has("Fn::Join") then
  (.["Fn::Join"] as [$sep, $parts] | $parts
    | map(if type == "string" then . elif (type == "object" and .Ref == "AWS::AccountId") then $acct
          else error("unexpected intrinsic \(tojson)") end)
    | join($sep))
  else . end)'
# Order of string lists (subjects, ARNs) does not matter to IAM; everything else must match.
NORM='walk(if type == "array" and length > 0 and all(.[]; type == "string") then sort else . end)'

expected() { jq -S --arg acct "$ACCOUNT" "$RENDER | $1 | $NORM" "$TEMPLATE"; }
actual() { jq -S "$NORM"; }

failed=0
compare() { # label expected-file actual-file
  if diff -u --label "expected ($1)" --label "actual ($1)" "$2" "$3"; then
    echo "OK         $1"
  else
    echo "DIFFERENT  $1"
    failed=1
  fi
}

aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output json \
  | jq -S --arg arn "arn:aws:iam::$ACCOUNT:oidc-provider/$PROVIDER_HOST" '[.[] | select(. == $arn)]' > "$tmp/provider.actual"
jq -n -S --arg arn "arn:aws:iam::$ACCOUNT:oidc-provider/$PROVIDER_HOST" '[$arn]' > "$tmp/provider.expected"
compare "GitHub OIDC provider exists" "$tmp/provider.expected" "$tmp/provider.actual"

# The trust requires aud sts.amazonaws.com, so the provider must list it as a client id
# (audience). The provider is shared with other projects and may list more; only this
# one is checked, and the provider is only read.
jq -n -S '["sts.amazonaws.com"]' > "$tmp/audience.expected"
if [[ "$(jq length "$tmp/provider.actual")" -eq 1 ]]; then
  aws iam get-open-id-connect-provider --open-id-connect-provider-arn "arn:aws:iam::$ACCOUNT:oidc-provider/$PROVIDER_HOST" \
    --query 'ClientIDList' --output json \
    | jq -S '[.[] | select(. == "sts.amazonaws.com")] | unique' > "$tmp/audience.actual"
else
  echo '[]' > "$tmp/audience.actual"
fi
compare "GitHub OIDC provider audience (ClientIDList contains sts.amazonaws.com)" "$tmp/audience.expected" "$tmp/audience.actual"

expected '.Resources.DeployRole.Properties.AssumeRolePolicyDocument' > "$tmp/trust.expected"
aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json | actual > "$tmp/trust.actual"
compare "trust policy" "$tmp/trust.expected" "$tmp/trust.actual"

expected '[.Resources.DeployRole.Properties.Policies[].PolicyName]' > "$tmp/names.expected"
aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output json | actual > "$tmp/names.actual"
compare "inline policy names" "$tmp/names.expected" "$tmp/names.actual"

name="$(jq -r '.Resources.DeployRole.Properties.Policies[0].PolicyName' "$TEMPLATE")"
expected '.Resources.DeployRole.Properties.Policies[0].PolicyDocument' > "$tmp/policy.expected"
aws iam get-role-policy --role-name "$ROLE" --policy-name "$name" --query 'PolicyDocument' --output json | actual > "$tmp/policy.actual"
compare "inline policy $name" "$tmp/policy.expected" "$tmp/policy.actual"

echo '[]' > "$tmp/attached.expected"
aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies' --output json | actual > "$tmp/attached.actual"
compare "no managed policies" "$tmp/attached.expected" "$tmp/attached.actual"

# Defaults of a role created without them; the template sets none of these.
jq -n -S --arg name "$ROLE" '{RoleName: $name, Path: "/", MaxSessionDuration: 3600, Description: null, PermissionsBoundary: null, Tags: []}' > "$tmp/role.expected"
aws iam get-role --role-name "$ROLE" \
  --query 'Role.{RoleName:RoleName,Path:Path,MaxSessionDuration:MaxSessionDuration,Description:Description,PermissionsBoundary:PermissionsBoundary,Tags:Tags}' \
  --output json | jq -S '.Tags //= []' > "$tmp/role.actual"
compare "name, path, session, description, boundary, tags" "$tmp/role.expected" "$tmp/role.actual"

if [[ $failed -ne 0 ]]; then
  echo "The role differs from the import template. Do not import; report the difference." >&2
  echo "A trust that differs only in the sub condition (plain subjects, or immutable subjects with StringLike) is rewritten by scripts/aws/first-deploy-setup.sh, step 2 (ADR 0018); this check stays strict." >&2
  exit 1
fi
echo "The role matches the import template."
