"""resources-report.py on synthetic spools: the three accounts written as
Sources/ResourceWatch/README.md shows them, with made-up values."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPORT = Path(__file__).with_name('resources-report.py')
APP = 'org.lifestreamprotocol.screen-capture'
QOS = ('background', 'utility', 'default', 'user_initiated', 'user_interactive', 'legacy', 'maintenance')


def at(minute, second=0):
    """Minutes after 2026-10-03T04:00:00Z."""
    moment = dt.datetime(2026, 10, 3, 4, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=minute, seconds=second)
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moment.microsecond // 1000:03d}Z'


def process(cpu_ms, energy_j, wakeups=600):
    value = {'cpu_ns': int(cpu_ms * 1e6), 'cpu_ns_by_qos': {name: 0 for name in QOS},
             'energy_nj': int(energy_j * 1e9), 'instructions': 0, 'cycles': 0, 'disk_read_bytes': 0,
             'disk_write_bytes': 4096, 'logical_write_bytes': 8192, 'interrupt_wakeups': wakeups,
             'idle_wakeups': 0, 'footprint_bytes': 200_000_000, 'threads': 30}
    value['cpu_ns_by_qos']['utility'] = value['cpu_ns']
    return value


def app_line(minute, build='49b1e7d', ocr=(300, 30), capture=(60, 30), cpu_ms=500, energy_j=6.0,
             front='com.example.editor', on_battery=True):
    """An example line: a minute of capture, 30 frames, OCR and capture parts."""
    return {'at': at(minute), 'until': at(minute + 1), 'build': build, 'pid': 80914,
            'process': process(cpu_ms, energy_j),
            'work': {'ocr': {'cpu_ns': int(ocr[0] * 1e6), 'wall_ns': int(ocr[0] * 2e6), 'n': ocr[1]},
                     'capture': {'cpu_ns': int(capture[0] * 1e6), 'wall_ns': int(capture[0] * 1e6), 'n': capture[1]}},
            'counts': {'frames': 30, 'flush_full': 30, 'flush_barrier': 30, 'bytes_written': 300_000,
                       'input_events_raw': 120},
            'state': {'awake_s': 60, 'display_awake_s': 60, 'unlocked_s': 60, 'capturing_s': 58,
                      'on_battery_s': 60 if on_battery else 0, 'low_power_s': 0, 'thermal_max': 'nominal',
                      'front': {front: 60}}}


def watch_line(minute, build='49b1e7d', cpu_ms=500, energy_j=6.0, mac_mw=12000, app=True):
    line = {'at': at(minute), 'until': at(minute + 1),
            'mac': {'system_power_mw': mac_mw, 'battery_percent': 80, 'external_power': False, 'samples': 6},
            'watcher': {'cpu_ns': 2_000_000, 'energy_nj': 30_000_000}}
    if app:
        line['app'] = {'pid': 80914, 'build': build, 'process': process(cpu_ms, energy_j), 'restarted': False}
    return line


def coalition(row_id, start_minute, minutes, bundle, energy_j, ane_j=0.0, gpu_j=0.0, billed_j=0.0, cpu_s=0.0):
    return {'ID': row_id, 'timestamp': at(start_minute), 'timestampEnd': at(start_minute + minutes),
            'bundle_id': bundle, 'LaunchdName': f'application.{bundle}', 'energy': int(energy_j * 1e9),
            'ane_energy_nj': int(ane_j * 1e9), 'gpu_energy_nj': int(gpu_j * 1e9),
            'energy_billed_to_me': int(billed_j * 1e9), 'energy_billed_to_others': 0, 'cpu_time': cpu_s,
            'interrupt_wakeups': 600.0 * minutes, 'platform_idle_wakeups': 0.0}


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = Path(self.temporary.name)
        (self.store / 'resources/powerlog').mkdir(parents=True)

    def write(self, name, items):
        path = self.store / 'resources' / name
        with open(path, 'a', encoding='utf-8') as handle:
            for item in items:
                handle.write(json.dumps(item, sort_keys=True) + '\n')

    def report(self, *arguments):
        result = subprocess.run([sys.executable, str(REPORT), '--store', str(self.store), '--json', *arguments],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def ten_agreeing_minutes(self, first=10, build='49b1e7d'):
        """Ten minutes in which the app drew 0.1 W by every account, on a Mac drawing 12 W."""
        self.write('app-2026-10-03.jsonl', [app_line(m, build) for m in range(first, first + 10)])
        self.write('watch-2026-10-03.jsonl', [watch_line(m, build) for m in range(first, first + 10)])
        self.write('powerlog/coalitions-2026-10-03.jsonl', [
            coalition(first, first, 10, APP, 60.0, ane_j=12.0, billed_j=6.0, cpu_s=5.0),
            coalition(first + 1000, first, 10, 'com.example.other', 1140.0),
        ])
        self.write('powerlog/battery-2026-10-03.jsonl', [
            {'ID': first + m, 'timestamp': at(first + m, 30), 'SystemPower': 12.0} for m in range(10)])

    def test_the_three_accounts_agree_and_the_app_is_its_share_of_the_mac(self):
        self.ten_agreeing_minutes()
        self.write('powerlog/coalitions-2026-10-03.jsonl', [coalition(10, 10, 10, APP, 60.0, ane_j=12.0, billed_j=6.0, cpu_s=5.0)])
        bucket = self.report('--by', 'build')['buckets']['49b1e7d']
        self.assertEqual(bucket['minutes'], 10)
        self.assertAlmostEqual(bucket['app_watts']['own'], 0.1)
        self.assertAlmostEqual(bucket['app_watts']['watcher'], 0.1)
        self.assertAlmostEqual(bucket['app_watts']['macos'], 0.13)
        self.assertAlmostEqual(bucket['app_watts']['macos_parts']['energy'], 0.1)
        self.assertAlmostEqual(bucket['app_watts']['macos_parts']['ane'], 0.02)
        self.assertAlmostEqual(bucket['mac_watts']['watcher'], 12.0)
        self.assertAlmostEqual(bucket['mac_watts']['power_log'], 12.0)
        self.assertAlmostEqual(bucket['app_share_of_mac'], 0.1 / 12)
        self.assertAlmostEqual(bucket['app_share_of_coalitions'], 72 / 1212)
        self.assertAlmostEqual(bucket['app_cpu_ms_per_minute']['own'], 500)
        self.assertAlmostEqual(bucket['app_cpu_ms_per_minute']['macos'], 500)
        self.assertEqual(bucket['disagreements'], [])
        self.assertAlmostEqual(bucket['watcher_cost']['cpu_ms_per_minute'], 2.0)
        self.assertAlmostEqual(bucket['wakeups_per_minute']['own'], 600)

    def test_each_part_with_the_unattributed_rest_and_the_cost_per_unit_of_work(self):
        self.ten_agreeing_minutes()
        bucket = self.report()['buckets']['49b1e7d']
        self.assertAlmostEqual(bucket['parts']['ocr']['cpu_ms_per_minute'], 300)
        self.assertAlmostEqual(bucket['parts']['ocr']['share'], 0.6)
        self.assertAlmostEqual(bucket['parts']['ocr']['cpu_ms_per_unit'], 10)
        self.assertAlmostEqual(bucket['parts']['unattributed']['cpu_ms_per_minute'], 140)
        self.assertAlmostEqual(bucket['parts']['unattributed']['share'], 0.28)
        self.assertAlmostEqual(bucket['per_unit']['frame']['cpu_ms'], 12)
        self.assertIsNone(bucket['per_unit']['shipped bundle']['cpu_ms'])
        self.assertAlmostEqual(bucket['writes_per_minute']['flush_full'], 30)
        self.assertAlmostEqual(bucket['writes_per_minute']['bytes_written'], 300_000)

    def test_a_part_whose_cost_per_unit_rose_more_than_a_fifth_on_matching_minutes_is_flagged(self):
        light, heavy = 'com.example.editor', 'com.example.video'
        self.write('app-2026-10-03.jsonl', [app_line(m, 'aaaa111', front=light) for m in range(0, 20)]
                   + [app_line(m, 'aaaa111', front=heavy, ocr=(600, 30)) for m in range(20, 25)])
        self.write('app-2026-10-03.jsonl', [app_line(m, 'bbbb222', front=light, capture=(78, 30)) for m in range(60, 65)]
                   + [app_line(m, 'bbbb222', front=heavy, ocr=(600, 30), capture=(78, 30)) for m in range(65, 85)])
        found = self.report()['regressions']
        self.assertEqual([(item['part'], item['from'], item['to']) for item in found],
                         [('capture', 'aaaa111', 'bbbb222')], 'a different mix of minutes is not a regression')
        self.assertAlmostEqual(found[0]['rise'], 0.3)
        self.assertEqual(found[0]['strata'], 2)

    def test_where_two_accounts_differ_by_more_than_a_tenth_it_says_so(self):
        self.write('app-2026-10-03.jsonl', [app_line(m) for m in range(10, 20)])
        self.write('watch-2026-10-03.jsonl', [watch_line(m, energy_j=7.2, mac_mw=12000) for m in range(10, 20)])
        self.write('powerlog/battery-2026-10-03.jsonl', [{'ID': m, 'timestamp': at(m, 30), 'SystemPower': 15.0}
                                                         for m in range(10, 20)])
        found = self.report()['buckets']['49b1e7d']['disagreements']
        self.assertEqual([(item['measure'], item['accounts']) for item in found],
                         [('app watts', ['own', 'watcher']), ('mac watts', ['watcher', 'power_log'])])

    def test_buckets_by_day_hour_state_and_front_and_the_filters(self):
        self.ten_agreeing_minutes(first=10, build='aaaa111')
        self.write('app-2026-10-03.jsonl', [app_line(m, 'bbbb222', front='com.example.video', on_battery=False)
                                            for m in range(70, 75)])
        self.assertEqual(list(self.report('--by', 'day')['buckets']), ['2026-10-03'])
        self.assertEqual(list(self.report('--by', 'hour')['buckets']), ['2026-10-03T04:00Z', '2026-10-03T05:00Z'])
        self.assertEqual(list(self.report('--by', 'state')['buckets']), ['capturing/ac', 'capturing/battery'])
        self.assertEqual(list(self.report('--by', 'front')['buckets']), ['com.example.editor', 'com.example.video'])
        self.assertEqual(list(self.report('--by', 'build', '--build', 'bbbb222')['buckets']), ['bbbb222'])
        since = self.report('--since', '2026-10-03T05:00:00Z')
        self.assertEqual(since['total']['minutes'], 5)

    def test_the_text_report_states_every_section(self):
        self.ten_agreeing_minutes()
        result = subprocess.run([sys.executable, str(REPORT), '--store', str(self.store)],
                                capture_output=True, text=True, check=True)
        for heading in ('== 49b1e7d: 10 minutes', 'app watts: own 0.100  watcher 0.100  macOS 0.130',
                        'parts (CPU ms/min, share, ms per unit):', 'unattributed', 'CPU per unit of work: frame 12.000 ms',
                        'the watcher itself: 2.00 CPU ms/min'):
            self.assertIn(heading, result.stdout)
        self.assertNotIn('com.example.other', result.stdout, 'no other app is named')


if __name__ == '__main__':
    unittest.main()
