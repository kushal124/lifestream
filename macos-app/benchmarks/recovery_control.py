#!/usr/bin/env python3
"""Manual live pause/resume recovery check. Leaves the existing recorder running.

Uses the private recorder spool, never an admitted stream. Does not change desktop
content. Run only when capture is allowed on the current unlocked display.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import time


def command(executable, *arguments):
    result = subprocess.run([str(executable), *arguments], capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise RuntimeError('recorder-control-failed')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cycles', type=int, default=5)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--executable', type=Path, default=Path.home()/'Applications/Lifestream.app/Contents/MacOS/Lifestream')
    args = parser.parse_args()
    if not 1 <= args.cycles <= 20:
        parser.error('cycles must be 1 through 20')
    report = {'scope': 'Live confirmed teardown and restart; not an OS sleep/wake or unconfirmed-stop injection test.', 'cycles': []}
    failed = False
    try:
        for index in range(args.cycles):
            pause = json.loads(command(args.executable, 'pause'))
            if pause.get('state') != 'stopped':
                raise RuntimeError('pause-not-confirmed')
            began = time.time()
            command(args.executable, 'start')
            since = dt.datetime.fromtimestamp(began, dt.timezone.utc).isoformat()
            deadline = time.monotonic() + 20
            witness = None
            while time.monotonic() < deadline:
                records = [json.loads(line) for line in command(args.executable, 'query', '--since', since, '--limit', '20').splitlines() if line.strip()]
                witness = next((r for r in records if r.get('status') == 'captured' and r.get('imageFile')), None)
                if witness:
                    break
                time.sleep(.5)
            if witness is None:
                raise RuntimeError('fresh-capture-did-not-resume')
            report['cycles'].append({'cycle': index+1, 'freshImageSaved': True, 'availabilityDelaySeconds': time.time()-began})
    except (RuntimeError, subprocess.SubprocessError, ValueError, OSError):
        failed = True
        report['failure'] = 'control-or-fresh-capture-check-failed'
    finally:
        try:
            command(args.executable, 'start')
            report['finalState'] = json.loads(command(args.executable, 'live-status')).get('state')
        except (RuntimeError, subprocess.SubprocessError, ValueError, OSError):
            failed = True
            report['finalState'] = 'unconfirmed'
        report['passed'] = not failed and len(report['cycles']) == args.cycles
        args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
