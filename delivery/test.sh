#!/usr/bin/env bash
set -euo pipefail
curl --fail --location --retry 3 https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz -o /tmp/node.tar.xz
curl --fail --location --retry 3 https://nodejs.org/dist/v26.13.0/SHASUMS256.txt -o /tmp/node-checksums
python3 - <<'CHECK'
import hashlib
from pathlib import Path
expected=next(x.split()[0] for x in Path('/tmp/node-checksums').read_text().splitlines() if x.endswith('node-v26.13.0-linux-x64.tar.xz'))
assert hashlib.sha256(Path('/tmp/node.tar.xz').read_bytes()).hexdigest()==expected
CHECK
tar -xJf /tmp/node.tar.xz -C /tmp
export PATH=/tmp/node-v26.13.0-linux-x64/bin:$PATH
npm ci
npm run lint
npm test
npm run check:runtime
