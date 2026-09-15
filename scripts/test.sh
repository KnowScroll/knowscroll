#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
python3 - <<'PY2'
from pathlib import Path
from urllib.parse import urlparse,urlunparse
import os,subprocess,uuid
config=dict(x.split('=',1) for x in Path('.env').read_text().splitlines() if '=' in x and not x.startswith('#')) if Path('.env').exists() else {}
u=urlparse(os.environ.get('DATABASE_URL',config.get('DATABASE_URL','')))
if not u.hostname:raise SystemExit('DATABASE_URL is required')
name='knowscroll_test_'+uuid.uuid4().hex
env={**os.environ,'PGPASSWORD':u.password or ''}
args=['-h',u.hostname,'-p',str(u.port or 5432),'-U',u.username]
subprocess.run(['createdb',*args,name],env=env,check=True)
testenv={**env,'DATABASE_URL':urlunparse(u._replace(path='/'+name))}
try:
 for cmd in [['pnpm','db:migrate'],['pnpm','db:seed'],['pnpm','exec','tsx','--test','tests/core.test.ts','tests/integration.test.ts']]:subprocess.run(cmd,env=testenv,check=True)
finally:subprocess.run(['dropdb',*args,name],env=env,check=True)
PY2
