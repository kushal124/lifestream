#!/usr/bin/env python3
"""What the Mac app costs the Mac, from the three accounts in <spool>/resources/.

Reads the app's own account (app-<day>.jsonl; a keyed Mac's is a keyed log, skipped), the watcher's (watch-<day>.jsonl) and
macOS's power log copy (powerlog/coalitions-<day>.jsonl, powerlog/battery-<day>.jsonl);
writes nothing. Prints aggregates only: the app's own numbers and the Mac's totals, never
another app's name. Per bucket: the app's watts three ways, its share of the Mac's measured
power, each part's CPU and share with the unattributed rest, cost per unit of work, flushes
and bytes written, and wakeups. The lines it reads are
Sources/ResourceWatch/README.md's.

- Minutes join on the wall-clock minute; `day` and `hour` are UTC. A coalition interval is
  shared among the minutes it overlaps in proportion.
- macOS's watts are `energy` + `ane_energy_nj` + `gpu_energy_nj` + `energy_billed_to_me`, over
  the minutes the copied rows cover. `proc_pid_rusage`'s energy is the processor's alone, so the
  disagreement check sets the app's and the watcher's against the coalition's `energy`, and
  flags accounts that differ by more than 10 %, because a disagreement means one is wrong.
- Two accounts are compared only on the minutes both state.
- A minute's state is what held for most of it: `asleep`, `display-off`, `locked`, `capturing`
  or `not-capturing`, then `battery` or `ac`, then `low-power` and `thermal-<level>` when they
  held; its front app is the one in front longest.
- Each unit of work is paid by its parts (`WORK_UNITS`): a frame by the capture parts, a raw
  input event by the `input_` parts, a shipped bundle by the `shipping` parts, an audio minute
  by the `audio_` parts.
- A regression is a part whose cost per unit rose more than 20 % between consecutive builds, on
  the states and front apps both ran in, the later build's cost per unit weighted by the earlier
  build's units, with at least ten units on each side.

    python3 macos-app/benchmarks/resources-report.py --by build
    python3 macos-app/benchmarks/resources-report.py --since 2026-10-03T00:00:00Z --by state
"""
import argparse
import collections
import datetime as dt
import json
import math
from pathlib import Path
import sys

APP_BUNDLE = 'org.lifestreamprotocol.screen-capture'
DEFAULT_STORE = Path.home() / 'Library/Application Support/Lifestream Screen'
DISAGREEMENT = 0.10
REGRESSION = 0.20
MINIMUM_UNITS = 10

WORK_UNITS = {
    'frame': (('capture', 'ocr', 'accessibility', 'browser_pages', 'publish', 'video_compaction',
               'text_compaction'), lambda counts: counts.get('frames', 0)),
    'input event': (('input_tap', 'input_log', 'input_lookup'),
                    lambda counts: counts.get('input_events_raw', 0)),
    'shipped bundle': (('shipping',), lambda counts: counts.get('bundles_shipped', 0)),
    'audio minute': (('audio_mic', 'audio_sound'),
                     lambda counts: (counts.get('audio_mic_ms', 0) + counts.get('audio_sound_ms', 0)) / 60000),
}


def instant(spelling):
    return dt.datetime.fromisoformat(spelling.replace('Z', '+00:00')).timestamp()


def spelling(seconds):
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def lines(paths):
    for path in sorted(paths):
        try:
            texts = path.read_bytes().decode('utf-8').splitlines()
        except UnicodeDecodeError:
            continue
        for text in texts:
            text = text.strip()
            if not text:
                continue
            try:
                yield json.loads(text)
            except json.JSONDecodeError:
                continue


def rows(paths):
    """Power-log rows, each once: a crash may copy a row twice, under the same ID and timestamp."""
    seen = set()
    for row in lines(paths):
        key = (row.get('ID'), row.get('timestamp'))
        if key in seen or 'timestamp' not in row:
            continue
        seen.add(key)
        yield row


def part_family(name):
    return 'shipping' if name.startswith('shipping') else name


class Slot:
    """One wall-clock minute: the app's line, the watcher's, and macOS's rows over it."""

    def __init__(self, minute):
        self.minute = minute
        self.app = None
        self.watch = None
        self.macos = collections.Counter()
        self.coalitions = 0.0
        self.system_power = []
        self.macos_covered = False

    def interval(self):
        line = self.app or self.watch
        return instant(line['at']), instant(line['until'])

    def seconds(self):
        start, end = self.interval()
        return max(0.0, end - start)

    def build(self):
        if self.app:
            return self.app.get('build', 'unknown')
        if self.watch and self.watch.get('app'):
            return self.watch['app'].get('build', 'unknown')
        return 'none'

    def state(self):
        """The state the Mac was in for most of the minute."""
        if not self.app:
            return 'unknown'
        state = self.app.get('state', {})
        half = self.seconds() / 2
        if state.get('awake_s', 0) < half:
            activity = 'asleep'
        elif state.get('display_awake_s', 0) < half:
            activity = 'display-off'
        elif state.get('unlocked_s', 0) < half:
            activity = 'locked'
        elif state.get('capturing_s', 0) >= half:
            activity = 'capturing'
        else:
            activity = 'not-capturing'
        label = [activity, 'battery' if state.get('on_battery_s', 0) >= half else 'ac']
        if state.get('low_power_s', 0) >= half:
            label.append('low-power')
        if state.get('thermal_max', 'nominal') != 'nominal':
            label.append('thermal-' + state['thermal_max'])
        return '/'.join(label)

    def front(self):
        front = (self.app or {}).get('state', {}).get('front') or {}
        return max(sorted(front), key=lambda name: front[name]) if front else 'unknown'


def load(store, since):
    resources = store / 'resources'
    slots = {}

    def slot(line):
        start = instant(line['at'])
        if since is not None and instant(line['until']) <= since:
            return None
        minute = int(start // 60 * 60)
        return slots.setdefault(minute, Slot(minute))

    for line in lines(resources.glob('app-*.jsonl')):
        if (target := slot(line)) is not None:
            target.app = line
    for line in lines(resources.glob('watch-*.jsonl')):
        if (target := slot(line)) is not None:
            target.watch = line

    covered = [math.inf, -math.inf]
    ordered = sorted(slots)
    for row in rows((resources / 'powerlog').glob('coalitions-*.jsonl')):
        start = instant(row['timestamp'])
        end = instant(row['timestampEnd']) if 'timestampEnd' in row else start
        covered[0], covered[1] = min(covered[0], start), max(covered[1], end)
        if end <= start:
            continue
        ours = row.get('bundle_id') == APP_BUNDLE
        total = row.get('energy', 0) + row.get('ane_energy_nj', 0) + row.get('gpu_energy_nj', 0)
        minute = int(start // 60 * 60)
        while minute < end:
            target = slots.get(minute)
            if target is not None:
                low, high = target.interval()
                share = max(0.0, min(end, high) - max(start, low)) / (end - start)
                if share > 0:
                    target.coalitions += total * share
                    if ours:
                        for key in ('energy', 'ane_energy_nj', 'gpu_energy_nj', 'energy_billed_to_me',
                                    'energy_billed_to_others', 'cpu_time', 'interrupt_wakeups',
                                    'platform_idle_wakeups', 'byteswritten'):
                            target.macos[key] += row.get(key, 0) * share
            minute += 60
    for target in slots.values():
        low, high = target.interval()
        target.macos_covered = covered[0] <= low and high <= covered[1]
    for row in rows((resources / 'powerlog').glob('battery-*.jsonl')):
        if 'SystemPower' not in row:
            continue
        moment = instant(row['timestamp'])
        target = slots.get(int(moment // 60 * 60))
        if target is not None:
            low, high = target.interval()
            if low <= moment < high:
                target.system_power.append(row['SystemPower'])
    return [slots[minute] for minute in ordered]


class Bucket:
    def __init__(self):
        self.minutes = 0
        self.seconds = 0.0
        self.app_seconds = 0.0
        self.watch_app_seconds = 0.0
        self.watch_seconds = 0.0
        self.macos_seconds = 0.0
        self.mac_seconds = 0.0
        self.mac_mw_seconds = 0.0
        self.powerlog_watts = []
        self.coalition_nj = 0.0
        self.own = collections.Counter()
        self.helper = collections.Counter()
        self.watched = collections.Counter()
        self.macos = collections.Counter()
        self.parts = collections.defaultdict(collections.Counter)
        self.counts = collections.Counter()
        self.watcher = collections.Counter()
        self.pairs = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])

    def pair(self, slot):
        """Each account's total and seconds in this minute, per measure, where it has one: watts
        as joules, CPU as milliseconds times sixty, so a total over seconds is ms per minute."""
        accounts = {'app watts': {}, 'app cpu': {}, 'mac watts': {}}
        if slot.app:
            process, seconds = slot.app.get('process', {}), slot.seconds()
            accounts['app watts']['own'] = (process.get('energy_nj', 0) / 1e9, seconds)
            accounts['app cpu']['own'] = (process.get('cpu_ns', 0) / 1e6 * 60, seconds)
            helper = slot.app.get('helper', {})
            accounts['app watts']['own with helper'] = (
                (process.get('energy_nj', 0) + helper.get('energy_nj', 0)) / 1e9, seconds)
            accounts['app cpu']['own with helper'] = (
                (process.get('cpu_ns', 0) + helper.get('cpu_ns', 0)) / 1e6 * 60, seconds)
        if slot.watch:
            seconds = max(0.0, instant(slot.watch['until']) - instant(slot.watch['at']))
            if slot.watch.get('app'):
                process = slot.watch['app'].get('process', {})
                accounts['app watts']['watcher'] = (process.get('energy_nj', 0) / 1e9, seconds)
                accounts['app cpu']['watcher'] = (process.get('cpu_ns', 0) / 1e6 * 60, seconds)
            mac = slot.watch.get('mac') or {}
            if mac.get('system_power_mw') is not None:
                accounts['mac watts']['watcher'] = (mac['system_power_mw'] / 1000 * seconds, seconds)
        if slot.macos_covered:
            macos, seconds = slot.macos, slot.seconds()
            accounts['app watts']['macos energy'] = (macos['energy'] / 1e9, seconds)
            accounts['app cpu']['macos'] = (macos['cpu_time'] * 1000 * 60, seconds)
        if slot.system_power:
            seconds = slot.seconds()
            accounts['mac watts']['power_log'] = (sum(slot.system_power) / len(slot.system_power) * seconds, seconds)
        for measure, values in accounts.items():
            names = list(values)
            for index, first in enumerate(names):
                for second in names[index + 1:]:
                    if 'with helper' in first + second and not (first + second).count('macos'):
                        continue
                    totals = self.pairs[(measure, first, second)]
                    totals[0] += values[first][0]
                    totals[1] += values[first][1]
                    totals[2] += values[second][0]
                    totals[3] += values[second][1]

    def add(self, slot):
        self.pair(slot)
        seconds = slot.seconds()
        self.minutes += 1
        self.seconds += seconds
        if slot.app:
            self.app_seconds += seconds
            process = slot.app.get('process', {})
            for key in ('cpu_ns', 'energy_nj', 'interrupt_wakeups', 'idle_wakeups', 'disk_write_bytes',
                        'logical_write_bytes'):
                self.own[key] += process.get(key, 0)
                self.helper[key] += slot.app.get('helper', {}).get(key, 0)
            for name, work in slot.app.get('work', {}).items():
                for key in ('cpu_ns', 'wall_ns', 'n'):
                    self.parts[name][key] += work.get(key, 0)
            self.counts.update(slot.app.get('counts', {}))
        if slot.watch:
            watched = max(0.0, instant(slot.watch['until']) - instant(slot.watch['at']))
            self.watch_seconds += watched
            self.watcher.update(slot.watch.get('watcher', {}))
            if slot.watch.get('app'):
                self.watch_app_seconds += watched
                process = slot.watch['app'].get('process', {})
                for key in ('cpu_ns', 'energy_nj', 'interrupt_wakeups', 'idle_wakeups'):
                    self.watched[key] += process.get(key, 0)
            mac = slot.watch.get('mac') or {}
            if mac.get('system_power_mw') is not None:
                self.mac_seconds += watched
                self.mac_mw_seconds += mac['system_power_mw'] * watched
        if slot.macos_covered:
            self.macos_seconds += seconds
            self.macos.update(slot.macos)
            self.coalition_nj += slot.coalitions
        self.powerlog_watts.extend(slot.system_power)

    def report(self):
        def watts(nanojoules, seconds):
            return nanojoules / 1e9 / seconds if seconds else None

        def per_minute(value, seconds):
            return value * 60 / seconds if seconds else None

        macos_nj = self.macos['energy'] + self.macos['ane_energy_nj'] + self.macos['gpu_energy_nj']
        mac_w = self.mac_mw_seconds / 1000 / self.mac_seconds if self.mac_seconds else None
        own_w = watts(self.own['energy_nj'], self.app_seconds)
        result = {
            'helper': {
                'watts': watts(self.helper['energy_nj'], self.app_seconds),
                'cpu_ms_per_minute': per_minute(self.helper['cpu_ns'] / 1e6, self.app_seconds),
                'app_with_helper_watts': watts(self.own['energy_nj'] + self.helper['energy_nj'], self.app_seconds),
            },
            'minutes': self.minutes,
            'hours': round(self.seconds / 3600, 3),
            'app_watts': {
                'own': own_w,
                'watcher': watts(self.watched['energy_nj'], self.watch_app_seconds),
                'macos': watts(macos_nj + self.macos['energy_billed_to_me'], self.macos_seconds),
                'macos_parts': {
                    'energy': watts(self.macos['energy'], self.macos_seconds),
                    'ane': watts(self.macos['ane_energy_nj'], self.macos_seconds),
                    'gpu': watts(self.macos['gpu_energy_nj'], self.macos_seconds),
                    'billed_to_me': watts(self.macos['energy_billed_to_me'], self.macos_seconds),
                    'billed_to_others': watts(self.macos['energy_billed_to_others'], self.macos_seconds),
                },
            },
            'app_cpu_ms_per_minute': {
                'own': per_minute(self.own['cpu_ns'] / 1e6, self.app_seconds),
                'watcher': per_minute(self.watched['cpu_ns'] / 1e6, self.watch_app_seconds),
                'macos': per_minute(self.macos['cpu_time'] * 1000, self.macos_seconds),
            },
            'mac_watts': {
                'watcher': mac_w,
                'power_log': sum(self.powerlog_watts) / len(self.powerlog_watts) if self.powerlog_watts else None,
                'all_coalitions': watts(self.coalition_nj, self.macos_seconds),
            },
            'app_share_of_mac': (own_w if own_w is not None else watts(self.watched['energy_nj'], self.watch_app_seconds)) / mac_w
            if mac_w and (own_w is not None or self.watch_app_seconds) else None,
            'app_share_of_coalitions': (macos_nj / self.coalition_nj) if self.coalition_nj else None,
        }
        total_cpu = self.own['cpu_ns']
        parts = {}
        for name in sorted(self.parts):
            part = self.parts[name]
            parts[name] = {
                'cpu_ms_per_minute': per_minute(part['cpu_ns'] / 1e6, self.app_seconds),
                'share': part['cpu_ns'] / total_cpu if total_cpu else None,
                'cpu_ms_per_unit': part['cpu_ns'] / 1e6 / part['n'] if part['n'] else None,
                'units': part['n'],
            }
        attributed = sum(part['cpu_ns'] for part in self.parts.values())
        parts['unattributed'] = {
            'cpu_ms_per_minute': per_minute(max(0, total_cpu - attributed) / 1e6, self.app_seconds),
            'share': max(0, total_cpu - attributed) / total_cpu if total_cpu else None,
        }
        result['parts'] = parts
        per_unit = {}
        for unit, (families, count) in WORK_UNITS.items():
            units = count(self.counts)
            cpu = sum(part['cpu_ns'] for name, part in self.parts.items() if part_family(name) in families)
            per_unit[unit] = {'units': units, 'cpu_ms': cpu / 1e6 / units if units else None}
        result['per_unit'] = per_unit
        result['writes_per_minute'] = {
            key: per_minute(self.counts[key], self.app_seconds)
            for key in ('flush_full', 'flush_barrier', 'flush_data', 'bytes_written')
        }
        result['writes_per_minute']['disk_write_bytes'] = per_minute(self.own['disk_write_bytes'], self.app_seconds)
        result['writes_per_minute']['logical_write_bytes'] = per_minute(self.own['logical_write_bytes'], self.app_seconds)
        result['wakeups_per_minute'] = {
            'own': per_minute(self.own['interrupt_wakeups'] + self.own['idle_wakeups'], self.app_seconds),
            'watcher': per_minute(self.watched['interrupt_wakeups'] + self.watched['idle_wakeups'],
                                  self.watch_app_seconds),
            'macos': per_minute(self.macos['interrupt_wakeups'] + self.macos['platform_idle_wakeups'],
                                self.macos_seconds),
        }
        result['watcher_cost'] = {
            'cpu_ms_per_minute': per_minute(self.watcher['cpu_ns'] / 1e6, self.watch_seconds),
            'core_share': self.watcher['cpu_ns'] / 1e9 / self.watch_seconds if self.watch_seconds else None,
            'watts': watts(self.watcher['energy_nj'], self.watch_seconds),
        }
        result['disagreements'] = self.disagreements()
        return result

    def disagreements(self):
        """Where two accounts of the same thing differ by more than 10 % of the larger, on the
        minutes both state."""
        found = []
        for (measure, first, second), (a_total, a_seconds, b_total, b_seconds) in self.pairs.items():
            if not a_seconds or not b_seconds:
                continue
            a, b = a_total / a_seconds, b_total / b_seconds
            larger = max(abs(a), abs(b))
            if larger and abs(a - b) / larger > DISAGREEMENT:
                found.append({'measure': measure, 'accounts': [first, second], 'values': [a, b],
                              'difference': abs(a - b) / larger, 'hours': round(min(a_seconds, b_seconds) / 3600, 3)})
        return found


def regressions(slots):
    """A part whose CPU per unit rose more than 20 % from one build to the next, on matching
    minutes: the same state and front app. The later build's cost is weighted by the earlier
    build's units in each stratum, so a different mix of minutes is not a regression."""
    builds = []
    by_build = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)))
    for slot in slots:
        if not slot.app:
            continue
        build = slot.build()
        if build not in builds:
            builds.append(build)
        stratum = (slot.state(), slot.front())
        for name, work in slot.app.get('work', {}).items():
            by_build[build][name][stratum]['cpu_ns'] += work.get('cpu_ns', 0)
            by_build[build][name][stratum]['n'] += work.get('n', 0)
    found = []
    for before, after in zip(builds, builds[1:]):
        for name in sorted(set(by_build[before]) & set(by_build[after])):
            earlier, later = by_build[before][name], by_build[after][name]
            common = [s for s in earlier if earlier[s]['n'] and later.get(s, {}).get('n')]
            weight = sum(earlier[s]['n'] for s in common)
            if weight < MINIMUM_UNITS or sum(later[s]['n'] for s in common) < MINIMUM_UNITS:
                continue
            old = sum(earlier[s]['cpu_ns'] for s in common) / weight
            new = sum(earlier[s]['n'] * later[s]['cpu_ns'] / later[s]['n'] for s in common) / weight
            if old and new / old - 1 > REGRESSION:
                found.append({'part': name, 'from': before, 'to': after,
                              'cpu_ms_per_unit': [old / 1e6, new / 1e6], 'rise': new / old - 1,
                              'strata': len(common)})
    return found


def key_for(slot, by):
    if by == 'day':
        return spelling(slot.minute)[:10]
    if by == 'hour':
        return spelling(slot.minute)[:13] + ':00Z'
    if by == 'build':
        return slot.build()
    if by == 'state':
        return slot.state()
    return slot.front()


def report(store, since=None, build=None, by='build'):
    slots = load(store, since)
    selected = [slot for slot in slots if build is None or slot.build() == build]
    buckets = collections.OrderedDict()
    for slot in selected:
        buckets.setdefault(key_for(slot, by), Bucket()).add(slot)
    total = Bucket()
    for slot in selected:
        total.add(slot)
    found = regressions(slots)
    if build is not None:
        found = [item for item in found if build in (item['from'], item['to'])]
    return {'by': by, 'buckets': {name: bucket.report() for name, bucket in buckets.items()},
            'total': total.report(), 'regressions': found}


def number(value, digits=2, unit=''):
    return '-' if value is None else f'{value:.{digits}f}{unit}'


def percent(value):
    return '-' if value is None else f'{value * 100:.1f} %'


def show(name, item):
    watts, cpu, mac = item['app_watts'], item['app_cpu_ms_per_minute'], item['mac_watts']
    parts = item['app_watts']['macos_parts']
    print(f'== {name}: {item["minutes"]} minutes, {item["hours"]} h')
    print(f'  app watts: own {number(watts["own"], 3)}  watcher {number(watts["watcher"], 3)}  '
          f'macOS {number(watts["macos"], 3)} (energy {number(parts["energy"], 3)} + ANE {number(parts["ane"], 3)} '
          f'+ GPU {number(parts["gpu"], 3)} + billed to it {number(parts["billed_to_me"], 3)}; '
          f'it billed others {number(parts["billed_to_others"], 3)})')
    print(f'  Mac watts: watcher {number(mac["watcher"])}  power log {number(mac["power_log"])}  '
          f'all coalitions {number(mac["all_coalitions"])}; app share of the Mac {percent(item["app_share_of_mac"])}, '
          f'of all coalitions {percent(item["app_share_of_coalitions"])}')
    print(f'  app CPU ms/min: own {number(cpu["own"], 1)}  watcher {number(cpu["watcher"], 1)}  '
          f'macOS {number(cpu["macos"], 1)}')
    helper = item['helper']
    if helper['cpu_ms_per_minute']:
        print(f'  recognition helper: {number(helper["watts"], 3)} W, {number(helper["cpu_ms_per_minute"], 1)} CPU ms/min; '
              f'app with helper {number(helper["app_with_helper_watts"], 3)} W (macOS counts both)')
    if len(item['parts']) > 1:
        print('  parts (CPU ms/min, share, ms per unit):')
        for part, value in sorted(item['parts'].items(), key=lambda pair: -(pair[1]['cpu_ms_per_minute'] or 0)):
            print(f'    {part:<20} {number(value["cpu_ms_per_minute"], 1):>9}  {percent(value["share"]):>7}  '
                  f'{number(value.get("cpu_ms_per_unit"), 3)}')
    units = '  '.join(f'{unit} {number(value["cpu_ms"], 3)} ms' for unit, value in item['per_unit'].items()
                      if value['units'])
    if units:
        print(f'  CPU per unit of work: {units}')
    writes = item['writes_per_minute']
    if any(value for value in writes.values()):
        print(f'  writes/min: flushes full {number(writes["flush_full"], 1)} barrier {number(writes["flush_barrier"], 1)} '
              f'data {number(writes["flush_data"], 1)}; bytes counted {number(writes["bytes_written"], 0)}, '
              f'disk {number(writes["disk_write_bytes"], 0)}, logical {number(writes["logical_write_bytes"], 0)}')
    wakeups = item['wakeups_per_minute']
    print(f'  wakeups/min: own {number(wakeups["own"], 0)}  watcher {number(wakeups["watcher"], 0)}  '
          f'macOS {number(wakeups["macos"], 0)}')
    cost = item['watcher_cost']
    print(f'  the watcher itself: {number(cost["cpu_ms_per_minute"], 2)} CPU ms/min '
          f'({percent(cost["core_share"])} of a core), {number(cost["watts"], 4)} W')
    for found in item['disagreements']:
        first, second = found['accounts']
        print(f'  DISAGREE {found["measure"]}: {first} {number(found["values"][0], 3)} vs {second} '
              f'{number(found["values"][1], 3)} ({percent(found["difference"])}) over {found["hours"]} h they share; '
              'one of them is wrong')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--store', type=Path, default=DEFAULT_STORE, help='the spool; reads <store>/resources')
    parser.add_argument('--since', help='an RFC 3339 instant; minutes ending after it')
    parser.add_argument('--build', help='only minutes of this build')
    parser.add_argument('--by', choices=('day', 'hour', 'build', 'state', 'front'), default='build')
    parser.add_argument('--json', action='store_true', help='one JSON document instead of text')
    arguments = parser.parse_args(argv)
    since = instant(arguments.since) if arguments.since else None
    result = report(arguments.store, since, arguments.build, arguments.by)
    if arguments.json:
        json.dump(result, sys.stdout, indent=1, sort_keys=True)
        print()
        return
    if not result['buckets']:
        print('No minutes in', arguments.store / 'resources')
        return
    for name, item in result['buckets'].items():
        show(name, item)
    if len(result['buckets']) > 1:
        show('all', result['total'])
    for found in result['regressions']:
        print(f'REGRESSION {found["part"]}: {number(found["cpu_ms_per_unit"][0], 3)} -> '
              f'{number(found["cpu_ms_per_unit"][1], 3)} CPU ms per unit from {found["from"]} to {found["to"]} '
              f'(+{percent(found["rise"])}, {found["strata"]} matching states)')


if __name__ == '__main__':
    main()
