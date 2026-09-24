#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
# Optional arguments name test files to run instead of the whole suite (still against a fresh
# disposable database that is migrated, seeded and dropped): scripts/test.sh tests/x.test.ts
python3 - "$@" <<'PY2'
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
 # The original integration test asserts bootstrap-wide counts and installs a
 # temporary failure trigger. Finish it before independently provisioned users.
 import sys
 selected=sys.argv[1:]
 baseline=['tests/core.test.ts','tests/integration.test.ts','tests/migrations.test.ts']
 additional=sorted(str(path) for path in Path('tests').glob('*.test.ts') if str(path) not in baseline)
 commands=[['pnpm','db:migrate'],['pnpm','db:seed']]
 if selected:commands.append(['pnpm','exec','tsx','--test','--test-concurrency=1',*selected])
 else:
  commands.append(['pnpm','exec','tsx','--test',*baseline])
  if additional:commands.append(['pnpm','exec','tsx','--test','--test-concurrency=1',*additional])
 for cmd in commands:subprocess.run(cmd,env=testenv,check=True)
finally:subprocess.run(['dropdb',*args,name],env=env,check=True)
PY2
