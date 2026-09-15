#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
python3 - <<'PY2'
from pathlib import Path
import os,secrets
root=Path(os.environ['KS_DEV_ROOT'])
env=Path('.env')
if not env.exists():
 password=secrets.token_hex(24)
 env.write_text(f'DATABASE_URL=postgresql://knowscroll:{password}@127.0.0.1:55432/knowscroll\nKS_DEV_TOKEN={secrets.token_hex(32)}\nPORT=4310\nMINIMAX_API_KEY=\nCUTROOM_BASE_URL=\n')
 env.chmod(0o600)
 (root/'postgres-password').write_text(password+'\n');(root/'postgres-password').chmod(0o600)
print('Local environment exists; no credentials printed.')
PY2
if [ ! -f "$KS_DEV_ROOT/postgres/PG_VERSION" ]; then
 initdb -D "$KS_DEV_ROOT/postgres" -U knowscroll --pwfile="$KS_DEV_ROOT/postgres-password" --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 --locale=C
 printf "\nport = 55432\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n" >> "$KS_DEV_ROOT/postgres/postgresql.conf"
fi
./scripts/db-start.sh
python3 - <<'PY2'
from pathlib import Path
import subprocess,os
from urllib.parse import urlparse
entries=dict(x.split('=',1) for x in Path('.env').read_text().splitlines() if '=' in x and not x.startswith('#'))
u=urlparse(entries['DATABASE_URL']);env={**os.environ,'PGPASSWORD':u.password}
base=['psql','-h',u.hostname,'-p',str(u.port),'-U',u.username,'-d','postgres','-tAc']
exists=subprocess.check_output(base+["SELECT 1 FROM pg_database WHERE datname='knowscroll'"],env=env,text=True).strip()
if not exists:subprocess.run(['createdb','-h',u.hostname,'-p',str(u.port),'-U',u.username,'knowscroll'],env=env,check=True)
PY2
pnpm db:migrate
pnpm db:seed
