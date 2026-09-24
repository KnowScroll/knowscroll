# Owner access, privacy and release clients — evidence, 2026-09-24 (#135)

ADR-0034 (desktop session cookie with CSRF), ADR-0035 (account deletion), migration 0030. The
populated upgrade proof on a clone of the owner database is in
[owner-upgrade-2026-09-24](../owner-upgrade-2026-09-24/receipt.json).

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Cookie session | `tests/web-session.test.ts` (6) | the page never sees a token; a malformed cookie is no cookie (401, not 500); cookie reads work; every change needs the HMAC CSRF token and a same origin; one credential per request; sign-out and Reset end cookie sessions; production refuses to start without a secret and web origin; the emailed link is `<origin>/sign-in#token=…` with no query string |
| Account deletion | `tests/account-deletion.test.ts` (6, 3 mutants killed) | own confirmation literal and current epoch; an API restart never revives the development session; a magic-link request during a deletion waits for it instead of failing; one transaction removes the account, sign-in tokens, every session, dated privacy receipts and personal history, leaving an address-free tombstone; re-sign-in starts a new account on the empty universe; a cookie session needs CSRF and gets its cookie cleared; outside that transaction every guard still refuses |
| Web client | web unit tests; `scripts/run-web-owner-journey.ts` (Playwright, cookie-mode proxy, real API and disposable DB) | signed-out screen → magic link from the development sink → `/sign-in#token` (fragment removed at once; nothing consumed until the button) → reading → privacy → delete account → deleted screen; afterwards 0 accounts, 1 deletion receipt, 0 sessions (`../web-owner/last-run-receipt.json`) |
| Android client | Android unit + Robolectric tests; `KS_SEMANTIC_JOURNEY=owner` on the emulator | see below |

## The device journey (`android-owner-*`)

The `.journey` app is built **without** a development token, so the owner is greeted by sign-in
(`android-owner-01-sign-in.png`). The test requests a magic link for the owner's address. The host
runner picks it up from the run's private development sink and hands it to the app's own files
directory; the test pastes it. The app is then signed in with a Keystore-encrypted session and
reads a real Scroll (`android-owner-03-signed-in.png`). In Privacy & account the owner pauses and
resumes recording (`-05`, `-06`), exports (written to the app cache in the journey build instead of
the system file picker), then deletes the account after its own confirmation (`-09`). The app
returns to sign-in with "Your account and history were deleted." (`-10`).

SQL afterwards (`android-owner-receipt.json`): 0 accounts, 1 deletion receipt, 0 device sessions,
0 sign-in tokens. The device's own content-free receipt (`android-owner-account.json`) records each
step. The owner's preview was restored and verified (`android-preview-restored.json`). The sign-in
link never appears in a committed file: the screenshot of the pasted link is not kept, and the run's
scratch directory is removed afterwards.

First device runs, retained:
1. The app crashed at launch: the new view model had no `(Application)` constructor for the standard
   factory, which the JVM tests had bypassed. It was fixed with a factory test that failed first.
2. A tap on a below-the-fold control landed off-screen.
3. The link was pushed before the freshly installed app had a files directory.
4. A link left by an earlier run, already used, was pushed from a shared scratch path.

## Review

A fresh-context review (PR #147) found three blocking defects and two important ones, all fixed
test-first before these runs:
- A debug build carrying a development token opened on the sign-in screen, so every other journey
  would have stalled. It now opens on the reader; the `places` journey below is such a build.
- Both clients said "Your account and history were deleted" (or reset) after a 401 that arrived
  before the request was ever sent. Now only a request that may have landed counts.
- The old "Sign out this device" left a signed-in owner on a dead end.
- Deleting the account let the development session come back on the next API restart.
- The web client never refreshed a CSRF token it already held.

Runs on `d676fe6` (review fixes, main merged): backend 13 + 844, web 136, Android 261 + lint, the
`owner` journey (SQL: 0 accounts, 1 deletion receipt, 0 device sessions, 0 sign-in tokens) and the
`places` journey on a development-token build, each restoring the owner's preview.

## Limits

- The owner pastes the emailed link; Android App Links for tapping it directly are not set up.
- Debug API36 emulator, not a physical device; the development mail sink stands in for email.
- The earlier "Sign out this device" control (#91) remains next to Privacy & account; since the
  review it clears the stored session and ends on the sign-in screen.
- The #91 reader-explain runner (`scripts/android-reader-explain-journey.py`) fails its blank-reason
  explain phase on main as well as here (recorded on #136). Its four sign-out tests were run on
  this branch from a copy of the runner with that part removed, under the preview guard: all four
  passed (cancel is harmless, a confirmed revoke ends the session honestly, a dropped revoke then
  retry succeeds, an already-revoked session resolves as signed out) and the preview was restored
  and verified. That copy then stopped before writing its receipt (it still referred to the removed
  part), so there is no committed receipt for it; the instrumentation results are the evidence.
