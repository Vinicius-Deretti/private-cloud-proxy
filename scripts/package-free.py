#!/usr/bin/env python3
"""Build a Windows x64 client bundle. Runtime downloads only after user starts it."""
import argparse
import re
from urllib.parse import urlsplit
from pathlib import Path
import zipfile
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--endpoint',help='Optional public WSS endpoint to preconfigure in the Windows bundle; never a secret')
parser.add_argument('--output', type=Path, help='Output ZIP path')
args=parser.parse_args()
if args.endpoint:
    url=urlsplit(args.endpoint)
    if not (url.scheme=='wss' and url.path=='/tunnel' and not url.query and not url.fragment and url.hostname and re.fullmatch(r'[A-Za-z0-9.-]+',url.hostname) and url.netloc==url.hostname):
        parser.error('Use wss://HOST/tunnel without credentials, query or custom port')
root=Path(__file__).resolve().parents[1]
target=args.output or root/'.local/private-cloud-proxy-free-windows.zip'
target.parent.mkdir(parents=True, exist_ok=True)
files=[root/p for p in ('.env.example','LICENSE','Start-Private-Proxy.cmd','package.json','package-lock.json','README.md','bridge/README.md','bridge/env.mjs','bridge/start.mjs','bridge/bootstrap.mjs','bridge/client.mjs','bridge/tunnel-stream.mjs','bridge/lock.mjs','bridge/tls-resume.mjs','bridge/fast-open.mjs','bridge/session-queue.mjs','bridge/diagnostics.mjs','bridge/budget.mjs','bridge/policy.mjs','bridge/data/iana-special.json','bridge/check-remote.mjs','docs/WINDOWS-STARTUP.md','docs/PERFORMANCE.md')]
for package in ('ws','ipaddr.js'):
    directory=root/'node_modules'/package
    if not directory.is_dir(): raise SystemExit('Run npm ci --ignore-scripts before packaging')
    files.extend(p for p in directory.rglob('*') if p.is_file())
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
    for p in files:
        data=p.read_bytes()
        if p.suffix=='.cmd':
            data=data.replace(b'\r\n',b'\n')
            if args.endpoint:
                data=data.replace(b'setlocal\n', f'setlocal\nif not defined TUNNEL_URL set "TUNNEL_URL={args.endpoint}"\n'.encode(),1)
            data=data.replace(b'\n',b'\r\n')
        archive.writestr(str(p.relative_to(root)),data)
with zipfile.ZipFile(target) as archive:
    assert 'Start-Private-Proxy.cmd' in archive.namelist()
    assert not any(n.endswith(('.pem','.key','.env','.exe')) for n in archive.namelist())
print(target)
