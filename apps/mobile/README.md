# Android bootstrap

Native Compose Universe → sourced Scroll → Keep → return, with source access and deliberate next discovery at the end of a Scroll. Uses the real development API and retains the complete retry envelope on-device. Token and SDK path live in ignored local.properties. See ../../docs/operations/development.md for setup.

Universe privacy controls include a confirmed **Clear Scroll history** action. It removes the current development universe's recorded encounters and Traces while preserving the shared Scroll library, and signs out its other device sessions. The app binds private local state and pending requests to the authenticated universe, persists one request envelope before dispatch, retries that exact envelope after an uncertain response or process death, and reconciles universe identity plus privacy epoch before restoring cached Scroll state. A changed identity or newer epoch purges stale local content before it can be shown or replayed.

Build: `./gradlew :app:assembleDebug :app:lintDebug`. Real emulator journey tests are under app/src/androidTest; they require the running local API/worker and consume an unkept starting asset. They are not fake network tests.

Not built: account deletion, backup-erasure guarantees, production login/recovery, full cosmic pan/zoom/world entry, video, horizontal branches, rich Scroll registry, or full offline sync. Cached current Scroll restores only after online privacy reconciliation; an uncertain clear or unavailable reconciliation fails closed. System sans temporarily substitutes for the visual reference fonts. Release variants are disabled.

## Reader navigation (#74)

Home, Keep and Sources remain reachable while reading. Sources opens attribution and truth state in a sheet; Back returns to the same reader. The end-of-content discovery control fetches only after an explicit tap. Loading, transport failure/retry and finite-library rest preserve the current authorized page and retry identities. A scope change or rejected session purges private reading state. Position is synchronized to both durable storage and active UI state for Activity recreation and cold restoration.

For disposable joined verification, source `scripts/env.sh` from the repository root and run `python3 scripts/android-reader-journey.py`. It installs only `com.knowscroll.mobile.journey`, creates a fresh PostgreSQL database, starts separate API/worker processes and injects two socket closures at a loopback proxy. Successful responses still come from the real API. It uses ports4311/4316, restores font/display settings and removes its database after services exit. No provider credentials or requests are needed. Existing `scripts/android-journey.py` and `scripts/android-history-journey.py` remain regression checks; run sequentially because they share the journey app and ports.

Automated semantics and screenshot checks do not establish manual TalkBack traversal, owner visual acceptance or the required full mobile/desktop experience. Browser return preserves the reader; an external browser first-run screen does not prove the cited page loaded.
