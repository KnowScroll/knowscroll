#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
python3 - <<'PY2'
from pathlib import Path
import os
values=dict(l.split('=',1) for l in Path('.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
p=Path('apps/mobile/local.properties')
p.write_text('sdk.dir='+os.environ['ANDROID_HOME']+'\nKS_DEV_TOKEN='+values['KS_DEV_TOKEN']+'\n')
p.chmod(0o600)
print('Android local configuration updated; token not printed.')
PY2
