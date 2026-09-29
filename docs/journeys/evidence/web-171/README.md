# Issue #171 browser evidence

All receipts here came from real local API and worker processes, a fresh disposable PostgreSQL database per run, and a Vite browser client. The runner dropped each database after the test. These are development identity journeys; they do not prove production sign-in.

- `chromium-final/receipt.json`: full reader, Atlas, Keep, recovery, keyboard, privacy and responsive suite; 52 passed, 3 fixture-only branch/Reel tests skipped. The screenshots in that folder show the desktop reader/context and empty Atlas at 390 × 844 and 320 × 700.
- `webkit-final/receipt.json`: the same disposable API, worker and PostgreSQL reader journey in Playwright WebKit; 52 passed, 3 fixture-only branch/Reel tests skipped. `reader-desktop.png` captures the engine's rendered desktop reader.
- `reel/receipt-chromium.json` and `reel/receipt-webkit.json`: two focused tests each, using a three-second **synthetic, labelled MP4 test fixture** in a disposable database. The tests check protected Range delivery, browser playback, video removal on exit, and cancelled versus committed encounter movement. They do not represent Cutroom output or source-aligned generated media. The paired screenshots show 390 × 844 browser viewports.
- `branch/receipt-chromium.json` and `branch/receipt-webkit.json`: one focused browser test each against the real source-backed editorial substrate in a disposable database. A selected continuation is opened by horizontal gesture, its target becomes visible and records exposure, and the origin and reading position return. The 390 × 844 captures show the target and returned reader in each engine. This route currently resolves Scroll targets only.
- `chromium-integration/` records an earlier passing integration phase before the final contract changes. `chromium-final/` is the current Chromium reader receipt.

Playwright WebKit is engine evidence, not a physical iPhone. The gesture test dispatches synthetic Pointer Events. **Real iPhone behavior remains unverified.** Physical touch, Safari back-edge ownership, rotation, long-session memory and frame timing remain device acceptance work.
