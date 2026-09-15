#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
if pg_ctl -D "$KS_DEV_ROOT/postgres" status >/dev/null 2>&1; then
 echo 'Project PostgreSQL is running.'
else
 pg_ctl -D "$KS_DEV_ROOT/postgres" -l "$KS_DEV_ROOT/postgres.log" start
fi
