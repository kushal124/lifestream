#!/usr/bin/env python3
"""Observe already-running recorders, sequentially; never launch or alter capture."""
import argparse
import collections
import datetime as dt
import fcntl
import hashlib
import json
import os
import math
import re
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

import compare


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


class FixturePreflightError(ValueError):
    """Fixed diagnostics deliberately exclude captured content."""


def validate_fixture_captures(observations, phase, marker, now, required_app="com.google.chrome", complete_only=False):
    allowed = ('captured',) if complete_only else ('captured', 'unchanged')
    recent = []
    for observation in observations:
        try:
            at = compare.seconds(observation['capturedAt'])
        except (KeyError, TypeError, ValueError):
            raise FixturePreflightError('Fixture preflight found invalid capture timestamps.')
        if not math.isfinite(at):
            raise FixturePreflightError('Fixture preflight found invalid capture timestamps.')
        if now - 12 <= at <= now:
            recent.append((at, observation))
    recent.sort(key=lambda value: value[0])
    if not recent or recent[-1][1].get('status') not in allowed:
        raise FixturePreflightError('Fixture preflight requires a recent captured observation, with no newer gap.')
    if now - recent[-1][0] > 4:
        raise FixturePreflightError('Fixture preflight latest capture is older than four seconds.')
    captured = [(at, row) for at, row in recent if row.get('status') in allowed]
    by_time = collections.defaultdict(list)
    for at, row in captured:
        by_time[at].append(row)
    instants = sorted(by_time)
    if len(instants) < 2:
        raise FixturePreflightError('Fixture preflight requires two distinct recent capture instants.')
    def matches(row):
        bundle = (row.get('application') or {}).get('bundleID') or ''
        observed = set(re.findall(r'[^\W_]+', ' '.join(item.get('text', '') for item in row.get('ocr', [])).lower()))
        return (bundle.casefold() == required_app.casefold() and marker.casefold() in observed
                and (not complete_only or bool(row.get('imageFile'))))
    if not all(any(matches(row) for row in by_time[at]) for at in instants[-2:]):
        raise FixturePreflightError('Fixture preflight requires the expected app and OCR marker in the latest two captures.')
    return {'passed': True, 'phase': phase, 'checkedAt': now,
            'recentCapturedObservations': len(captured), 'imageBackedStatusCounts': dict(collections.Counter(row['status'] for _, row in captured)), 'distinctCaptureInstants': len(instants),
            'matchingCaptureInstants': sum(any(matches(row) for row in rows) for rows in by_time.values()),
            'latestCaptureAgeSeconds': now - recent[-1][0],
            'latestTwoMatching': True, 'lookbackSeconds': 12, 'maximumLatestAgeSeconds': 4,
            'scope': 'Own committed capture evidence before window; does not guarantee fixture remains foreground throughout run.'}


def fixture_preflight(executable, store, phase):
    manifest = json.loads((Path(__file__).parent/'fixture/manifest.json').read_text())
    marker = manifest['scenarios'][phase]['marker']
    requested_at = time.time()
    since = dt.datetime.fromtimestamp(requested_at-12,dt.timezone.utc).isoformat()
    try:
        result = subprocess.run([str(executable), 'query', '--store', str(store),
                                 '--since', since, '--limit', '20'], capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise FixturePreflightError('Fixture preflight could not query committed captures.')
        observations = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if len(observations) >= 20:
            raise FixturePreflightError('Fixture preflight query limit reached; recent evidence may be incomplete.')
        finished_at = time.time()
        if finished_at - requested_at > 10:
            raise FixturePreflightError('Fixture preflight query took too long for a current witness.')
        proof = validate_fixture_captures(observations, phase, marker, requested_at)
        proof['queryFinishedAt'] = finished_at
        proof['queryDurationSeconds'] = finished_at - requested_at
        proof['maximumQueryDurationSeconds'] = 10
        return proof
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        raise FixturePreflightError('Fixture preflight could not read recent capture evidence.')


def validate_provider_preflight(own, coast, required_app, marker, now):
    return {"own": validate_fixture_captures(own, "generic", marker, now, required_app, True),
            "coast": validate_fixture_captures(coast, "generic", marker, now, required_app, True),
            "scope": "Two fresh complete image witnesses from each provider before the window; no guarantee of continued foreground or visibility."}


def validate_preflight_window(window, finished_at):
    if window and window['start'] <= finished_at:
        raise FixturePreflightError('Preflight must finish before the adopted window starts; no retroactive qualification.')


def provider_preflight(executable, store, coast_store, required_app, marker):
    requested_at = time.time()
    since = dt.datetime.fromtimestamp(requested_at-12, dt.timezone.utc).isoformat()
    try:
        result = subprocess.run([str(executable), 'query', '--store', str(store),
                                 '--since', since, '--limit', '40'], capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise FixturePreflightError('Provider preflight could not query own committed captures.')
        own = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if len(own) >= 40:
            raise FixturePreflightError('Provider preflight own query limit reached.')
        with compare.sqlite3.connect((coast_store/'rem.db').resolve().as_uri()+'?mode=ro', uri=True, timeout=5) as db:
            db.row_factory = compare.sqlite3.Row
            db.execute('PRAGMA query_only=ON')
            rows = db.execute("""SELECT f.timestamp,f.foreground,f.background,f.image_path,f.video,a.bundle_id
                FROM frame f LEFT JOIN segment s ON s.id=f.segment
                LEFT JOIN application a ON a.id=s.application
                WHERE f.timestamp>=? AND f.timestamp<=? ORDER BY f.timestamp DESC,f.id DESC LIMIT 40""",
                ((requested_at-12)*1000, time.time()*1000)).fetchall()
        coast = [{'capturedAt': row['timestamp'], 'status': 'captured',
                  'imageFile': bool(row['image_path'] or row['video'] is not None),
                  'application': {'bundleID': row['bundle_id']},
                  'ocr': [{'text': text} for text in (row['foreground'], row['background']) if text]}
                 for row in rows]
        finished_at = time.time()
        if finished_at-requested_at > 10:
            raise FixturePreflightError('Provider preflight query exceeded its time bound.')
        proof = validate_provider_preflight(own, coast, required_app, marker, finished_at)
        proof['queryStartedAt'] = requested_at
        proof['queryFinishedAt'] = finished_at
        return proof
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, compare.sqlite3.Error):
        raise FixturePreflightError('Provider preflight could not read current evidence.')


def signature(path):
    result = {'exists': path.is_file()}
    if not result['exists']:
        return result
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    result['sha256'] = digest.hexdigest()
    signed = subprocess.run(['codesign', '-d', '-vv', str(path)], text=True, capture_output=True)
    result['signature_inspection_succeeded'] = signed.returncode == 0
    for line in signed.stderr.splitlines():
        if line.startswith('CDHash='):
            result['cdhash'] = line.partition('=')[2]
    return result


def cpu_seconds(value):
    days = 0
    if '-' in value:
        day, value = value.split('-', 1)
        days = int(day)
    return days * 86400 + sum(float(v)*60**i for i,v in enumerate(reversed(value.split(':'))))


def sample(own_binary, coast_binary, own_store):
    began = time.time()
    lines = subprocess.check_output(['ps', '-axo', 'pid,time,rss,comm'], text=True).splitlines()[1:]
    processes = []
    coast_bundle = str(coast_binary.parent.parent)
    for line in lines:
        fields = line.strip().split(None, 3)
        if len(fields) != 4:
            continue
        pid, cpu, rss, command = fields
        if command == str(own_binary):
            name = 'lifestream'
        elif command == str(coast_binary):
            name = 'coast'
        elif command.startswith(coast_bundle + '/') and command.endswith('/ffmpeg'):
            name = 'coast-encoder'
        elif command.endswith('/WindowServer'):
            name = 'windowserver'
        elif command.endswith('/replayd'):
            name = 'replayd'
        elif command.endswith(('/VTEncoderXPCService', '/VTDecoderXPCService')):
            name = 'video-service'
        else:
            name = 'other'
        processes.append({'pid': int(pid), 'name': name, 'cpu_seconds': cpu_seconds(cpu), 'rss_kib': int(rss)})
    runtime = {}
    try:
        runtime = json.loads((own_store/'runtime.json').read_text())
    except (OSError, ValueError):
        pass
    return {'at': began, 'finished_at': time.time(), 'processes': processes,
            'recorder_state': runtime.get('state'), 'capture_duration': runtime.get('lastCaptureDuration'),
            'gap_reason': runtime.get('lastGapReason'),
            'recorded': runtime.get('recorded'), 'gaps': runtime.get('gaps')}


def summarize(rows, window):
    elapsed = rows[-1]['at'] - rows[0]['at']
    result = {'sampling_start': rows[0]['at'], 'sampling_end': rows[-1]['at'],
              'sampled_seconds': elapsed, 'samples': len(rows),
              'start_offset_seconds': rows[0]['at']-window['start'],
              'end_offset_seconds': rows[-1]['at']-window['end'], 'processes': {}}
    for name in sorted({p['name'] for row in rows for p in row['processes']}):
        bypid = collections.defaultdict(list)
        for row in rows:
            for process in row['processes']:
                if process['name'] == name:
                    bypid[process['pid']].append((row['at'], process['cpu_seconds']))
        cpu = sum(max(0, values[-1][1]-values[0][1]) for values in bypid.values())
        rss = [sum(p['rss_kib'] for p in row['processes'] if p['name']==name)/1024 for row in rows]
        result['processes'][name] = {
            'observed_pids': len(bypid), 'observed_cpu_seconds_delta': cpu,
            'mean_cpu_percent_one_core': 100*cpu/elapsed if elapsed else None,
            'median_rss_mib': statistics.median(rss), 'max_rss_mib': max(rss),
            'present_samples': sum(any(p['name']==name for p in row['processes']) for row in rows),
            'one_sample_only_pids': sum(len(v)==1 for v in bypid.values())}
    result['recorder_state_samples'] = dict(collections.Counter(str(r['recorder_state']) for r in rows))
    result['capture_duration_seconds'] = compare.summary([r['capture_duration'] for r in rows if isinstance(r['capture_duration'], (int,float))])
    system_cpu = sum(p['observed_cpu_seconds_delta'] for p in result['processes'].values())
    result['whole_system'] = {
        'observed_cpu_seconds_delta': system_cpu,
        'mean_cpu_percent_one_core': 100*system_cpu/elapsed if elapsed else None,
        'recorder_attributable': False,
        'scope': 'Sum of observed process CPU deltas, including shared services and unrelated activity; incomplete for short-lived processes.'}
    result['limitations'] = [
        'CPU deltas cover sampled process lifetimes, not exact wall-window clipping.',
        'Short-lived encoders between samples and CPU before first/after last PID observation are omitted.',
        'Process absence is not zero measured CPU; consult present_samples and observed_pids.',
        'WindowServer, replayd and video-service costs are shared; they are not attributed to either recorder.',
        'Whole-system observed CPU is not a controlled A/B or an energy measurement; workload, builds and background activity contribute.',
        'Repeated runtime duration values are heartbeat samples, not a per-capture latency distribution.']
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True, help='New runtime result directory outside the repository')
    p.add_argument('--duration', type=float, default=300)
    p.add_argument('--sample-interval', type=float, default=5)
    p.add_argument('--own-store', type=Path, default=Path.home()/'Library/Application Support/Lifestream Screen')
    p.add_argument('--coast-store', type=Path, default=Path.home()/'Library/Application Support/inc.attention.rem')
    p.add_argument('--own-executable', type=Path, default=Path.home()/'Applications/Lifestream.app/Contents/MacOS/Lifestream')
    p.add_argument('--coast-executable', type=Path, default=Path('/Applications/Coast Local.app/Contents/MacOS/Coast Local'))
    p.add_argument('--tag', action='append', default=[], help='Configuration tag KEY=VALUE; never include captured content')
    p.add_argument('--fixture-phase', choices=['article','dense','canvas','mixed'], help='Require two recent Chrome captures with this fixture marker before starting a new window')
    p.add_argument('--required-marker', help='Require this synthetic OCR token from both providers before a new or future window')
    p.add_argument('--required-app', help='Required foreground application bundle identifier for both providers')
    p.add_argument('--window', type=Path, help='Adopt an existing window.json; late observation is explicitly partial')
    args=p.parse_args()
    if not (0 < args.duration <= 3600 and 0 < args.sample_interval <= 60):
        p.error('Duration must be 0–3600 seconds; sample interval 0–60 seconds (both positive).')
    if args.fixture_phase and args.window:
        p.error('Fixture preflight requires a new window; it cannot qualify an adopted window retroactively.')
    if bool(args.required_marker) != bool(args.required_app):
        p.error('--required-marker and --required-app must be supplied together.')
    if args.required_marker and not re.fullmatch(r'[^\W_]+', args.required_marker):
        p.error('Required marker must be one alphanumeric token.')
    output=args.output.resolve()
    repo=Path(__file__).resolve().parents[2]
    if output==repo or repo in output.parents:
        p.error('Runtime evidence must be outside the repository.')
    lock_path=Path(tempfile.gettempdir())/'lifestream-coast-benchmark.lock'
    fd=os.open(lock_path, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            p.error('Another benchmark is running; complete it before starting another.')
        output.mkdir(parents=True, exist_ok=True)
        if any((output/n).exists() for n in ('resources.jsonl','comparison.json','metadata.json')):
            p.error('Result directory already contains a run; choose a new directory.')
        compare.COAST=args.coast_store
        baseline={'measured_at':time.time(),'sizes':compare.disk_totals(args.own_store)}
        baseline['measurement_finished_at']=time.time()
        metadata={'tags':args.tag,'own_binary':signature(args.own_executable),
                  'coast_binary':signature(args.coast_executable),
                  'sample_interval_seconds':args.sample_interval,
                  'platform':os.uname().release,
                  'policy':'Observe only; no capture launches, settings changes, or stream writes.'}
        if args.fixture_phase:
            try:
                metadata['fixture_preflight'] = fixture_preflight(args.own_executable, args.own_store, args.fixture_phase)
            except FixturePreflightError as error:
                p.error(str(error))
        if args.required_marker:
            try:
                metadata['provider_preflight'] = provider_preflight(args.own_executable, args.own_store,
                    args.coast_store, args.required_app, args.required_marker)
            except FixturePreflightError as error:
                p.error(str(error))
        if args.window:
            window=json.loads(args.window.read_text())
            if args.required_marker:
                try:
                    validate_preflight_window(window, time.time())
                except FixturePreflightError as error:
                    p.error(str(error))
            if not window['start']<window['end'] or window['end']<=time.time():
                p.error('Adopted window must have ordered bounds and must not have ended.')
        else:
            start=time.time()
            window={'start':start,'end':start+args.duration}
        window.update({key+'_iso':dt.datetime.fromtimestamp(window[key],dt.timezone.utc).isoformat() for key in ('start','end')})
        baseline['window']=window
        metadata['partial_adopted_window']=time.time()>window['start']+1
        write(output/'metadata.json',metadata)
        write(output/'window.json',window)
        write(output/'storage-baseline.json',baseline)
        print(json.dumps({'output':str(output),'window':window}),flush=True)
        rows=[]
        with (output/'resources.jsonl').open('x',buffering=1) as log:
            while time.time()<window['start']:
                time.sleep(min(1,window['start']-time.time()))
            while True:
                row=sample(args.own_executable,args.coast_executable,args.own_store)
                rows.append(row)
                log.write(json.dumps(row)+'\n')
                if row['at']>=window['end']:
                    break
                time.sleep(max(0,min(args.sample_interval,window['end']-time.time())))
        write(output/'resource-summary.json',summarize(rows,window))
        subprocess.run([sys.executable,str(Path(__file__).with_name('compare.py')),
                        '--directory',str(output),'--own-store',str(args.own_store),
                        '--coast-store',str(args.coast_store)],check=True)
        metadata['own_binary_after']=signature(args.own_executable)
        metadata['coast_binary_after']=signature(args.coast_executable)
        metadata['binaries_unchanged']=(metadata['own_binary']==metadata['own_binary_after'] and metadata['coast_binary']==metadata['coast_binary_after'])
        write(output/'metadata.json',metadata)
        print(json.dumps({'complete':True,'output':str(output)}),flush=True)
    finally:
        os.close(fd)

if __name__=='__main__':
    main()
