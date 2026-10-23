#!/bin/sh
# Starts one program of a world's current v2 release exactly as its release.json names it (#228).
# Installed by ops/vps/ansible as /usr/local/lib/knowscroll-ops/ks2-run and used by the units
# ks2-api@ and ks2-worker@:   ks2-run <world> <program>
# `ks` wrote .ks/programs/<program>.cwd and .argv from the verified release.json when the release
# arrived; the program runs as `/usr/bin/node <argv...>` in that folder, replacing this shell.
set -eu
world=$1
program=$2
release=$(readlink -f "/srv/knowscroll/$world/current")
spec=$release/.ks/programs/$program
cwd=$(cat "$spec.cwd")
set --
while IFS= read -r arg || [ -n "$arg" ]; do
  set -- "$@" "$arg"
done < "$spec.argv"
cd "$release/$cwd"
exec /usr/bin/node "$@"
