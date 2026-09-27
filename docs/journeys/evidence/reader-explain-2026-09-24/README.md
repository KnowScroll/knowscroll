# #91 reader-explain and sign-out journey, repaired — 2026-09-24 (#136)

`scripts/android-reader-explain-journey.py` had been failing on main. It was harness rot, fixed
without touching product code:

1. **The blank-reason fixture never applied.** The proxy compared the whole request target to
   `/v1/feed`, but the app sends `/v1/feed?kinds=Scroll`. It now compares the parsed path.
2. **The saved-trace phase looked in the wrong place.** It expected an event-id card on the
   universe screen. Saved Traces live in Keep and are described by their Scroll's title (#72
   audit A4), so the test now opens Keep from the dock and finds the card by title.
3. **The runner replaced the owner's `.journey` preview without a backup.** It now preserves and
   restores it (verified) through `scripts/android_preview.py`.

Result (`release.json`): all nine instrumentations passed. That covers the explain sheet for
discovery, a blank reason, a saved trace, rotation and process death, and the four sign-out cases
(cancel, confirmed revoke, dropped revoke then retry, already revoked), all with the domain-count
checks. The disposable database was dropped and the preview restored (`dataVerified: true`).

The receipt's source is `e1a38e0` plus the test change committed with this file; its per-file
SHA-256 list records the exact test and runner used. This runs on main with #147 merged, so the
sign-out end state is #147's sign-in screen.
