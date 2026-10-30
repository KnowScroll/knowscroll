#!/usr/bin/env bash
# Installs the release APK on the booted emulator and runs the Maestro flows in this folder, one
# Maestro run per flow, so one failing flow never hides the screenshots of the others.
#
# Called by .github/workflows/native.yml inside reactivecircus/android-emulator-runner (the action
# runs each `script` line on its own, hence this file). Environment:
#   KS_APK      path of the APK to install
#   KS_OUT      output folder (created): screenshots/, reports/, logs/, maestro/, logcat.txt, summary.md
#   KS_GALLERY  "true" when the APK was built with EXPO_PUBLIC_KS_GALLERY=1 (default "false")
#   KS_APP_ID   application id (default com.knowscroll.client)
#   KS_TEST_API_ORIGIN  origin of the test API the APK was built for (http://127.0.0.1:<port>); when set, the
#               emulator reaches it through `adb reverse` and the journey flows run (empty: they are skipped)
#   KS_TEST_API_MAIL    the test API's recorded sign-in mail (mail.jsonl), where the journey reads its link
# Needs `adb` and `maestro` on PATH. Never run it on a developer machine's emulator by accident:
# it clears the app's data before every flow.
set -uo pipefail

: "${KS_APK:?KS_APK is the path of the APK}"
: "${KS_OUT:?KS_OUT is the output folder}"
gallery="${KS_GALLERY:-false}"
app_id="${KS_APP_ID:-com.knowscroll.client}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${ANDROID_HOME:-}" ]; then export PATH="$ANDROID_HOME/platform-tools:$PATH"; fi

mkdir -p "$KS_OUT/screenshots" "$KS_OUT/reports" "$KS_OUT/logs" "$KS_OUT/maestro"
summary="$KS_OUT/summary.md"
: > "$summary"

# ---------------------------------------------------------------------------------------------
# Device and APK
# ---------------------------------------------------------------------------------------------
adb wait-for-device
{
  echo "release=$(adb shell getprop ro.build.version.release | tr -d '\r')"
  echo "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "model=$(adb shell getprop ro.product.model | tr -d '\r')"
  echo "abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
  echo "size=$(adb shell wm size | tr -d '\r' | tail -n 1)"
  echo "density=$(adb shell wm density | tr -d '\r' | tail -n 1)"
  echo "maestro=$(maestro --version 2>/dev/null | tail -n 1)"
} | tee "$KS_OUT/device.txt"

# A hung background process (the launcher, while the Google apps of the image sync right after boot) is
# killed silently instead of covering the app with an "isn't responding" dialog that hides it from Maestro.
# An ANR of the app itself still fails the run: it is read from logcat below.
adb shell settings put global hide_error_dialogs 1 || true

# Let the system finish its post-boot work before the first flow: the 1-minute load average of the
# (3-core) guest, at most 3 minutes. The result is recorded, never a reason to fail.
settled="no"
for _ in $(seq 1 60); do
  load=$(adb shell cat /proc/loadavg | tr -d '\r' | cut -d' ' -f1)
  if awk -v l="$load" 'BEGIN { exit !(l < 2.0) }'; then settled="yes"; break; fi
  sleep 3
done
echo "load average after waiting for the system to settle: $load (settled: $settled)" | tee -a "$KS_OUT/device.txt"

echo "Installing $KS_APK"
adb install -r -t "$KS_APK" || { echo "adb install failed"; exit 1; }
adb shell pm list packages "$app_id" | grep -q "package:$app_id" || { echo "$app_id is not installed"; exit 1; }

# The test API runs on the runner; inside the emulator "127.0.0.1" is the emulator itself, so its port is forwarded.
test_api_origin="${KS_TEST_API_ORIGIN:-}"
if [ -n "$test_api_origin" ]; then
  test_api_port="${test_api_origin##*:}"
  adb reverse "tcp:$test_api_port" "tcp:$test_api_port" || { echo "adb reverse failed"; exit 1; }
fi

# Everything the device logs while the flows run (the buffer is enlarged so a slow run keeps its start).
adb logcat -b all -G 16M > /dev/null 2>&1 || true
adb logcat -c || true
adb logcat -v threadtime > "$KS_OUT/logcat.txt" 2>&1 &
logcat_pid=$!
trap 'kill "$logcat_pid" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------------------------
# Flows
# ---------------------------------------------------------------------------------------------
results=()
failed=0

# run_flow <name> <file> [extra maestro arguments, e.g. -e KEY=value]; sets flow_status to the flow's exit status.
flow_status=0
run_flow() {
  local name="$1" file="$2" started status elapsed outcome
  shift 2
  echo "::group::maestro: $name"
  started=$(date +%s)
  maestro test \
    --format junit --output "$KS_OUT/reports/$name.xml" \
    --test-output-dir "$KS_OUT/maestro/$name" \
    --debug-output "$KS_OUT/maestro/$name" \
    "$@" "$file" 2>&1 | tee "$KS_OUT/logs/$name.log"
  status=${PIPESTATUS[0]}
  flow_status=$status
  elapsed=$(($(date +%s) - started))
  echo "::endgroup::"
  outcome="passed"
  if [ "$status" -ne 0 ]; then
    outcome="FAILED"
    failed=1
  elif grep -rqE --include=maestro.log 'onCommandFinished: Run .*KS-LANE-SKIP.* COMPLETED' "$KS_OUT/maestro/$name"; then
    # A flow that found nothing to check says so itself (scroll-blocks.yaml: an evalScript that logs
    # KS-LANE-SKIP; Maestro keeps script output out of its console and records the command in its own
    # log). It is reported as skipped, never as a pass.
    outcome="skipped"
    echo "KS-LANE-SKIP $name: the flow found nothing to check in this build (see its maestro.log)"
  fi
  results+=("| $name | $outcome | ${elapsed}s |")
  echo "maestro $name: $outcome in ${elapsed}s"
}

run_flow shell "$here/shell.yaml"
run_flow tabs-and-back "$here/tabs-and-back.yaml"
run_flow universe "$here/universe.yaml"
if [ "$gallery" = "true" ]; then
  run_flow gallery "$here/gallery.yaml"
  run_flow scroll-blocks "$here/scroll-blocks.yaml"
  run_flow space "$here/space.yaml"
else
  echo "KS-LANE-SKIP gallery.yaml and scroll-blocks.yaml: this APK was built without EXPO_PUBLIC_KS_GALLERY=1"
  results+=("| gallery | skipped (APK built without the gallery) | - |" "| scroll-blocks | skipped (APK built without the gallery) | - |" "| space | skipped (APK built without the gallery) | - |")
  run_flow no-gallery "$here/no-gallery.yaml"
fi

# ---------------------------------------------------------------------------------------------
# Journey (test API): sign in with a bound link, explore, read, keep, restart, sign out
# ---------------------------------------------------------------------------------------------
# The three steps share one install and one address. Step 1 asks for the link through the screens; the
# test API records the mail instead of sending it, and the link is read from that file and turned into
# the app link (`knowscroll://redeem#token=...`). The token is single use and the database is thrown
# away with the runner. GitHub masks it in this job's log; Maestro's own logs in the uploaded
# artifacts still show it, which is harmless once the link is spent.
mail_link_for() {
  local address="$1" link
  for _ in $(seq 1 30); do
    link=$(jq -r --arg to "$address" 'select(.to == $to) | .link' "$KS_TEST_API_MAIL" 2>/dev/null | tail -n 1)
    if [ -n "$link" ]; then
      printf '%s' "$link" | sed -E 's#^https?://[^/]+/#knowscroll://#'
      return 0
    fi
    sleep 1
  done
  return 1
}

run_journey() {
  local address="journey-$(date +%s)@test.example" link
  run_flow journey-1-request-link "$here/journey-1-request-link.yaml" -e "EMAIL=$address"
  if [ "$flow_status" -ne 0 ]; then return; fi
  link=$(mail_link_for "$address") || { echo "journey: no sign-in mail for the address within 30 seconds"; failed=1; results+=("| journey-2-sign-in-and-explore | FAILED (no mail) | - |"); return; }
  echo "::add-mask::${link#*token=}"
  run_flow journey-2-sign-in-and-explore "$here/journey-2-sign-in-and-explore.yaml" -e "LINK=$link"
  if [ "$flow_status" -ne 0 ]; then return; fi
  run_flow journey-3-restart "$here/journey-3-restart.yaml" -e "EMAIL=$address"
}

if [ -n "$test_api_origin" ]; then
  run_journey
else
  echo "KS-LANE-SKIP journey: this APK was not built for a test API"
  results+=("| journey | skipped (APK not built for the test API) | - |")
fi

# ---------------------------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------------------------
# An independent capture of whatever is on screen at the end, whether or not Maestro produced any.
adb exec-out screencap -p > "$KS_OUT/screenshots/adb-final-screen.png" 2>/dev/null || true

# Maestro keeps `takeScreenshot` output in a folder per flow; the names are unique across flows.
find "$KS_OUT/maestro" -type f -name '*.png' -path '*takeScreenshot*' -print0 |
  while IFS= read -r -d '' png; do cp "$png" "$KS_OUT/screenshots/$(basename "$png")"; done

kill "$logcat_pid" 2>/dev/null || true
# The space page logs its frame numbers once a second (features/gallery/space-gallery-screen.tsx); the last line is the summary.
space_gate=$(grep -a "KS-SPACE-GATE" "$KS_OUT/logcat.txt" | tail -n 1 | sed -E 's/.*KS-SPACE-GATE //')
crash=0
if grep -E "FATAL EXCEPTION" -A 3 "$KS_OUT/logcat.txt" | grep -q "Process: $app_id"; then crash=1; fi
if grep -qE "ANR in $app_id" "$KS_OUT/logcat.txt"; then crash=1; fi
if grep -qE ">>> $app_id <<<" "$KS_OUT/logcat.txt"; then crash=1; fi

{
  echo "### native: emulator"
  echo
  echo "Evidence label: **emulator** (Android $(sed -n 's/^release=//p' "$KS_OUT/device.txt") / API $(sed -n 's/^sdk=//p' "$KS_OUT/device.txt"), $(sed -n 's/^abi=//p' "$KS_OUT/device.txt"), Maestro $(sed -n 's/^maestro=//p' "$KS_OUT/device.txt"))."
  echo
  echo "| Flow | Result | Time |"
  echo "|---|---|---|"
  printf '%s\n' "${results[@]}"
  echo
  echo "- screenshots: $(find "$KS_OUT/screenshots" -type f -name '*.png' | wc -l | tr -d ' ')"
  echo "- app crash or ANR in logcat: $([ "$crash" -eq 1 ] && echo YES || echo none)"
  echo "- space renderer (last frame numbers the page logged): ${space_gate:-none logged}"
} | tee -a "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$summary" >> "$GITHUB_STEP_SUMMARY"; fi

if [ "$crash" -eq 1 ]; then
  echo "The app crashed or stopped responding while the flows ran (see logcat.txt):"
  grep -E "FATAL EXCEPTION|>>> $app_id <<<|ANR in $app_id" -A 6 "$KS_OUT/logcat.txt" | head -n 40
  exit 1
fi
exit "$failed"
