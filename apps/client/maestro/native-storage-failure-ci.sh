#!/usr/bin/env bash
# Dedicated disposable GitHub emulator only. No arbitrary package, path, serial or fault input.
# SDK receipts are synthetic-auth/HTTP emulator evidence; permission failure is never a JS throw.
set -Eeuo pipefail
: "${KS_APK:?}" "${KS_OUT:?}" "${RUNNER_TEMP:?}"
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || exit 78
[[ ${KS_NATIVE_DURABILITY_CI:-} == true && ${KS_GALLERY:-} == true ]] || exit 78
[[ ${KS_APP_ID:-com.knowscroll.client} == com.knowscroll.client ]] || exit 78
app=com.knowscroll.client
base=/data/user/0/com.knowscroll.client
sql=$base/files/SQLite
prefs=$base/shared_prefs
xml=$prefs/SecureStore.xml
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$KS_OUT/reports" "$KS_OUT/logs" "$KS_OUT/screenshots" "$KS_OUT/maestro"
serial=$(timeout 15 adb get-serialno | tr -d '\r')
[[ $serial =~ ^emulator-[0-9]+$ ]] || exit 78
[[ $(timeout 15 adb shell getprop ro.kernel.qemu | tr -d '\r') == 1 ]] || exit 78
active_fault=none
sql_mode= prefs_mode= xml_mode= sql_meta= prefs_meta= xml_meta=
metadata() { timeout 15 adb shell "stat -c '%a:%u:%g' '$1'; ls -Zd '$1'" | tr -d '\r'; }
restore() {
  local result=0
  if [[ $active_fault == sqlite ]]; then
    timeout 15 adb shell "chmod '$sql_mode' '$sql'" >/dev/null || result=1
    [[ $(metadata "$sql") == "$sql_meta" ]] || result=1
  elif [[ $active_fault == secure ]]; then
    timeout 15 adb shell "chmod '$xml_mode' '$xml'; chmod '$prefs_mode' '$prefs'" >/dev/null || result=1
    [[ $(metadata "$prefs") == "$prefs_meta" && $(metadata "$xml") == "$xml_meta" ]] || result=1
  fi
  if (( result == 0 )); then active_fault=none; fi
  return "$result"
}
raw_log=$RUNNER_TEMP/native249-private-logcat.txt
log_pid=
finish() {
  local status=$?
  trap - EXIT INT TERM
  if ! restore; then status=1; printf '%s\n' 'RESTORATION_FAILED' > "$KS_OUT/logs/restoration.txt"; fi
  if [[ -n $log_pid ]]; then kill "$log_pid" 2>/dev/null || true; wait "$log_pid" 2>/dev/null || true; fi
  # Raw SDK errors/SQL/SharedPreferences diagnostics never enter the uploaded evidence.
  if [[ -f $raw_log ]]; then
    if awk -v package="$app" '/FATAL EXCEPTION/ {remaining=4} remaining>0 {if(index($0,"Process: "package)>0) crash=1; remaining--} END {exit(!crash)}' "$raw_log" || grep -qE "ANR in $app|>>> $app <<<" "$raw_log"; then
      printf '%s\n' 'appCrashOrANR=true' > "$KS_OUT/logs/crash-summary.txt"; status=1
    else printf '%s\n' 'appCrashOrANR=false' > "$KS_OUT/logs/crash-summary.txt"; fi
    rm -- "$raw_log"
  fi
  local required
  for required in restart cold-sqlite correlated-ack secure-falsecommit acknowledged-cleanup; do
    if [[ ! -f $KS_OUT/reports/$required.xml ]]; then
      result "$required" UNAVAILABLE
      if (( status == 0 )); then status=78; fi
    fi
  done
  printf 'exit=%s\nrestoration=%s\n' "$status" "$active_fault" > "$KS_OUT/logs/final-status.txt"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
result() {
  local name=$1 status=$2
  if [[ $status == PASS ]]; then
    printf '<testsuite name="native249-%s" tests="1" failures="0" errors="0"><testcase name="%s"/></testsuite>\n' "$name" "$name" > "$KS_OUT/reports/$name.xml"
  else
    printf '<testsuite name="native249-%s" tests="1" failures="0" errors="1"><testcase name="%s"><error type="%s">Finite CI capability or assertion unavailable; never a pass.</error></testcase></testsuite>\n' "$name" "$name" "$status" > "$KS_OUT/reports/$name.xml"
  fi
  printf '%s=%s\n' "$name" "$status" >> "$KS_OUT/logs/cases.txt"
}
flow() {
  local phase=$1 action=$2
  case "$phase:$action" in seed-ready:none|restored-ready:none|sqlite-unavailable:none|acked-ready:complete|secure-failed-commit:fault|complete:retry) ;; *) return 78 ;; esac
  timeout 100 maestro test -e "PHASE=$phase" -e "ACTION=$action" --format junit --output "$KS_OUT/reports/flow-$phase.xml" --test-output-dir "$KS_OUT/maestro/$phase" --debug-output "$KS_OUT/maestro/$phase" "$here/scoped-durability.yaml" > "$KS_OUT/logs/flow-$phase.log" 2>&1
}
identity() {
  local pid
  pid=$(timeout 15 adb shell pidof "$app" | tr -d '\r')
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  # Fixed app process comm has no spaces. Kernel field22 distinguishes PID reuse.
  local start
  start=$(timeout 15 adb shell "cat /proc/$pid/stat" | awk '{print $22}' | tr -d '\r')
  [[ $start =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s' "$pid" "$start"
}
stop() {
  timeout 15 adb shell am force-stop "$app" >/dev/null
  for _ in $(seq 1 50); do
    if ! timeout 5 adb shell pidof "$app" >/dev/null 2>&1; then return 0; fi
    sleep .2
  done
  return 1
}
launch() {
  case "$1" in seed|restore|sqlite-denied) ;; *) return 78 ;; esac
  timeout 20 adb shell am start -W -a android.intent.action.VIEW -d "knowscroll://gallery-durability?scenario=native249-v1\&mode=$1" -p "$app" >/dev/null
}
# Fresh disposable installation only. No pm clear, uninstall, reinstall or replacement thereafter.
if ! installed=$(timeout 15 adb shell pm list packages "$app" | tr -d '\r'); then result fresh-install UNAVAILABLE; exit 78; fi
[[ -z $installed ]] || { result fresh-install UNAVAILABLE; exit 78; }
unzip -p "$KS_APK" assets/index.android.bundle > "$RUNNER_TEMP/native249-embedded.bundle"
grep -a -q 'ks-native-durability-bootstrap-v1' "$RUNNER_TEMP/native249-embedded.bundle" || { result dedicated-apk FAILED; exit 1; }
grep -a -q 'ks-native-durability-screen-v1' "$RUNNER_TEMP/native249-embedded.bundle" || { result dedicated-apk FAILED; exit 1; }
timeout 60 adb install -t "$KS_APK" > "$KS_OUT/logs/install.txt" 2>&1
timeout 15 adb logcat -c >/dev/null 2>&1
timeout 1200 adb logcat -v threadtime > "$raw_log" 2>&1 & log_pid=$!
launch seed
if ! flow seed-ready none; then result restart FAILED; result cold-sqlite UNAVAILABLE; result secure-falsecommit UNAVAILABLE; exit 1; fi
before=$(identity)
stop
launch restore
if ! flow restored-ready none; then result restart FAILED; result cold-sqlite UNAVAILABLE; result secure-falsecommit UNAVAILABLE; exit 1; fi
after=$(identity)
[[ $before != "$after" ]] || { result restart FAILED; exit 1; }
printf 'seed=%s\nrestore=%s\nsameAPKAndData=true\n' "$before" "$after" > "$KS_OUT/logs/process-identities.txt"
result restart PASS
# Debug certificate is not a capability. Record actual debuggability/run-as/root/UID/SELinux.
run_as=false
if timeout 15 adb shell run-as "$app" id -u > "$RUNNER_TEMP/native249-run-as.txt" 2>/dev/null; then run_as=true; fi
root=false
if timeout 20 adb root > "$RUNNER_TEMP/native249-root.txt" 2>&1 && timeout 20 adb wait-for-device && [[ $(timeout 15 adb shell id -u | tr -d '\r') == 0 ]]; then root=true; fi
printf 'adbRoot=%s\nrunAs=%s\nselinux=%s\n' "$root" "$run_as" "$(timeout 15 adb shell getenforce | tr -d '\r')" > "$KS_OUT/logs/capability.txt"
if [[ $root != true ]]; then result cold-sqlite UNAVAILABLE; result secure-falsecommit UNAVAILABLE; exit 78; fi
kill "$log_pid" 2>/dev/null || true
wait "$log_pid" 2>/dev/null || true
timeout 1200 adb logcat -v threadtime >> "$raw_log" 2>&1 & log_pid=$!
uid=$(timeout 15 adb shell dumpsys package "$app" | sed -n 's/^[[:space:]]*userId=\([0-9]*\).*$/\1/p' | head -n 1 | tr -d '\r')
[[ $uid =~ ^[0-9]+$ ]] || { result cold-sqlite UNAVAILABLE; result secure-falsecommit UNAVAILABLE; exit 78; }
for path in "$base" "$sql" "$prefs" "$xml"; do
  canonical=$(timeout 15 adb shell "readlink -f '$path'" | tr -d '\r')
  alternate="/data/data/com.knowscroll.client${path#"$base"}"
  [[ $canonical == "$path" || $canonical == "$alternate" ]] || { result capability UNAVAILABLE; exit 78; }
  [[ $(timeout 15 adb shell "stat -c %u '$path'" | tr -d '\r') == "$uid" ]] || { result capability UNAVAILABLE; exit 78; }
  timeout 15 adb shell "test ! -L '$path'" || { result capability UNAVAILABLE; exit 78; }
done
sql_meta=$(metadata "$sql"); prefs_meta=$(metadata "$prefs"); xml_meta=$(metadata "$xml")
sql_mode=${sql_meta%%:*}; prefs_mode=${prefs_meta%%:*}; xml_mode=${xml_meta%%:*}
[[ $sql_mode =~ ^[0-7]{3,4}$ && $prefs_mode =~ ^[0-7]{3,4}$ && $xml_mode =~ ^[0-7]{3,4}$ ]] || exit 78
printf 'sqlite=%s\nprefs=%s\nxml=%s\n' "$sql_meta" "$prefs_meta" "$xml_meta" > "$KS_OUT/logs/original-metadata.txt"
# Process death closes ALL default adapter/reader descriptors before cold SQLite denial.
stop
active_fault=sqlite
if ! timeout 15 adb shell "chmod 000 '$sql'" >/dev/null; then result cold-sqlite UNAVAILABLE; result secure-falsecommit UNAVAILABLE; exit 78; fi
launch sqlite-denied
if ! flow sqlite-unavailable none; then result cold-sqlite FAILED; exit 1; fi
stop
restore
launch restore
if ! flow restored-ready none; then result cold-sqlite FAILED; exit 1; fi
result cold-sqlite PASS
if ! flow acked-ready complete; then result correlated-ack FAILED; exit 1; fi
result correlated-ack PASS
# A pre-existing Android backup preference file would make the fault's original state ambiguous.
timeout 15 adb shell "test ! -e '$xml.bak'" || { result secure-falsecommit UNAVAILABLE; exit 78; }
# Warm loaded SharedPreferences; deny both directory atomic replacement and XML writes. Do not
# change UID/GID/SELinux, arbitrary paths or permissions on any other package.
active_fault=secure
if ! timeout 15 adb shell "chmod 500 '$prefs' && chmod 400 '$xml'" >/dev/null; then result secure-falsecommit UNAVAILABLE; exit 78; fi
if ! flow secure-failed-commit fault; then result secure-falsecommit FAILED; exit 1; fi
restore
if ! flow complete retry; then result secure-falsecommit FAILED; exit 1; fi
result secure-falsecommit PASS
result acknowledged-cleanup PASS
# Independent safe final screenshot; raw logcat is reduced to a crash/ANR boolean by EXIT.
timeout 20 adb exec-out screencap -p > "$KS_OUT/screenshots/native249-complete.png"
printf '%s\n' 'Synthetic HTTP/auth fixture; actual default SDK. Restart/cold-SQLite/ERR_WRITE branch are separate receipts. No real service/iOS/power-loss/backup restoration/forensic proof.' > "$KS_OUT/summary.md"
