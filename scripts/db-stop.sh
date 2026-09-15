#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
pg_ctl -D "$KS_DEV_ROOT/postgres" stop -m fast
