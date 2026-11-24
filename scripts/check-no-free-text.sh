#!/usr/bin/env bash
# Fails if the iOS sources contain a control that accepts typed text.
# This is invariant 1 in CLAUDE.md. Run from the repository root.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ios_dir="$root/ios"

if [ ! -d "$ios_dir" ]; then
  echo "check-no-free-text: no ios/ directory yet, nothing to check"
  exit 0
fi

pattern='\b(TextField|TextEditor|SecureField|UITextField|UITextView|UISearchBar|UISearchController|UIAlertController[^\n]*addTextField)\b|\.searchable\('

if matches=$(grep -RnE --include='*.swift' "$pattern" "$ios_dir"); then
  echo "check-no-free-text: FAILED. Typed-text controls are not allowed:"
  echo "$matches"
  exit 1
fi

echo "check-no-free-text: ok"
