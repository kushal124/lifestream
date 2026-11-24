#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

runtime=com.apple.CoreSimulator.SimRuntime.iOS-26-0
os="iOS 26.0"
type=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro
template="iPhone 16 Pro template $os"
lock=/tmp/lifestream-simulator-template.lock

named() {
  xcrun simctl list devices | awk -v section="$2" -v prefix="    $1 (" \
    '/^-- / { inside = (section == "" || $0 == "-- " section " --") } inside && index($0, prefix) == 1 { print substr($0, length(prefix) + 1, 36) }'
}

boot_limit=180
booted() {
  xcrun simctl bootstatus "$1" -b >/dev/null &
  local waiting=$!
  SECONDS=0
  while kill -0 "$waiting" 2>/dev/null; do
    if [ "$SECONDS" -ge "$boot_limit" ]; then
      kill "$waiting" 2>/dev/null || true
      wait "$waiting" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  wait "$waiting"
}
boot() {
  booted "$1" && return 0
  echo "simulator.sh: $1 did not finish booting in $boot_limit s; booting it again" >&2
  xcrun simctl shutdown "$1" >/dev/null 2>&1 || true
  booted "$1" && return 0
  echo "simulator.sh: $1 did not finish booting in $boot_limit s, twice" >&2
  return 1
}
if [ "${1:-}" = boot ]; then
  boot "$2"
  exit
fi

if [ "${1:-}" = template ]; then
  for left in $(named "$template (making)" ""); do xcrun simctl delete "$left"; done
  udid=$(named "$template" "$os" | head -1)
  if [ -z "$udid" ]; then
    udid=$(xcrun simctl create "$template (making)" "$type" "$runtime")
    boot "$udid"
    SECONDS=0
    until xcrun simctl spawn "$udid" log show --last 5m --style compact --predicate 'eventMessage CONTAINS "scheme family"' 2>/dev/null \
      | grep -q "scheme family"; do
      if [ "$SECONDS" -ge 120 ]; then
        echo "simulator.sh: the template booted 2 min without iOS opening Family; its clones may open it" >&2
        break
      fi
      sleep 2
    done
    xcrun simctl shutdown "$udid"
    xcrun simctl rename "$udid" "$template"
  fi
  echo "$udid"
  exit 0
fi

if ! xcrun simctl list runtimes | grep -qF "$runtime"; then
  echo "MISSING: the $os simulator runtime: xcodebuild -downloadPlatform iOS -buildVersion 26.0" >&2
  exit 1
fi
case ${LIFESTREAM_TEST_PHONE:-} in
  phone) simulator="iPhone 16 Pro tests" ;;
  phone2) simulator="iPhone 16 Pro tests 2" ;;
  "") simulator="iPhone 16 Pro by hand" ;;
  *)
    echo "simulator.sh: LIFESTREAM_TEST_PHONE=$LIFESTREAM_TEST_PHONE names no phone slot (phone, phone2)" >&2
    exit 1
    ;;
esac
if [ "${1:-}" = worker ]; then
  case ${2:-} in
    [2-9]) ;;
    *)
      echo "simulator.sh: worker takes a number from 2 to 9, the slot's own simulator being the first" >&2
      exit 64
      ;;
  esac
  slot_udid=$("$PWD/simulator.sh")
  worker="$simulator, worker $2"
  udid=$(named "$worker" "$os" | head -1)
  if [ -z "$udid" ]; then
    for stale in $(named "$worker" ""); do xcrun simctl delete "$stale"; done
    xcrun simctl shutdown "$slot_udid" >/dev/null 2>&1 || true
    udid=$(xcrun simctl clone "$slot_udid" "$worker")
  fi
  echo "$udid"
  exit 0
fi
udid=$(named "$simulator" "$os" | head -1)
if [ -z "$udid" ]; then
  for stale in $(named "$simulator" ""); do xcrun simctl delete "$stale"; done
  source_udid=$(lockf -k "$lock" "$PWD/simulator.sh" template)
  udid=$(xcrun simctl clone "$source_udid" "$simulator")
fi
echo "$udid"
