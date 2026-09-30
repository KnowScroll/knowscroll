# Issue #171 browser evidence

## 2026-10-01 visual refinement

The unmerged PR now uses the Hybrid Set cream/ink/cobalt/yellow/teal reading register while
retaining the movable dark Universe. A planet click flies an SVG ship to a globe with visible
decorative land shapes, then opens the saved or new Scroll on an explicit second action. The globe
is navigational art, not evidence that a backend Atlas continent has formed. The Reel/Scroll switch
selects a feed kind; it does not claim two renderings of the same asset. A Scroll is parked in
memory while a Reel is viewed and returns to its reading position. Reload loses that temporary
parked Scroll and a subsequent switch asks the feed for another Scroll.

Manual browser checks covered 390×844 and 320×700 portrait views, a 650×420 landscape view,
visible Reel playback and controls, the continent landing, and zero document-width overflow.
The full disposable Chromium and WebKit reader journeys each passed 52 active tests with three
fixture-only skips. A focused Reel/media and gesture journey passed 2/2 in each engine with one
owner-supplied local MP4. The focused runner uses `KS_WEB_PRIVATE_MEDIA=1` to suppress tracked
video-frame screenshots. The media bytes, file path and private video frames were not committed.
`visual-refinement/` contains current non-media Universe/reader captures and a verification log;
older evidence directories were preserved.
These are browser-engine and local-preview receipts; physical iPhone touch and frame timing are
still unverified.

All receipts here came from real local API and worker processes, a fresh disposable PostgreSQL database per run, and a Vite browser client. The runner dropped each database after the test. These are development identity journeys; they do not prove production sign-in.

- `chromium-final/receipt.json`: full reader, Atlas, Keep, recovery, keyboard, privacy and responsive suite; 52 passed, 3 fixture-only branch/Reel tests skipped. The screenshots in that folder show the desktop reader/context and empty Atlas at 390 × 844 and 320 × 700.
- `webkit-final/receipt.json`: the same disposable API, worker and PostgreSQL reader journey in Playwright WebKit; 52 passed, 3 fixture-only branch/Reel tests skipped. `reader-desktop.png` captures the engine's rendered desktop reader.
- `reel/receipt-chromium.json` and `reel/receipt-webkit.json`: two focused tests each, using a three-second **synthetic, labelled MP4 test fixture** in a disposable database. The tests check protected Range delivery, browser playback, video removal on exit, and cancelled versus committed encounter movement. They do not represent Cutroom output or source-aligned generated media. The paired screenshots show 390 × 844 browser viewports.
- `branch/receipt-chromium.json` and `branch/receipt-webkit.json`: one focused browser test each against the real source-backed editorial substrate in a disposable database. A selected continuation is opened by horizontal gesture, its target becomes visible and records exposure, and the origin and reading position return. The 390 × 844 captures show the target and returned reader in each engine. This route currently resolves Scroll targets only.
- `chromium-integration/` records an earlier passing integration phase before the final contract changes. `chromium-final/` is the current Chromium reader receipt.

Playwright WebKit is engine evidence, not a physical iPhone. The gesture test dispatches synthetic Pointer Events. **Real iPhone behavior remains unverified.** Physical touch, Safari back-edge ownership, rotation, long-session memory and frame timing remain device acceptance work.
