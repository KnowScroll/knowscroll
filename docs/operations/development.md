# Development on the external SSD

## This machine

Apple Silicon macOS. At inspection: about 43 GiB free internally and 596 GiB on the SSD. Reused Node22.23.0, pnpm10.30.3, JDK17 and Homebrew PostgreSQL16.14. GitHub CLI is authenticated with repo/project access. Existing PostgreSQL and Redis services were not changed; Docker is installed but unnecessary for this setup.

| Storage | Location |
|---|---|
| Main repository | `/Volumes/Mrigesh SSD/knowscroll-product` |
| Parallel worktrees | `/Volumes/Mrigesh SSD/knowscroll-worktrees` |
| SDK, images, AVD | `knowscroll-dev/android-sdk`, `android-avd`, `android-user` on SSD |
| Gradle / package caches | `knowscroll-dev/gradle`, `pnpm-store`, `npm-cache`, `corepack` |
| Development DB | `knowscroll-dev/postgres`, loopback port55432 |
| Media / model artifacts / temporary files | `knowscroll-dev/media`, `models`, `tmp` |
| Android Studio | `/Volumes/Mrigesh SSD/Applications/Android Studio.app` |
| Studio indexes/logs/plugins | SSD via `scripts/studio.sh` |

Small existing system tools, OS preferences and credentials remain in their normal protected locations. We did not move system-critical directories or existing caches. Always mount the SSD before starting the project; stop the database/emulator before ejecting it.

## SSD storage requirement

The owner reaffirmed on2026-09-17 that the Mac's internal storage is constrained. Keep all new project worktrees, dependency/build caches, database files, emulator images, test artifacts and command logs on `/Volumes/Mrigesh SSD`. Source `scripts/env.sh` before every build/test/install shell so `TMPDIR`, Gradle, Android and package caches resolve to `knowscroll-dev`. Write worker/coordinator logs under `knowscroll-dev/tmp`, including commands that previously used `/tmp`; do not let an unsourced Gradle run create another SDK/distribution cache under the home directory. Codex's application/session storage is app-managed and is not relocated by project tooling. Do not delete unrelated files to create space.

## First setup / normal start

From the repository root:

```sh
. ./scripts/env.sh
pnpm install --frozen-lockfile
./scripts/dev-init.sh
pnpm dev:api
# In another terminal, from the same root:
. ./scripts/env.sh
pnpm dev:worker
```

The initializer creates a random local database password and development token in ignored `.env` (mode0600), initializes only the dedicated cluster, applies migrations and seeds three sourced Scrolls without overwriting existing content. Do not use this local bearer identity for deployment; production start is guarded. PostgreSQL binaries must be on PATH; the Mac environment script adds the installed Homebrew location.

### Local device sessions

API startup enrolls the configured development token once for the existing owner universe. It then follows the same server-side expiry, revocation and epoch checks as other sessions. Restarting the API does not renew or restore it. Do not delete its row to bypass revocation.

Operators can provision an independent universe and device session into a new private credential file:

```sh
pnpm exec tsx scripts/provision-session.ts --out artifacts/device-session.json
```

Use `--universe-id UUID` only to enroll another device in an existing universe. Optional `--device-id UUID` records the device binding; `--expires-in-hours N` accepts 1–720 hours (default 720). The file contains a bearer credential: keep it local, outside Git or in an ignored directory, and do not copy it into logs or evidence. The command refuses an existing destination. This is trusted operator provisioning, not public signup, account recovery or verified personal identity. Mobile session-switching UX remains future work.

`GET /v1/session` returns non-secret metadata. `POST /v1/session/revoke` with `{}` revokes the caller's session; later requests return 401, including after API restart. Requests already holding the universe lock may finish before revocation commits. Expired or old-epoch sessions also return 401. Re-enrollment requires an explicitly minted replacement token; never silently extend an old token.

Privacy epochs fence queued projection and old decision/exposure references. The confirmed `POST /v1/history/clear` operation advances the epoch and clears scoped bootstrap history under [ADR-0010](../decisions/0010-clear-scroll-history.md). Its persisted request UUID makes ambiguous retries safe. The caller stays enrolled; other device sessions become stale. Shared editorial assets and minimal clear receipts remain. This is not account deletion, backup erasure, personalization pause or semantic reset. Never manually advance an owner epoch as an improvised privacy operation.

`./scripts/db-start.sh` / `./scripts/db-stop.sh` control only the project cluster. API/worker stop with Ctrl-C. `pnpm state` queries actual migrations/jobs/heartbeats and health; a historical receipt never means a service is still running.

### Migration integrity

`pnpm db:migrate` records SHA-256 checksums and serializes migration runners in one transaction. Applied migrations must remain an ordered prefix of the files on disk; changed, missing or inserted earlier files fail before pending SQL commits. Add a new numbered migration instead of editing an applied file.

Existing bootstrap installations can adopt a checksum only for the pinned original `0001_bootstrap.sql`. This verifies the known migration file, not whether someone manually changed a historical database schema. An unknown checksum-less migration needs an explicit reviewed recovery decision; never delete migration history or reset personal state to bypass the error. `pnpm test` checks fresh installation, legacy adoption, drift, rollback and concurrent execution in a disposable database.

## Android

```sh
. ./scripts/env.sh
./scripts/mobile-config.sh    # writes ignored local.properties without printing token
cd apps/mobile
./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
# Start emulator in another terminal with the same environment:
emulator -avd KnowScroll_API36 -no-snapshot -no-audio -memory 2048
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.knowscroll.mobile/.MainActivity
```

Emulator API URL is `http://10.0.2.2:4310`, forwarding to host loopback. On a USB device, use `adb reverse tcp:4310 tcp:4310` and build with `KS_DEBUG_API_BASE=http://127.0.0.1:4310` in local.properties. Never bind this development API publicly. Cleartext is allowed only in debug. A release build refuses until the owner's signing and API inputs are given; see [release inputs](release-inputs.md).

Run `./scripts/studio.sh` for the IDE with SSD indexes/plugins/logs and the same Gradle/SDK environment. Android Studio may show first-run setup; point it at the existing SSD SDK rather than installing another SDK internally.

## Reproduce on a clean Mac

Install maintained Node22.23+, pnpm10.30.3, PostgreSQL16 and JDK17 from their official sources. Choose an SSD development root by exporting `KS_DEV_ROOT` before sourcing scripts/env.sh, and override JAVA_HOME if the JDK differs. Download Android Studio for Apple Silicon from the [official page](https://developer.android.com/studio), command-line tools into `$ANDROID_HOME/cmdline-tools/latest`, and use the supplied pinned Gradle wrapper.

This bootstrap verified Google command-line tools revision23 (`commandlinetools-mac_arm64-16111833_latest.zip`), SHA1 `ad03dc49bfacfd52c110b14104ea548b8a07e830`, and Studio2026.1.4.7. Current sdkmanager delegates to Android CLI; `avdmanager` still supplies explicit AVD naming.

```sh
android --sdk "$ANDROID_HOME" sdk install 'platforms;android-37.2'
android --sdk "$ANDROID_HOME" sdk install 'build-tools;36.0.0'
android --sdk "$ANDROID_HOME" sdk install platform-tools
android --sdk "$ANDROID_HOME" sdk install emulator
android --sdk "$ANDROID_HOME" sdk install 'system-images;android-36;google_apis;arm64-v8a'
printf 'no\n' | avdmanager create avd -n KnowScroll_API36 \
  -k 'system-images;android-36;google_apis;arm64-v8a' -d pixel_7 \
  -p "$ANDROID_AVD_HOME/KnowScroll_API36.avd"
```

Install SDK packages sequentially: concurrent Android CLI downloads produced a temporary-file collision during setup; a sequential retry succeeded. Installed emulator37.1.11 and API36 Google APIs arm64 image revision7. No NDK is required for current sources. Accept the official SDK license as required by the installer.

## Verification and secrets

`python3 scripts/android-journey.py` (after sourcing scripts/env.sh) creates a disposable PostgreSQL database, runs API/worker on port4311, installs a separate `.journey` app, and proves process-death restoration, keep/recreation, unavailable-server behavior and compact-screen recovery. It preserves the normal development database and app. Receipts/screenshots go to ignored artifacts/android-journey; reviewed snapshots belong in docs/journeys/evidence.

`pnpm exec tsx scripts/run-isolated-journey.ts` creates disposable actual/decoy databases and a dynamic API port, verifies real HTTP/worker/database lineage, and rejects the wrong verifier database. It accepts DATABASE_URL from the environment when no local `.env` exists and is exercised in CI.

`pnpm exec tsx scripts/run-isolated-session-journey.ts` verifies the [J002 session and epoch journey](../journeys/J002.md) with separately launched API/worker processes and disposable PostgreSQL data. It provisions two universes without modifying normal owner data.

`pnpm exec tsx scripts/run-isolated-history-journey.ts` verifies J003 across two disposable universes. `python3 scripts/android-history-journey.py` uses ports4311/4316 and the separate `.journey` app to verify confirmation, clear, a genuinely lost HTTP response, force-stop restoration and epoch-driven cache removal. Run Android journey scripts sequentially with one booted emulator.

`pnpm test` creates a uniquely named `knowscroll_test_*` database, migrates and seeds it, and runs each test file alone in its own copy of it; it removes only those disposable databases. A file never sees another file's rows, so a test cannot depend on the order files run in. `pnpm verify:journey` mutates the selected real development universe by keeping one asset; library exhaustion is an honest result. [J001](../journeys/J001.md) separates API and Android proof.

No provider key is needed for these journeys. The separate [MiniMax certification CLI](minimax-certification.md) implements ADR-0011: fixed synthetic requests, subscription-only route, fresh quota checks and durable bounded reservations. Ordinary jobs remain provider-free; #7 still owns the full Reasoning Plane. The owner-reported token allowance does not establish arbitrary cash spending permission. The Cutroom task needs `CUTROOM_BASE_URL`, a reachable host and a safe artifact import route. Configure secrets locally or in a deployment secret store; never put them in mobile, GitHub issues, evidence or commits. Withhold provider credentials from processes that do not need them.
