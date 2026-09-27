#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
# Optional arguments name test files to run instead of the whole suite: scripts/test.sh tests/x.test.ts
# One disposable database is migrated and seeded; each file then runs alone in its own copy of it,
# dropped afterwards, so no file sees another file's rows. (A library shared by every file grew with
# each fixture until a cold reader's Scroll sat beyond what one feed trip may skip.)
python3 - "$@" <<'PY2'
from pathlib import Path
from urllib.parse import urlparse,urlunparse
import os,subprocess,sys,uuid
config=dict(x.split('=',1) for x in Path('.env').read_text().splitlines() if '=' in x and not x.startswith('#')) if Path('.env').exists() else {}
u=urlparse(os.environ.get('DATABASE_URL',config.get('DATABASE_URL','')))
if not u.hostname:raise SystemExit('DATABASE_URL is required')
name='knowscroll_test_'+uuid.uuid4().hex
env={**os.environ,'PGPASSWORD':u.password or ''}
args=['-h',u.hostname,'-p',str(u.port or 5432),'-U',u.username]
url=lambda db:urlunparse(u._replace(path='/'+db))
if any(a.startswith('-') for a in sys.argv[1:]):raise SystemExit('scripts/test.sh takes test files only')
files=sys.argv[1:] or sorted(str(path) for path in Path('tests').glob('*.test.ts'))
subprocess.run(['createdb',*args,name],env=env,check=True)
try:
 for cmd in (['pnpm','db:migrate'],['pnpm','db:seed']):subprocess.run(cmd,env={**env,'DATABASE_URL':url(name)},check=True)
 failed=[]
 for i,file in enumerate(files):
  copy=f'{name}_{i}'
  subprocess.run(['createdb',*args,'-T',name,copy],env=env,check=True)
  try:
   if subprocess.run(['pnpm','exec','tsx','--test',file],env={**env,'DATABASE_URL':url(copy)}).returncode:failed.append(file)
  # --force: a worker a failed test left behind cannot keep its copy, or stop the run.
  finally:subprocess.run(['dropdb','--force',*args,copy],env=env,check=True)
 if failed:raise SystemExit(f'{len(failed)} of {len(files)} test files failed: '+' '.join(failed))
finally:subprocess.run(['dropdb','--force',*args,name],env=env,check=True)
PY2
