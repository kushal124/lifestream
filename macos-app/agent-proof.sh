#!/bin/bash
set -uo pipefail

app="${2:-/Applications/Lifestream.app}"
machine="$HOME/Library/Application Support/Lifestream"
current="$machine/current"
artifact="${LIFESTREAM_PROOF_ARTIFACT:-$HOME/Desktop/lifestream-agent-proof.txt}"
jobs=(home door dashboard mcp runner resource-watch)
domain="gui/$(id -u)"
failed=0
grant_snapshot="$(dirname "$artifact")/lifestream-grants-before.txt"

privacy_rows() {
  for db in "/Library/Application Support/com.apple.TCC/TCC.db" "$HOME/Library/Application Support/com.apple.TCC/TCC.db"; do
    sudo -n sqlite3 "$db" "select service || '|' || auth_value || '|' || hex(csreq) from access where client = 'org.lifestreamprotocol.screen-capture' and service in ('kTCCServiceScreenCapture','kTCCServiceAccessibility','kTCCServiceSystemPolicyAllFiles','kTCCServiceMicrophone') order by service" || return
  done | sort
}
required_grants() {
  local rows="$1" service
  for service in ScreenCapture Accessibility SystemPolicyAllFiles Microphone; do
    printf '%s\n' "$rows" | grep -q "^kTCCService$service|2|" || return 1
  done
}

say() { printf '%s\n' "$*" | tee -a "$artifact"; }
check() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then say "PASS $name"; else say "FAIL $name: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"; failed=1; fi
}
pid_of() { launchctl print "$domain/org.lifestreamprotocol.$1" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p'; }
running() { [ -n "$(pid_of "$1")" ]; }
seconds_up() { ps -o etime= -p "$1" | awk -F'[-:]' '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; print s }'; }
home_socket() {
  local id
  id="$(plutil -extract id raw -o - "$(cat "$machine/home")/HOME.json")" || return
  printf '%s/run/%s.sock' "$machine" "$(printf '%s' "$id" | shasum -a 256 | cut -c1-8)"
}
socket() {
  local path
  path="$(home_socket)" || return
  "$current/node" -e "require('net').connect(process.argv[1]).on('connect', () => process.exit(0)).on('error', (e) => { console.log(e.message); process.exit(1); })" \
    "$path"
}
current() { [ "$("$app/Contents/MacOS/Lifestream" agents | grep -o '"current"' | wc -l | tr -d ' ')" = "${#jobs[@]}" ]; }
commit_of() { sed -n 's/^[[:space:]]*"commit":[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$1/RELEASE.json"; }
carried() { [ -n "$(commit_of "$app/Contents/Resources/release")" ] && [ "$(commit_of "$current")" = "$(commit_of "$app/Contents/Resources/release")" ]; }
at_login() { "$app/Contents/MacOS/Lifestream" agents | grep -q '"app":"enabled"'; }
window() { lsappinfo info -only applicationtype -app org.lifestreamprotocol.screen-capture; }
opened() {
  log show --last 1h --style compact --predicate 'subsystem == "org.lifestreamprotocol.screen-capture" AND category == "launch"' \
    | grep ' opened ' | tail -n 1 | sed 's/.*\] //'
}
answers() {
  local code; code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$@")"; [ "$code" != "000" ] && echo "HTTP $code"
}

running_checks() {
  check "Lifestream agents are all current" current
  check "the release that answers is the one this app carries ($(commit_of "$app/Contents/Resources/release"))" carried
  check "Lifestream opens at login" at_login
  say "agents: $("$app/Contents/MacOS/Lifestream" agents)"
  for job in "${jobs[@]}"; do check "launchd runs $job" running "$job"; done
  check "the add-on loads in the installed release" "$current/node" -e \
    "const D = require(require('path').join(process.argv[1], 'node_modules', 'better-sqlite3')); console.log(new D(':memory:').prepare('select sqlite_version() v').get().v)" "$(cd "$current" && pwd -P)"
  check "the home answers its socket" socket
  check "the door answers on 127.0.0.1:4680" answers http://127.0.0.1:4680/v1/status
  check "the dashboard answers on 127.0.0.1:4317" answers http://127.0.0.1:4317/
  check "the MCP server answers on 127.0.0.1:4681" answers -X POST http://127.0.0.1:4681/mcp
  for job in "${jobs[@]}"; do
    old="$(pid_of "$job")"
    [ -z "$old" ] && { say "FAIL kill -9 $job: it does not run"; failed=1; continue; }
    while [ "$(seconds_up "$old")" -lt 15 ]; do sleep 1; done
    kill -9 "$old"
    started=$(date +%s)
    new=""
    while [ $(( $(date +%s) - started )) -lt 30 ]; do
      new="$(pid_of "$job")"
      [ -n "$new" ] && [ "$new" != "$old" ] && break
      sleep 0.2
    done
    took=$(( $(date +%s) - started ))
    if [ -n "$new" ] && [ "$new" != "$old" ] && [ "$took" -lt 5 ]; then say "PASS kill -9 $job: pid $old, then $new after ${took} s"
    else say "FAIL kill -9 $job: pid $old, then '${new}' after ${took} s"; failed=1; fi
  done
  sleep 5
  check "the home answers its socket after its restart" socket
  say "Login Items: open System Settings, General, Login Items & Extensions: Lifestream is listed once, allowed in the background."
  say "Next: log out, log in, then run: bash agent-proof.sh login"
}

say ""
say "== ${1:-} $(date -u +%Y-%m-%dT%H:%M:%SZ) on macOS $(sw_vers -productVersion), uid $(id -u)"

case "${1:-}" in
image)
  image="${2:-$HOME/Downloads/Lifestream.dmg}"
  check "Gatekeeper is enabled" sh -c '[ "$(spctl --status)" = "assessments enabled" ]'
  check "the downloaded disk image retains quarantine" xattr -p com.apple.quarantine "$image"
  check "the disk image is intact" hdiutil verify "$image"
  check "the disk image signature is valid" codesign --verify --strict "$image"
  check "Gatekeeper accepts the disk image" spctl --assess --type open --context context:primary-signature -vv "$image"
  ;;
app)
  check "Gatekeeper is enabled" sh -c '[ "$(spctl --status)" = "assessments enabled" ]'
  check "the downloaded app retains quarantine" xattr -p com.apple.quarantine "$app"
  check "codesign --verify --deep --strict" codesign --verify --deep --strict "$app"
  check "the app carries the release" test -f "$app/Contents/Resources/release/RELEASE.json"
  for job in "${jobs[@]}"; do
    check "the app defines the $job agent" plutil -lint "$app/Contents/Library/LaunchAgents/org.lifestreamprotocol.$job.plist"
    check "the $job agent dumps no core and starts with the mask 077" sh -c \
      '[ "$(plutil -extract HardResourceLimits.Core raw "$1")" = 0 ] && [ "$(plutil -extract Umask raw "$1")" = 63 ]' \
      sh "$app/Contents/Library/LaunchAgents/org.lifestreamprotocol.$job.plist"
  done
  check "the home agent abandons no process group" sh -c \
    '! plutil -extract AbandonProcessGroup raw "$1" >/dev/null 2>&1' sh "$app/Contents/Library/LaunchAgents/org.lifestreamprotocol.home.plist"
  check "Gatekeeper accepts the notarized app" spctl --assess --type execute -vv "$app"
  check "the app uses the hardened runtime" sh -c 'codesign -dvv "$1" 2>&1 | grep -q "flags=.*runtime"' sh "$app"
  for entitlement in device.audio-input personal-information.photos-library; do
    check "the app carries com.apple.security.$entitlement" sh -c \
      'codesign -d --entitlements - --xml "$1" 2>/dev/null | grep -q "com.apple.security.$2"' sh "$app" "$entitlement"
  done
  check "the bundled Node executes JIT code" "$app/Contents/Resources/release/node" -e \
    'const f = new Function("n", "return n + 1"); for (let i = 0; i < 100000; i++) if (f(i) !== i + 1) process.exit(1)'
  check "the bundled SQLite add-on loads" "$app/Contents/Resources/release/node" -e \
    'const D = require(require("path").join(process.argv[1], "node_modules", "better-sqlite3")); const db = new D(":memory:"); db.exec("create table proof (n); insert into proof values (1)"); if (db.prepare("select n from proof").get().n !== 1) process.exit(1); db.close()' "$app/Contents/Resources/release"
  say "quarantine on the app: $(xattr -p com.apple.quarantine "$app" 2>/dev/null || echo none)"
  ;;
run)
  running_checks
  ;;
update)
  started=$(date +%s)
  while ! current && [ $(( $(date +%s) - started )) -lt 90 ]; do sleep 1; done
  say "agents current $(( $(date +%s) - started )) s after this phase began, built $(plutil -extract CFBundleVersion raw "$app/Contents/Info.plist")"
  running_checks
  ;;
paired)
  say "setup: $("$app/Contents/MacOS/Lifestream" setup)"
  check "the first run does not open" sh -c "'$app/Contents/MacOS/Lifestream' setup | grep -q '\"opens\":null'"
  check "this app holds a pass" sh -c "'$app/Contents/MacOS/Lifestream' home | grep -q '\"pass\":\"set\"'"
  say "opened: $(opened)"
  check "the app shows a window" sh -c "lsappinfo info -only applicationtype -app org.lifestreamprotocol.screen-capture | grep -q Foreground"
  ;;
login)
  check "the app runs after login" pgrep -f "$app/Contents/MacOS/Lifestream\$"
  say "opened: $(opened)"
  check "the app knew it was opened at login" sh -c "log show --last 1h --style compact --predicate 'subsystem == \"org.lifestreamprotocol.screen-capture\" AND category == \"launch\"' | grep ' opened ' | tail -n 1 | grep -q 'opened at_login'"
  check "the app shows no window after login" sh -c "lsappinfo info -only applicationtype -app org.lifestreamprotocol.screen-capture | grep -q UIElement"
  started=$(date +%s)
  while ! running home && [ $(( $(date +%s) - started )) -lt 90 ]; do sleep 1; done
  for job in "${jobs[@]}"; do
    pid="$(pid_of "$job")"
    if [ -n "$pid" ]; then say "PASS $job runs after login: pid $pid, up $(seconds_up "$pid") s"; else say "FAIL $job does not run after login"; failed=1; fi
  done
  check "the door answers after login" answers http://127.0.0.1:4680/v1/status
  check "the home answers its socket after login" socket
  ;;
grants)
  rows="$(for db in "/Library/Application Support/com.apple.TCC/TCC.db" "$HOME/Library/Application Support/com.apple.TCC/TCC.db"; do
    sudo -n sqlite3 "$db" "select service, auth_value, auth_reason from access where client = 'org.lifestreamprotocol.screen-capture'"
  done)"
  say "privacy rows (service|allowed|reason): $(printf '%s' "$rows" | tr '\n' ' ')"
  check "no grant was answered by the person" sh -c "! printf '%s\n' '$rows' | grep -qE '\|(2|3)\$'"
  ;;
granted)
  rows="$(privacy_rows)" || exit 1
  if required_grants "$rows"; then
    printf '%s\n' "$rows" > "$grant_snapshot"
    say "PASS Screen Recording, Accessibility, Full Disk Access and Microphone are allowed"
  else
    say "FAIL the four required privacy grants are not all allowed"
    failed=1
  fi
  ;;
retained)
  rows="$(privacy_rows)" || exit 1
  check "the four privacy grants remain allowed" required_grants "$rows"
  check "the privacy grants and designated requirements survive replacement" sh -c \
    'printf "%s\n" "$1" | cmp -s "$2" -' sh "$rows" "$grant_snapshot"
  ;;
reset)
  "$app/Contents/MacOS/Lifestream" agents --set off
  rm -rf "$machine" "$HOME/Library/Logs/lifestream"
  say "reset: agents removed; the machine directory and the logs deleted"
  ;;
*)
  echo "usage: bash agent-proof.sh image [Lifestream.dmg] | app [/Applications/Lifestream.app] | run | update | paired | login | grants | granted | retained | reset" >&2
  exit 2
  ;;
esac
exit "$failed"
