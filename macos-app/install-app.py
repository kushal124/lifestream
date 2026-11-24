#!/usr/bin/env python3
"""The owner's deploy: build the app from the commit checked out, install it, open it.

`build-app.sh` builds dist/Lifestream.app with that commit's release inside it. The running app
is shut down through its own control channel, the new bundle replaces
~/Applications/Lifestream.app (staged beside it and verified; the old one is put back if the swap
fails, and kept after it as dist/previous/Lifestream.app, one copy, so a deploy can be undone by
putting it back), and the app is opened. Its launch registers its agents again from this build and installs
the release it carries, as an update does on a friend's Mac
(docs/operating/releases.md, "Deploy and roll back"). Bundle identifier, signing identity and
spool folder are unchanged, so macOS keeps the capture permissions.
"""
from pathlib import Path
import fcntl
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import time

BUNDLE_ID = 'org.lifestreamprotocol.screen-capture'
SERVED_WITHIN_S = 600


def running():
    """Whether macOS runs the app now, from any copy of it."""
    found = subprocess.run(['/usr/bin/lsappinfo', 'find', f'bundleid={BUNDLE_ID}'], capture_output=True, text=True)
    return found.stdout.strip() != ''


def stop(cli):
    """Shuts a running app down and waits for its process to end, not only its control channel: it
    finishes its in-flight capture first. Any build reaches it through the same control channel."""
    if not running():
        return
    if subprocess.run([str(cli), 'live-status'], capture_output=True).returncode == 0:
        if subprocess.run([str(cli), 'shutdown'], capture_output=True, timeout=20).returncode:
            raise SystemExit('Unable to stop the running app')
    for _ in range(1200):
        if not running():
            return
        time.sleep(0.1)
    raise SystemExit('The running app has not exited')


def one_at_a_time():
    """Holds the Mac's one deploy lock until this process ends: two deploys at once write the same
    dist/ and app folder (15 Nov 18:33, two sessions: one's ditto found the other's build half
    removed). A second deploy waits and says once whose it waits for."""
    path = Path('/private/tmp/lifestream-deploy.lock')
    held = open(path, 'a+')
    try:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        held.seek(0)
        print(f'waiting for the deploy running now: {held.read().strip() or "unknown"}', flush=True)
        fcntl.flock(held, fcntl.LOCK_EX)
    held.truncate(0)
    held.write(f'pid {os.getpid()}, {Path.cwd()}, since {time.strftime("%H:%M:%S")}\n')
    held.flush()
    return held


def serving(tools):
    answer = subprocess.run([str(tools / 'door.sh'), '/v1/status'], capture_output=True, text=True)
    return json.loads(answer.stdout).get('release') if answer.returncode == 0 else None


def wait_until_served(tools, commit):
    deadline = time.monotonic() + SERVED_WITHIN_S
    while time.monotonic() < deadline:
        release = serving(tools)
        if release is not None and release.startswith(commit):
            print(f'The home serves {commit}.')
            return
        time.sleep(2)
    raise SystemExit(f'Installed, but the home does not serve {commit} after {SERVED_WITHIN_S} s: tools/door.sh /v1/status says what it runs')


def main():
    package = Path(__file__).resolve().parent
    lock = one_at_a_time()
    home_before = serving(package.parent / 'tools')
    main_run = package.parent / 'tools/main-run.sh'
    if main_run.exists():
        verdict = subprocess.run([str(main_run), '--verdict'], capture_output=True, text=True)
        if verdict.returncode:
            print(f"main's last run is red: {verdict.stdout.strip()}")
    subprocess.run(['/bin/bash', str(package / 'build-app.sh')], check=True)
    source = package / 'dist/Lifestream.app'
    parent = Path.home() / 'Applications'
    destination = parent / source.name
    kept = package / 'dist/previous' / source.name
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(source)], check=True)
    for app in (source, destination):
        if app.is_symlink() or (app.exists() and plistlib.loads((app / 'Contents/Info.plist').read_bytes()).get('CFBundleIdentifier') != BUNDLE_ID):
            raise SystemExit(f'Refusing to replace {app}: it is not Lifestream')
    cli = source / 'Contents/MacOS/Lifestream'
    stop(cli)
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.lifestream-install-', dir=parent) as temporary:
        stage = Path(temporary) / source.name
        subprocess.run(['/usr/bin/ditto', str(source), str(stage)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(stage)], check=True)
        previous = Path(temporary) / 'previous.app'
        if destination.exists():
            destination.rename(previous)
        try:
            stage.rename(destination)
        except BaseException:
            if previous.exists():
                previous.rename(destination)
            raise
        if previous.exists():
            shutil.rmtree(kept, ignore_errors=True)
            kept.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(previous), str(kept))
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(destination)], check=True)
    stop(cli)
    subprocess.run(['/usr/bin/defaults', 'write', BUNDLE_ID, 'LifestreamUpdateRelaunch', '-float', str(time.time())], check=True)
    subprocess.run(['/usr/bin/open', '-g', str(destination)], check=True)
    info = plistlib.loads((destination / 'Contents/Info.plist').read_bytes())
    print(f"Installed and opened Lifestream {info.get('CFBundleShortVersionString')} ({info.get('LifestreamCommit')}): "
          f"it registers its agents and installs its release. "
          f"'{destination}/Contents/MacOS/Lifestream' setup shows where it stands. The app it replaced is kept at {kept}.")
    if home_before is not None:
        wait_until_served(package.parent / 'tools', info['LifestreamCommit'])


if __name__ == '__main__':
    main()
