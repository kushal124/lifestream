#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/Signing"
[ $# -eq 1 ] || { echo "usage: ./signing.sh DEVELOPMENT_TEAM | LIFESTREAM_BUNDLE_PREFIX" >&2; exit 64; }
value=$(cat Signing.xcconfig $([ -f Local.xcconfig ] && echo Local.xcconfig) | awk -v key="$1" '
  { sub(/\/\/.*/, ""); eq = index($0, "=") }
  eq {
    name = substr($0, 1, eq - 1); setting = substr($0, eq + 1)
    gsub(/^[ \t]+|[ \t]+$/, "", name); gsub(/^[ \t]+|[ \t]+$/, "", setting)
    if (name == key) value = setting
  }
  END { print value }')
[ -n "$value" ] || { echo "Signing/Signing.xcconfig states no $1" >&2; exit 1; }
echo "$value"
