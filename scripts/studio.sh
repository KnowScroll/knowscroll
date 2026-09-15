#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
. ./scripts/env.sh
export STUDIO_PROPERTIES="$KS_DEV_ROOT/studio.properties"
cat > "$STUDIO_PROPERTIES" <<EOF
idea.system.path=$KS_DEV_ROOT/studio-system
idea.log.path=$KS_DEV_ROOT/studio-logs
idea.plugins.path=$KS_DEV_ROOT/studio-plugins
EOF
exec '/Volumes/Mrigesh SSD/Applications/Android Studio.app/Contents/MacOS/studio' "$PWD/apps/mobile"
