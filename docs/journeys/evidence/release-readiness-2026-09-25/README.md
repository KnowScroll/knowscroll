# #168 release readiness — emulator evidence, 2026-09-25

ADR-0047. Setup:

- Stack: `scripts/android-hands-on.py up`, two runs. The databases were `knowscroll_test_hands_8b694686efee` and `knowscroll_test_hands_6d81a4851b67`, both dropped afterwards.
- The second run is after the helper's fix. The stack's owner is the fixed test address `hands-on@knowscroll.test`, and links go to the development sink.
- App: the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's preview was unchanged (`preview-untouched.json`).
- No screenshots are committed. One shows a sign-in token in the field; they stay in the ignored `artifacts/`.

## By hand

1. **A refused pause, and its Retry.**
   - I read and kept a Scroll. Then I cleared history through the API with the stack's development token, so the server's privacy epoch moved from 0 to 1 behind the app.
   - Pressing "Pause recording" was refused: "This changed just before it was applied. Reopen Privacy to review the current state and try again."
   - Retry paused recording in epoch 1. It did not re-send the stale envelope.
   - "Resume recording" turned recording back on.
2. **Export.** "Export my data", then "Save the export file".
   - The journey build writes to the app's own cache instead of the system picker (a path that predates #168): 1,830 bytes, mode 0600.
3. **Clear, with a kill.**
   - I read and kept a Scroll, then confirmed "Clear history" and force-stopped the app at once.
   - The Clear had landed (epoch 2). The relaunched app showed the cleared universe.
4. **Reset.** Confirmed "Reset history".
   - The epoch moved to 3, and the device was signed out.
   - The sign-in screen said "Your personal history was reset. Sign in again to continue."
5. **Sign in by link.**
   - On the first stack, "Send sign-in link" failed with "Connection interrupted", because the API refused every link (`invalid_config`). The helper had blanked the owner address; fixed in this PR.
   - On the second stack I signed out and requested a link: "Check your email…", and the sink was written.
6. **App Link.** The sink's token was opened as `https://links.knowscroll.invalid/sign-in#token=…`, with an explicit intent to `MainActivity` (a debug build declares no filter).
   - The link filled the paste field only; nothing was consumed.
   - "Sign in with this link" signed in.
   - The same link sent again to the signed-in app was ignored. The session survived a kill and a relaunch.
7. **Single-top, after the review.** Signed out, then opened a new link twice as a mail app would (`FLAG_ACTIVITY_NEW_TASK`).
   - One `MainActivity` record remained, the field held the link, and signing in worked.
8. **Privacy's paused line.** It showed the server's timestamp ("since 2026-09-24T22:53:58.425Z"). It now shows a localized date.

## Limits

- The App Link filter and domain verification need the owner's domain. Signing a real release needs the owner's keystore. The system save picker is not driven on the journey build.
- A release APK built with throwaway inputs passes `apksigner verify`. CI now builds and verifies one on every run.
- Debug API36 emulator, not a physical device.
