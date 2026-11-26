#!/bin/bash
# Xcode Cloud runs this before every xcodebuild action (M2-T12, ADR 0035).
# It sets the build number (CURRENT_PROJECT_VERSION) to Xcode Cloud's CI_BUILD_NUMBER,
# so every TestFlight upload has a number App Store Connect has not seen.
# Outside Xcode Cloud (CI_XCODE_CLOUD unset) it does nothing. No network, no secrets.
set -euo pipefail

if [[ "${CI_XCODE_CLOUD:-}" != "TRUE" ]]; then
  echo "ci_pre_xcodebuild: not running in Xcode Cloud, nothing to do"
  exit 0
fi

build_number="${CI_BUILD_NUMBER:-}"
if [[ ! "$build_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "ci_pre_xcodebuild: CI_BUILD_NUMBER is missing or not a positive integer" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_file="$script_dir/../Cupmark.xcodeproj/project.pbxproj"

sed -i.bak -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${build_number};/" "$project_file"
rm -f "$project_file.bak"

echo "ci_pre_xcodebuild: build number set to ${build_number}"
