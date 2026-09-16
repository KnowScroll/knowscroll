# Android bootstrap

Native Compose Universe → sourced Scroll → Keep → return. Uses the real development API and retains the complete retry envelope on-device. Token and SDK path live in ignored local.properties. See ../../docs/operations/development.md for setup.

Universe privacy controls include a confirmed **Clear Scroll history** action. It removes the current development universe's recorded encounters and Traces while preserving the shared Scroll library, and signs out its other device sessions. The app persists one request envelope before dispatch, retries that exact envelope after an uncertain response or process death, reconciles privacy epoch before restoring cached Scroll state, and purges stale local content when the server epoch advances.

Build: `./gradlew :app:assembleDebug :app:lintDebug`. Real emulator journey tests are under app/src/androidTest; they require the running local API/worker and consume an unkept starting asset. They are not fake network tests.

Not built: account deletion, backup-erasure guarantees, production login/recovery, full cosmic pan/zoom/world entry, video, horizontal branches, rich Scroll registry, or full offline sync. Cached current Scroll restores only after online privacy reconciliation; an uncertain clear or unavailable reconciliation fails closed. System sans temporarily substitutes for the visual reference fonts. Release variants are disabled.
