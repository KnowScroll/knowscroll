# The owner's preview guard, verified on the device — 2026-09-24 (#136)

`scripts/android_preview.py` now guards every runner that installs the `.journey` app, which is
the owner's running preview. Three runs on the API36 emulator:

| Run | What happened | `preview-restored.json` |
| --- | --- | --- |
| Profile runner with its service port held busy | failed during setup, before any install | `replaced: false`: the preview was left exactly as it was, and the backup was discarded (`early-failure-preview-restored.json`) |
| #91 reader-explain journey (9 phases) | replaced the preview, as every full run does | `replaced: true`, `dataVerified: true`: every file's name, size and SHA-256 matches the backup (`../reader-explain-2026-09-24/preview-restored.json`) |
| Semantic `places` journey | the same | `replaced: true`, `dataVerified: true` (`places-preview-restored.json`) |

After each run no data archive or pulled APK remained: both hold the preview's credentials and
are deleted only after a verified restore or an untouched check. The preview held no keystore-
sealed session in these runs (`sessionLost: false`). Had it held one, the guard would have refused
before touching anything, unless `KS_PREVIEW_ACCEPT_SIGN_OUT=1` was set.
