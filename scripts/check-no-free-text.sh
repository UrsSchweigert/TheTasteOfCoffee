#!/usr/bin/env bash
# Invariant 1 in CLAUDE.md: no free text, in the app or in the API.
# - The iOS sources must not contain a control that accepts typed text.
# - contracts/openapi.yaml must not contain a string without enum, pattern
#   or format (plus the other API lint rules, see contracts/README.md).
#   This needs Node 22 and `npm ci` in contracts/.
# Run from anywhere; exits 1 on any finding.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ios_dir="$root/ios"
contracts_dir="$root/contracts"
failed=0

# ---- iOS sources ----
if [ ! -d "$ios_dir" ]; then
  echo "check-no-free-text: no ios/ directory yet, nothing to check in the app"
else
  pattern='\b(TextField|TextEditor|SecureField|UITextField|UITextView|UISearchBar|UISearchController|UIAlertController[^\n]*addTextField)\b|\.searchable\('
  if matches=$(grep -RnE --include='*.swift' "$pattern" "$ios_dir"); then
    echo "check-no-free-text: FAILED. Typed-text controls are not allowed:"
    echo "$matches"
    failed=1
  else
    echo "check-no-free-text: ios ok"
  fi
fi

# ---- API contract ----
if [ -f "$contracts_dir/openapi.yaml" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "check-no-free-text: FAILED. node is needed to lint contracts/openapi.yaml"
    failed=1
  elif [ ! -d "$contracts_dir/node_modules/yaml" ]; then
    echo "check-no-free-text: FAILED. Run 'npm ci' in contracts/ first"
    failed=1
  elif ! node "$contracts_dir/bin/lint-openapi.mjs"; then
    echo "check-no-free-text: FAILED. contracts/openapi.yaml breaks the API lint"
    failed=1
  fi
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "check-no-free-text: ok"
