# The owner's preview guard, verified on the device — 2026-09-24 (#136)

`scripts/android_preview.py` now guards every runner that installs the `.journey` app, which is
the owner's running preview: the semantic, profile and #91 explain runners, the six older runners,
and `android-living-preview.py` in its verification mode (`--keep` is the preview's own setup and
installs it deliberately). Three runs on the API36 emulator:

| Run | What happened | `preview-restored.json` |
| --- | --- | --- |
| Profile runner with its service port held busy | failed during setup, before any install | `replaced: false`: the preview was left exactly as it was, and the backup was discarded (`early-failure-preview-restored.json`) |
| #91 reader-explain journey (9 phases) | replaced the preview, as every full run does | `replaced: true`, `dataVerified: true`: every file's name, size and SHA-256 matches the backup (`../reader-explain-2026-09-24/preview-restored.json`) |
| Semantic `places` journey | the same | `replaced: true`, `dataVerified: true` (`places-preview-restored.json`) |

After each run no data archive or pulled APK remained: both hold the preview's credentials and
are deleted only after a verified restore or an untouched check. The preview held no stored session in these runs (`sessionLost: false`). Had it held one (the vault
holding `token_ciphertext`, which is sealed by a keystore key that a data clear destroys), the guard
would have refused before touching anything, unless `KS_PREVIEW_ACCEPT_SIGN_OUT=1` was set. A
signed-out vault file holds no session and does not block a run.

The early-failure and places receipts committed here come from re-runs with the guard at
`guardSha256` 3f539b…. Two later changes were checked on synthetic archives, not re-run on the
device: the vault check now parses the XML (unreadable counts as signed in, so the run refuses),
and a kept backup is announced by path. The early failure now also compares the preview's data and reports
`dataUnchanged: true`: had the owner used the preview during the run, the backup would have been
kept rather than discarded. The explain receipt comes from the earlier run of the same logic.
