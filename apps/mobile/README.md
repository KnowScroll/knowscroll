# Android bootstrap

Native Compose Universe → sourced Scroll → Keep → return. Uses the real development API and retains the complete retry envelope on-device. Token and SDK path live in ignored local.properties. See ../../docs/operations/development.md for setup.

Build: `./gradlew :app:assembleDebug :app:lintDebug`. Real emulator journey tests are under app/src/androidTest; they require the running local API/worker and consume an unkept starting asset. They are not fake network tests.

Not built: full cosmic pan/zoom/world entry, video, horizontal branches, rich Scroll registry, production auth, full offline sync. Cached current Scroll can restore after recreation; this is not a complete offline product. System sans temporarily substitutes for the visual reference fonts. Release variants are disabled.
