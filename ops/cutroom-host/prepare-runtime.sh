#!/bin/sh
# ADR-0021 section 3 — verifies (or, only when a target does not yet exist, prepares) a detached,
# pinned Cutroom runtime checkout on the external SSD.
#
#   ops/cutroom-host/prepare-runtime.sh <canonical-clone> <revision> <target-dir>
#
# This worker's own use of this script is VERIFY-ONLY, against the runtime named in
# docs/decisions/0021-cutroom-successor-pin-and-local-host.md. It never creates another runtime:
# the create path below exists so the script is complete and its own argument validation can be
# tested, but no git-mutating command in this script has been run by this worker.
#
# Verify mode (target exists): checks HEAD == revision, no tracked changes, node_modules present,
# steering-ref initialized at the superproject's recorded gitlink, and ffmpeg/ffprobe on PATH.
# Prints one JSON line and exits 0, or exits nonzero naming the first failing check.
#
# Create mode (target absent): git -C <clone> fetch origin; git -C <clone> worktree add --detach
# <target> <revision>; git -C <target> submodule update --init; then an install through a WORKING
# corepack (the nvm-managed corepack on this Mac is known broken with signing keys):
#   /usr/local/bin/corepack pnpm install --frozen-lockfile --store-dir "$KS_DEV_ROOT/pnpm-store"

set -eu

usage() {
  echo 'usage: prepare-runtime.sh <canonical-clone> <revision> <target-dir>' >&2
  exit 2
}

[ $# -eq 3 ] || usage
CLONE=$1
REVISION=$2
TARGET=$3

case "$TARGET" in
  "/Volumes/Mrigesh SSD"/*) ;;
  *)
    printf '%s\n' '{"verified":false,"check":"target-on-ssd","detail":"target must be under /Volumes/Mrigesh SSD"}'
    exit 2
    ;;
esac

if ! printf '%s' "$REVISION" | grep -Eq '^[0-9a-fA-F]{40}$'; then
  printf '%s\n' '{"verified":false,"check":"revision-format","detail":"revision must be a 40-character hex string"}'
  exit 2
fi

if [ -e "$TARGET" ]; then
  # ---------------------------------------------------------------------------------------
  # Verify mode.
  # ---------------------------------------------------------------------------------------
  FAIL=""
  DETAIL=""

  ACTUAL_HEAD=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null) || { FAIL="head"; DETAIL="could not read HEAD of '$TARGET'"; }
  if [ -z "$FAIL" ] && [ "$ACTUAL_HEAD" != "$REVISION" ]; then
    FAIL="head"; DETAIL="HEAD is $ACTUAL_HEAD, expected $REVISION"
  fi

  if [ -z "$FAIL" ]; then
    STATUS=$(git -C "$TARGET" status --porcelain --untracked-files=no) || { FAIL="clean"; DETAIL="could not read git status of '$TARGET'"; }
    if [ -z "$FAIL" ] && [ -n "$STATUS" ]; then
      FAIL="clean"; DETAIL="tracked changes present: $STATUS"
    fi
  fi

  if [ -z "$FAIL" ] && [ ! -d "$TARGET/node_modules" ]; then
    FAIL="node_modules"; DETAIL="node_modules is not present under '$TARGET'"
  fi

  RECORDED=""
  if [ -z "$FAIL" ]; then
    RECORDED=$(git -C "$TARGET" ls-tree HEAD steering-ref 2>/dev/null | awk '{print $3}')
    if [ -z "$RECORDED" ]; then
      FAIL="steering-ref"; DETAIL="superproject records no steering-ref gitlink at HEAD"
    else
      ACTUAL_SUB=$(git -C "$TARGET/steering-ref" rev-parse HEAD 2>/dev/null) || { FAIL="steering-ref"; DETAIL="steering-ref submodule is not initialized"; }
      if [ -z "$FAIL" ] && [ "$ACTUAL_SUB" != "$RECORDED" ]; then
        FAIL="steering-ref"; DETAIL="steering-ref is at $ACTUAL_SUB, superproject records $RECORDED"
      fi
    fi
  fi

  if [ -z "$FAIL" ] && ! command -v ffmpeg >/dev/null 2>&1; then
    FAIL="ffmpeg"; DETAIL="ffmpeg not found on PATH"
  fi
  if [ -z "$FAIL" ] && ! command -v ffprobe >/dev/null 2>&1; then
    FAIL="ffprobe"; DETAIL="ffprobe not found on PATH"
  fi

  if [ -n "$FAIL" ]; then
    printf '{"verified":false,"target":"%s","revision":"%s","check":"%s","detail":"%s"}\n' "$TARGET" "$REVISION" "$FAIL" "$DETAIL"
    exit 1
  fi

  printf '{"verified":true,"target":"%s","revision":"%s","nodeModules":true,"steeringRef":"%s","ffmpeg":true,"ffprobe":true}\n' \
    "$TARGET" "$REVISION" "$RECORDED"
  exit 0
fi

# -----------------------------------------------------------------------------------------
# Create mode. Only argument validation above this point has ever been exercised by a worker;
# nothing below has been run against a real clone by this lane (ADR-0021 §3, "PINNED CUTROOM
# RUNTIME (READ-ONLY)"). KS_DEV_ROOT must be set for the pnpm store path below.
# -----------------------------------------------------------------------------------------

if [ ! -e "$CLONE/.git" ]; then
  printf '{"verified":false,"check":"clone","detail":"canonical clone not found at %s"}\n' "$CLONE"
  exit 2
fi

: "${KS_DEV_ROOT:?KS_DEV_ROOT must be set (source scripts/env.sh) to place the pnpm store on the SSD}"

git -C "$CLONE" fetch origin
git -C "$CLONE" worktree add --detach "$TARGET" "$REVISION"
git -C "$TARGET" submodule update --init
(cd "$TARGET" && /usr/local/bin/corepack pnpm install --frozen-lockfile --store-dir "$KS_DEV_ROOT/pnpm-store")

printf '{"verified":true,"target":"%s","revision":"%s","created":true}\n' "$TARGET" "$REVISION"
