#!/usr/bin/env python3
"""Sign with a stable identity; never silently fall back to ad-hoc signing."""
import json
import os
import plistlib
import re
import tempfile
import shlex
from pathlib import Path
import subprocess
import sys

app = Path(sys.argv[1])
identity = os.environ.get('CAPTURE_SIGN_IDENTITY')
identities = subprocess.check_output(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], text=True)
developers = re.findall(r'([A-F0-9]{40}) "(Developer ID Application:[^"]+)"', identities)
if identity is None and developers:
    if len(developers) != 1:
        raise SystemExit('Several Developer ID identities exist: select one with CAPTURE_SIGN_IDENTITY.')
    identity = developers[0][0]
distribution = any(identity == name or identity.upper() == fingerprint
                   for fingerprint, name in developers) if identity else False
arguments = ['/usr/bin/codesign', '--force']
arguments += ['--timestamp', '--options', 'runtime'] if distribution else ['--timestamp=none']
requirement = []
added_keychain = None
if identity:
    if identity == '-':
        raise SystemExit('Ad-hoc signing changes privacy identity on rebuild; use a persistent signing identity.')
    arguments += ['--sign', identity]
else:
    root = Path.home() / 'Library/Application Support/Lifestream Screen Signing'
    config = root / 'identity.json'
    if not config.exists():
        raise SystemExit('Run python3 setup-local-signing.py once, or set CAPTURE_SIGN_IDENTITY. No ad-hoc fallback.')
    value = json.loads(config.read_text())
    password = (root / 'keychain-password').read_text()
    result = subprocess.run(['/usr/bin/security', 'unlock-keychain', '-p', password, value['keychain']],
                            capture_output=True)
    if result.returncode:
        raise SystemExit('Unable to unlock the dedicated local signing keychain')
    designated = ('=designated => identifier "org.lifestreamprotocol.screen-capture" '
                  'and certificate leaf = H"' + value['identity'] + '"')
    arguments += ['--keychain', value['keychain'], '--sign', value['identity']]
    requirement = ['-r', designated]
    search = shlex.split(subprocess.check_output(['/usr/bin/security', 'list-keychains', '-d', 'user'], text=True))
    if value['keychain'] not in search:
        subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *search, value['keychain']], check=True)
        added_keychain = value['keychain']
def sign(path, extra=()):
    result = subprocess.run(arguments + list(extra) + [str(path)], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr)


frameworks = app / 'Contents/Frameworks'
sparkle = frameworks / 'Sparkle.framework'
sparkle_code = [sparkle / 'Versions/B/Autoupdate', sparkle / 'Versions/B/Updater.app', sparkle]


def native_files():
    magic = {bytes.fromhex(x) for x in (
        'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
        'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
    for path in sorted(app.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as file:
            if file.read(4) in magic:
                yield path


try:
    natives = list(native_files())
    if distribution:
        with tempfile.TemporaryDirectory(dir=app.parent) as directory:
            entitlements = Path(directory) / 'node.plist'
            entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit': True}))
            for path in natives:
                if path == app / 'Contents/MacOS/Lifestream':
                    continue
                if frameworks in path.parents:
                    continue
                extra = ['--entitlements', str(entitlements)] if path == app / 'Contents/Resources/release/node' else []
                sign(path, extra)
            for path in sparkle_code:
                sign(path)
            resources = Path(directory) / 'app.plist'
            resources.write_bytes(plistlib.dumps({'com.apple.security.device.audio-input': True,
                                                  'com.apple.security.personal-information.photos-library': True}))
            sign(app, ['--entitlements', str(resources)])
    else:
        for path in sparkle_code:
            sign(path)
        sign(app, requirement)
    if distribution:
        for path in natives:
            info = subprocess.run(['/usr/bin/codesign', '-dvv', str(path)],
                                  check=True, capture_output=True, text=True).stderr
            if 'runtime' not in info or 'Timestamp=' not in info or 'TeamIdentifier=not set' in info:
                raise SystemExit(f'Native code lacks a timestamp, team or hardened runtime: {path.relative_to(app)}')
            subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(path)], check=True)
    print(json.dumps({'distribution': distribution, 'native_files': len(natives)}))
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
finally:
    if added_keychain:
        current = shlex.split(subprocess.check_output(['/usr/bin/security', 'list-keychains', '-d', 'user'], text=True))
        subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s',
                        *(path for path in current if path != added_keychain)], check=True)
