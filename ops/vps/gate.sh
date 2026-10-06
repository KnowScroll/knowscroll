#!/bin/sh
# SSH forced command for a deploy key (#201). Each key is bound to one world in authorized_keys:
#   restrict,command="/usr/local/bin/ks-gate dev" ssh-ed25519 ...
# and may run only:  deploy <world> <commit> | promote <world> <commit> | has-release <commit>
set -eu
set -f
allowed=$1
# shellcheck disable=SC2086 # word splitting of the requested command is the point; globbing is off.
set -- ${SSH_ORIGINAL_COMMAND:-}
refuse() { echo "refused: $1" >&2; exit 2; }
is_commit() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
case "${1:-}" in
  has-release)
    if [ "$#" -ne 2 ] || ! is_commit "$2"; then refuse "usage: has-release <commit>"; fi
    exec sudo -n /usr/local/bin/ks has-release "$2"
    ;;
  deploy | promote)
    [ "$#" -eq 3 ] || refuse "usage: $1 <world> <commit>"
    [ "$2" = "$allowed" ] || refuse "this key deploys only $allowed"
    is_commit "$3" || refuse "the commit must be 40 lowercase hex characters"
    exec sudo -n /usr/bin/flock --timeout 1800 /run/knowscroll/deploy.lock /usr/local/bin/ks "$1" "$2" "$3"
    ;;
  *) refuse "only deploy, promote or has-release" ;;
esac
