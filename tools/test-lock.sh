#!/bin/bash
set -u
where=""
[ "${1:-}" != --where ] || { where=1; shift; }
whole=""
[ "${1:-}" != --whole ] || { whole=1; shift; }
[ $# -gt 0 ] || [ -n "$whole" ] || { echo "usage: tools/test-lock.sh [--where] <command…>, or tools/test-lock.sh --whole inside a run" >&2; exit 2; }
if [ -n "$whole" ]; then
  [ $# = 0 ] && [ -n "${LIFESTREAM_TEST_LOCKED:-}" ] && [ -n "${LIFESTREAM_TEST_RUN:-}" ] ||
    { echo "test-lock: --whole holds every test slot for a run already under the lock, until its input ends; it takes no command" >&2; exit 2; }
  [ -n "${LIFESTREAM_TEST_HELD:-}" ] ||
    { echo "test-lock: --whole: the lock this run is under names no slot of its own (an older test-lock.sh), so no slot is held" >&2; exit 2; }
fi
os=$(uname -s)
tools=$(dirname "$0")
mac_only() {
  root=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$root/testing/mac-only.txt" ] || return 1
  printf '%s\n' "$@" | awk -v root="$root/" -v prefix="$(git rev-parse --show-prefix)" '
    FILENAME != "-" { if ($0 !~ /^#/ && NF > 0) listed[$1] = 1; next }
    { arg = $0; sub(/^\.\//, "", arg)
      path = index(arg, root) == 1 ? substr(arg, length(root) + 1) : substr(arg, 1, 1) == "/" ? arg : prefix arg
      if ((arg in listed) || (path in listed)) { print path; found = 1; exit } }
    END { exit !found }' "$root/testing/mac-only.txt" -
}
if [ "${LIFESTREAM_TEST_EXCLUSIVE:-}" = 1 ] && [ -n "${LIFESTREAM_TEST_QUICK:-}" ]; then
  echo "test-lock: LIFESTREAM_TEST_EXCLUSIVE holds this Mac's slots, never the test server's: this run takes one" >&2
  unset LIFESTREAM_TEST_EXCLUSIVE
fi
wide() {
  case "$*" in *vitest.full.config.mts*) return 1 ;; esac
  vitest="" sub="" skip="" named="" folder=""
  for arg in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case $arg in
      vitest | */vitest | */vitest.mjs) vitest=1 ;;
      run) [ -z "$vitest" ] || sub=1 ;;
      --config | -c | -t | --testNamePattern | --project | --reporter | --shard) skip=1 ;;
      -*) ;;
      *) [ -n "$sub" ] || continue; named=1; [ ! -d "$arg" ] || folder=1 ;;
    esac
  done
  [ -n "$sub" ] && { [ -n "$folder" ] || [ -z "$named" ]; }
}
if [ -z "${LIFESTREAM_TEST_LOCKED:-}" ] && [ "${LIFESTREAM_TEST_WIDE:-}" != 1 ] && wide "$@"; then
  echo "test-lock: refused: a vitest run of a whole folder or of everything is the check's (npm run check). Name the test files your change reaches: git grep -l '<module or name>' -- '*.test.ts'. A run of a whole package on purpose: LIFESTREAM_TEST_WIDE=1." >&2
  exit 2
fi
here=""
if [ -n "${LIFESTREAM_TEST_LOCKED:-}${LIFESTREAM_TEST_HERE:-}" ] || [ "${LIFESTREAM_TEST_EXCLUSIVE:-}" = 1 ] || [ "$os" != Darwin ]; then here=1
else case ${1##*/} in node | npm | npx | tsx | vitest) ;; *) here=1 ;; esac; fi
if [ -z "$here" ] && [ -z "${LIFESTREAM_TEST_SERVER:-}" ] &&
  [ "$(ssh -G lstest 2>/dev/null | awk '$1 == "hostname" { print $2 }')" = lstest ]; then here=1; fi
[ -f "$tools/lstest.sh" ] || here=1
if [ -z "$here" ] && [ "${LIFESTREAM_FIXTURES:-}" = write ]; then
  here=1
  [ -n "$where" ] || echo "test-lock: runs here: LIFESTREAM_FIXTURES=write writes into this checkout" >&2
fi
if [ -z "$here" ] && [ "${LIFESTREAM_UPDATE_GOLDEN:-}" = 1 ]; then
  here=1
  [ -n "$where" ] || echo "test-lock: runs here: LIFESTREAM_UPDATE_GOLDEN=1 writes into this checkout" >&2
fi
if [ -z "$here" ] && listed=$(mac_only "$@"); then
  here=1
  [ -n "$where" ] || echo "test-lock: runs here: $listed is the Mac's own (testing/mac-only.txt)" >&2
fi
if [ -n "$where" ]; then
  if [ -z "$here" ] && why=$("$tools/lstest.sh" --probe); then echo server; else
    [ -z "${why:-}" ] || echo "$why" >&2
    echo here
  fi
  exit 0
fi
[ -n "$whole" ] || [ -z "${LIFESTREAM_TEST_LOCKED:-}" ] || exec "$@"
[ -n "$here" ] || exec "$tools/lstest.sh" "$@"

slots=${LIFESTREAM_TEST_SLOTS:-3}
general=""
n=1
while [ $n -le "$slots" ]; do general="$general $n"; n=$((n + 1)); done
quick=""
n=1
while [ $n -le "${LIFESTREAM_TEST_QUICK:-0}" ]; do if [ $n = 1 ]; then quick=quick; else quick="$quick quick$n"; fi; n=$((n + 1)); done
phones="phone phone2"
every="$general $quick $phones"
half=""
from=""
if [ -z "$whole" ]; then
[ "${1##*/}" = tsx ] && [ "${3:-}" = --run ] && case ${2:-} in tools/check.ts | */tools/check.ts) half=1 ;; esac
case "$*" in *vitest.full.config.mts*)
  half=1 sub="" skip=""
  for arg in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case $arg in
      run) sub=1 ;;
      --config | -c | -t | --testNamePattern | --project | --reporter | --shard) skip=1 ;;
      -*) ;;
      *) [ -z "$sub" ] || half="" ;;
    esac
  done ;;
esac
[ -n "$half" ] || ! wide "$@" || half=1
case ${LIFESTREAM_TEST_SLOT:-} in
  "") from=$general; [ -n "$half" ] || from="$quick $general" ;;
  phone) from=$phones ;;
  *) echo "tools/test-lock.sh: LIFESTREAM_TEST_SLOT is phone or unset, not $LIFESTREAM_TEST_SLOT" >&2; exit 2 ;;
esac
fi
if [ -n "$whole" ]; then tmp=$(dirname "$LIFESTREAM_TEST_RUN"); elif [ "$os" = Darwin ]; then tmp=/private/tmp; else tmp=${TMPDIR:-/tmp}; fi
dir=$tmp/lifestream-tests
mkdir -p "$dir" || exit 73
if [ "$os" = Darwin ]; then
  lock_now() { lockf -s -t 0 "$1"; }
  lock_wait() { lockf -s "$1"; }
else
  lock_now() { flock -n -E 75 "$1"; }
  lock_wait() { flock "$1"; }
fi
since() { s=$(($(date +%s) - $1)); echo "$((s / 60))m$((s % 60))s"; }
started() { echo $(ps -o lstart= -p "$1"); }
fd() { case $1 in phone) echo $((11 + slots)) ;; phone2) echo $((12 + slots)) ;; quick) echo $((13 + slots)) ;; quick*) echo $((12 + slots + ${1#quick})) ;; *) echo $((10 + $1)) ;; esac; }
open_slot() { eval "exec $(fd "$1")>>\"$dir/slot.$1.lock\""; }
drop_slot() { eval "exec $(fd "$1")>&-"; }
try_slot() {
  open_slot "$1"
  lock_now "$(fd "$1")"
  rc=$?
  [ $rc = 0 ] || [ $rc = 75 ] || exit $rc
  [ $rc = 0 ] || drop_slot "$1"
  return $rc
}
holders() {
  for m in "$@"; do
    { read -r at checkout command <"$dir/slot.$m.holder"; } 2>/dev/null && printf '  %s in %s, held %s\n' "$command" "$checkout" "$(since "$at")"
  done
}
whole_held() {
  exec 9>>"$dir/whole.lock"
  lock_now 9
  rc=$?
  exec 9>&-
  [ $rc = 75 ]
}
quiet() {
  { read -r pid at <"$dir/slot.$1.quiet"; } 2>/dev/null && [ -n "$at" ] && [ "$(started "$pid")" = "$at" ]
}
start=$(date +%s) held="" waited=""
if [ -n "$whole" ]; then
  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  waiting=$LIFESTREAM_TEST_RUN/.test-lock-waiting
  mine=$LIFESTREAM_TEST_HELD
  taken="" ours=""
  for n in $mine; do { read -r at checkout what <"$dir/slot.$n.holder"; } 2>/dev/null && break; done
  what="${what:-a run} (its timed asks, every slot)"
  give_back() {
    rm -f "$waiting"
    [ -z "$ours" ] || rm -f "$dir/slot.whole.holder"
    for n in $mine; do rm -f "$dir/slot.$n.quiet"; done
    for n in $taken; do rm -f "$dir/slot.$n.holder"; done
  }
  trap 'give_back; exit 129' HUP
  trap 'give_back; exit 130' INT
  trap 'give_back; exit 143' TERM
  : >"$waiting"
  for n in $mine; do echo "$$ $(started $$)" >"$dir/slot.$n.quiet"; done
  echo "test-lock: $(date +%T) this run takes every test slot for its timed asks; it holds slot $mine, quiet while it waits" >&2
  exec 9>>"$dir/whole.lock"
  lock_now 9
  rc=$?
  if [ $rc = 75 ]; then
    echo "test-lock: waiting for another run that holds every test slot for its timed asks:" >&2
    holders whole >&2
    lock_wait 9 || exit 75
  elif [ $rc != 0 ]; then exit $rc; fi
  ours=1
  echo "$(date +%s) $top $what" | cut -c1-200 >"$dir/slot.whole.holder"
  while :; do
    pending=""
    for n in $every; do
      case " $mine $taken " in *" $n "*) continue ;; esac
      if try_slot $n; then
        taken="$taken $n"
        echo "$(date +%s) $top $what" | cut -c1-200 >"$dir/slot.$n.holder"
      elif ! quiet $n; then pending="$pending $n"; fi
    done
    [ -n "$pending" ] || break
    [ -n "$waited" ] || { echo "test-lock: waiting for test slot$pending to free, held by:" >&2; holders $pending >&2; waited=1; }
    sleep 1
  done
  rm -f "$waiting"
  for n in $mine; do rm -f "$dir/slot.$n.quiet"; done
  whole_at=$(date +%s)
  echo "test-lock: $(date +%T) every test slot held, after $(since "$start") waiting (a wait the run's cap does not count)" >&2
  echo whole
  cat >/dev/null
  give_back
  echo "test-lock: $(date +%T) every test slot given back but the run's own, held whole $(since "$whole_at")" >&2
  exit 0
fi
if [ "${LIFESTREAM_TEST_EXCLUSIVE:-}" = 1 ]; then
  until [ -n "$held" ]; do
    for n in $every; do
      try_slot $n || break
      held="$held $n"
    done
    case " $held " in *" phone2 "*) break ;; esac
    for n in $held; do drop_slot $n; done
    held=""
    [ -n "$waited" ] || { echo "waiting for every test slot free at once (a run that measures), held by:" >&2; holders $every >&2; waited=1; }
    sleep 1
  done
else
  while :; do
    for n in $from; do try_slot $n && held=$n && break; done
    if [ -n "$held" ] && whole_held; then
      drop_slot $held
      held=""
      [ -n "$waited" ] || { echo "waiting: a run holds every test slot for its timed asks:" >&2; holders whole >&2; waited=1; }
    fi
    [ -z "$held" ] || break
    if [ -z "$waited" ]; then
      echo "waiting for test slot $(echo $from | awk '{ s = $1; for (i = 2; i <= NF; i++) s = s (i < NF ? ", " : " or ") $i; print s }'), all held by:" >&2
      holders $from >&2
      waited=1
    fi
    sleep 1
  done
fi
took=$(date +%s)
[ -z "$waited" ] || echo "test slot after $(since "$start")" >&2

if [ "$os" = Darwin ]; then every_process=-axww environment=-E; else every_process=-eww environment=e; fi
kill_named() {
  tree=" $$ " p=$$
  while p=$(ps -o ppid= -p "$p" | tr -d ' ') && [ "${p:-1}" -gt 1 ]; do tree="$tree$p "; done
  list=$(ps $every_process -o pid=,pgid=,command=; echo --; unset TMPDIR LIFESTREAM_TEST_RUN; ps $every_process $environment -o pid=,pgid=,command=)
  left=$(printf '%s\n' "$list" | awk -v at="$1" -v groups=" $2 " -v tree="$tree" '
    BEGIN { folders = split(at, folder, " ") }
    $0 == "--" { env = 1; next }
    index(tree, " " $1 " ") == 0 { named = !env && index(groups, " " $2 " ")
      for (i = 1; i <= folders; i++) named = named || (env ? index($0, " TMPDIR=" folder[i]) || index($0, " LIFESTREAM_TEST_RUN=" folder[i]) : index($0, folder[i]))
      if (named && !($1 in left)) { n = split($3, path, "/"); left[$1] = path[n]; print $1, path[n] } }')
  [ -n "$left" ] || return 0
  for group in $2; do kill -9 -"$group" 2>/dev/null || :; done
  kill -9 $(printf '%s\n' "$left" | cut -d' ' -f1) 2>/dev/null
  n=$(printf '%s\n' "$left" | wc -l | tr -d ' ')
  echo "$3 $n process$([ "$n" = 1 ] || echo es) $4: $(printf '%s\n' "$left" | cut -d' ' -f2 | tr '\n' ' ')" >&2
}
exec 10>>"$dir/sweep.lock"
lock_wait 10 || exit 75
stale="" groups=""
for folder in "$tmp"/lstest-*.r; do
  [ -d "$folder" ] || continue
  owner=${folder#"$tmp"/lstest-}
  owner=${owner%.r}
  { read -r at <"$folder/owner"; } 2>/dev/null || at=""
  [ "$owner" != $$ ] && ps -p "$owner" >/dev/null 2>&1 && { [ -z "$at" ] || [ "$(started "$owner")" = "$at" ]; } && continue
  stale="$stale $folder"
  { read -r group at <"$folder/pgid"; } 2>/dev/null && [ -n "$at" ] && [ "$(started "$group")" = "$at" ] && groups="$groups $group"
done
if [ -n "$stale" ]; then
  kill_named "$stale" "$groups" swept "a killed run left"
  rm -rf $stale
fi

run=$tmp/lstest-$$.r
mkdir "$run" || exit 73
started $$ >"$run/owner"
exec 10>&-
if [ "$os" = Darwin ]; then cache=$HOME/Library/Caches/lifestream-tests; else cache=$HOME/.cache/lifestream-tests; fi
export TMPDIR="$run" LIFESTREAM_TEST_RUN="$run" LIFESTREAM_TEST_LOCKED=1 LIFESTREAM_TEST_HELD="$(echo $held)" NODE_COMPILE_CACHE="$cache/node-compile"
for n in $held; do case $n in phone | phone2) export LIFESTREAM_TEST_PHONE="$n"; break ;; esac; done
what="$*"
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
for n in $held; do echo "$(date +%s) $top $what" | cut -c1-200 >"$dir/slot.$n.holder"; done
if [ -n "${LIFESTREAM_TEST_LOG:-}" ]; then log=$LIFESTREAM_TEST_LOG
else log=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && log=$(dirname "$log")/.build && mkdir -p "$log" 2>/dev/null && log=$log/test-runs.tsv || log=""; fi
if [ "$os" = Darwin ]; then
  load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }')
  read -r compressed spare <<EOF
$(vm_stat 2>/dev/null | awk '/page size of/ { size = $8 }
  /^Pages occupied by compressor:/ { compressed = $NF } /^Pages (free|inactive|speculative):/ { spare += $NF }
  END { if (size) printf "%.0f %.0f", compressed * size / 1048576, spare * size / 1048576 }')
EOF
  swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "used") { v = $(i + 2); u = substr(v, length(v)); v += 0
    if (u == "G") v *= 1024; else if (u == "K") v /= 1024; printf "%.0f", v } }')
else
  load=$(cut -d' ' -f1 /proc/loadavg)
  read -r compressed spare swap <<EOF
$(awk '/^Zswap:/ { z = $2 } /^MemAvailable:/ { a = $2 } /^SwapTotal:/ { t = $2 } /^SwapFree:/ { f = $2 }
  END { printf "%.0f %.0f %.0f", z / 1024, a / 1024, (t - f) / 1024 }' /proc/meminfo)
EOF
fi
holding=$(echo $held | tr ' ' ,)
cmdline=$(printf '%s' "$what" | tr '\t\n' '  ' | cut -c1-200)
job="" cap_watch=""
cap=${LIFESTREAM_TEST_CAP:-2700}
began=$(date +%s)
finish() {
  trap '' INT TERM HUP
  ended=$(date +%s)
  if [ -n "$job" ] && kill -0 "$job" 2>/dev/null; then
    kill -TERM -"$job" 2>/dev/null
    i=0
    while kill -0 "$job" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  fi
  [ -z "$cap_watch" ] || { kill "$cap_watch" && wait "$cap_watch"; } 2>/dev/null
  kill_named "$run" "$job" reaped "the run left"
  [ -z "$job" ] || wait "$job" 2>/dev/null
  if [ "${LIFESTREAM_KEEP_ARTIFACTS:-}" = 1 ]; then
    kept=$tmp/lifestream-kept-$$-$(date +%s)
    mv "$run" "$kept" && echo "the run's temporary files are kept in $kept" >&2
  else rm -rf "$run"; fi
  for n in $held; do rm -f "$dir/slot.$n.holder"; done
  [ -z "$log" ] || { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$took" "$((took - start))" "$((ended - began))" "$1" \
    "$holding" "$load" "$compressed" "$spare" "$swap" "${top##*/}" "$cmdline" >>"$log"; } 2>/dev/null
  exit "$1"
}
trap 'finish 129' HUP
trap 'finish 130' INT
trap 'finish 143' TERM
closes=""
for n in $every; do closes="$closes $(fd $n)>&-"; done
if [ "$os" = Darwin ]; then
  set -m
  eval "nice -n 19 \"\$@\" </dev/null $closes &"
  job=$!
  set +m
else
  eval "setsid nice -n 19 \"\$@\" </dev/null $closes &"
  job=$!
fi
echo "$job $(started "$job")" >"$run/pgid"
eval "env -u TMPDIR -u LIFESTREAM_TEST_RUN sh -c 'w=0; while [ \$w -lt \$1 ] && kill -0 \$2 2>/dev/null; do sleep 5; [ -e \"\$3/.test-lock-waiting\" ] || w=\$((w + 5)); done
  kill -0 \$2 2>/dev/null && { echo \"test-lock: cut after \$1 s (LIFESTREAM_TEST_CAP)\" >&2; : >\"\$3/.test-lock-cut\"; kill -TERM -\$2; }' cap \"\$cap\" \"\$job\" \"\$run\" </dev/null $closes &"
cap_watch=$!
wait "$job"
finish $?
