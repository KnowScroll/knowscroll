#!/bin/sh
# Runs the KnowScroll server playbook from the operator's Mac (#201).
#   ops/vps/ansible/run.sh --check --diff   # preview: what would change on the server
#   ops/vps/ansible/run.sh                  # apply
# Ansible lives in a virtualenv on the external SSD and keeps its state there too.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${KS_DEV_ROOT:=/Volumes/Mrigesh SSD/knowscroll-dev}"
venv="$KS_DEV_ROOT/tools/ansible-venv"
export ANSIBLE_HOME="$KS_DEV_ROOT/ansible-home"
export ANSIBLE_LOCAL_TEMP="$ANSIBLE_HOME/tmp"
export ANSIBLE_CONFIG="$here/ansible.cfg"
mkdir -p "$ANSIBLE_LOCAL_TEMP"
cd "$here"
exec "$venv/bin/ansible-playbook" site.yml "$@"
