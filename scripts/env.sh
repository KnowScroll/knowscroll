#!/bin/sh
# Source this file from the repository root. No global shell or system changes.
export KS_DEV_ROOT="${KS_DEV_ROOT:-/Volumes/Mrigesh SSD/knowscroll-dev}"
export ANDROID_HOME="$KS_DEV_ROOT/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_AVD_HOME="$KS_DEV_ROOT/android-avd"
export ANDROID_USER_HOME="$KS_DEV_ROOT/android-user"
export GRADLE_USER_HOME="$KS_DEV_ROOT/gradle"
export npm_config_cache="$KS_DEV_ROOT/npm-cache"
export COREPACK_HOME="$KS_DEV_ROOT/corepack"
export TMPDIR="$KS_DEV_ROOT/tmp/"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$GRADLE_USER_HOME" "$npm_config_cache" "$COREPACK_HOME" "$TMPDIR"
