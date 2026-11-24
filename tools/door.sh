#!/bin/sh
set -eu
route=${1:?usage: tools/door.sh <route>, for example /v1/status (docs/operating/door.md lists them)}
case "$route" in /*) ;; *) echo "a route starts with /: /v1/status" >&2; exit 64 ;; esac
if [ "$(uname)" = Darwin ]; then machine="$HOME/Library/Application Support/Lifestream"; else machine="${XDG_DATA_HOME:-$HOME/.local/share}/lifestream"; fi
file="${LIFESTREAM_MACHINE_DIR:-$machine}/reader-token"
token=${LIFESTREAM_DOOR_TOKEN:-}
if [ -z "$token" ] && [ -r "$file" ]; then token=$(cat "$file"); fi
if [ -z "$token" ]; then
  echo "no read token: set LIFESTREAM_DOOR_TOKEN, or mint one into $file (docs/operating/reading.md)" >&2
  exit 64
fi
printf 'header = "Authorization: Bearer %s"\n' "$token" | exec curl -sS --fail-with-body -K - "${LIFESTREAM_DOOR:-http://127.0.0.1:4680}$route"
