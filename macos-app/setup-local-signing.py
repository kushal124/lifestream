#!/usr/bin/env python3
"""Create a persistent, private signing identity for this Mac's recorder builds."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

root = Path.home() / 'Library/Application Support/Lifestream Screen Signing'
os.umask(0o077)
root.mkdir(mode=0o700, parents=True, exist_ok=True)
if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
    raise SystemExit('Signing directory must be owned by this user and mode 0700')
config = root / 'identity.json'
if config.exists():
    print('Persistent signing identity already configured; keeping it unchanged.')
    raise SystemExit(0)
keychain = root / 'signing.keychain-db'
if keychain.exists():
    raise SystemExit('An incomplete signing setup exists; inspect it before retrying. No keys replaced.')

def run(arguments, **kwargs):
    result = subprocess.run(arguments, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Signing setup command failed: ' + arguments[0])
    return result.stdout

password = secrets.token_urlsafe(36)
(root / 'keychain-password').write_text(password)
run(['/usr/bin/security', 'create-keychain', '-p', password, str(keychain)])
run(['/usr/bin/security', 'set-keychain-settings', str(keychain)])
run(['/usr/bin/security', 'unlock-keychain', '-p', password, str(keychain)])
with tempfile.TemporaryDirectory(prefix='setup-', dir=root) as scratch:
    scratch = Path(scratch)
    settings = scratch / 'certificate.conf'
    settings.write_text('''[req]
prompt = no
distinguished_name = name
x509_extensions = extensions
[name]
CN = Lifestream Screen Local Signing
[extensions]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
''')
    key, cert, p12 = (scratch / n for n in ('key.pem', 'certificate.pem', 'identity.p12'))
    run(['/usr/bin/openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes', '-x509',
         '-days', '3650', '-sha256', '-config', str(settings), '-keyout', str(key), '-out', str(cert)])
    export_password = secrets.token_urlsafe(36)
    run(['/usr/bin/openssl', 'pkcs12', '-export', '-inkey', str(key), '-in', str(cert),
         '-out', str(p12), '-passout', 'stdin'], input=(export_password+'\n').encode())
    run(['/usr/bin/security', 'import', str(p12), '-k', str(keychain), '-P', export_password,
         '-x', '-T', '/usr/bin/codesign'])
    der = run(['/usr/bin/openssl', 'x509', '-in', str(cert), '-outform', 'DER'])
    (root / 'certificate.der').write_bytes(der)
    identity = hashlib.sha1(der).hexdigest().upper()
run(['/usr/bin/security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s',
     '-k', password, str(keychain)])
config.write_text(json.dumps({'identity': identity, 'keychain': str(keychain)}, indent=2)+'\n')
print('Persistent local signing identity created. No system trust or privacy settings changed.')
