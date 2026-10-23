# Legacy content (frozen v1 data)

These files are data from the v1 implementation, kept because they are bound to real history. They are not loaded by v2 code. See `docs/v2/decisions.md` D-005.

| Path | Contents | Rule |
|---|---|---|
| `reel-scripts/*.json` | 14 owner-approved Cutroom briefs | **Never edit.** A script's request id is a hash of its content and is bound to paid runs in `knowscroll_pool`; any change makes a paid Reel look unordered. |
| `model-scrolls/*.json` | 70 Scrolls written by MiniMax-M3 for v1, with their source material and checks | Not imported into v2. |
| `editorial-scrolls.json`, `demo-library.json`, `substrate.json`, `scroll-supply-plan.json` | v1 editorial library, demo library, semantic substrate and Scroll supply plan | Not imported into v2. |

v2 keeps generated content in its database and media store, not in Git.
