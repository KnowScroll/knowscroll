#!/bin/sh
# Copies the VPS database backups to the external SSD (#228, docs/v2/operations/backups.md).
#
#   ops/vps/pull-backups.sh
#
# Runs on the operator's Mac over the agent key (host alias `knowscroll-vps` in ~/.ssh/config).
# Copies /srv/knowscroll/backups/ (nightly dumps, status.json, restore-check.json) into
# $KS_DEV_ROOT/backups/vps/, keeping the server's 0700/0600 modes. It never deletes on the Mac, so
# the copy keeps dumps the server has already rotated away; prune it by hand if it grows.
# Backups are personal data: they stay on the SSD, never in Git, never in a report.
set -eu
: "${KS_DEV_ROOT:=/Volumes/Mrigesh SSD/knowscroll-dev}"
host=${KS_VPS_HOST:-knowscroll-vps}
dest=$KS_DEV_ROOT/backups/vps

[ -d "$KS_DEV_ROOT" ] || { echo "$KS_DEV_ROOT is not there (is the SSD mounted?)" >&2; exit 1; }
umask 077
mkdir -p "$dest"
chmod 700 "$KS_DEV_ROOT/backups" "$dest"

# -r recursive, -t times, -p the server's modes (0700 folders, 0600 files); never owners.
# Lock and half-written files start with a dot and are left behind.
rsync -rtp --exclude='.*' -e 'ssh -o BatchMode=yes' "$host:/srv/knowscroll/backups/" "$dest/"
echo "backups copied to $dest"
