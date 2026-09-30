# #171 visual refinement verification (2026-10-01)

These captures and checks belong to PR #195's unmerged SSD worktree. The three PNGs here were
captured by the disposable browser journey: WebKit at 1440×900 for the Universe and reader, and
Chromium at 390×844 for the Scroll. They show seeded, non-private editorial/test Scroll content.
Older evidence files were preserved; this directory separates the new visual register from them.

- Web unit suite: `pnpm --filter web test` — 26 files, 252 tests passed.
- `pnpm --filter web typecheck`, `pnpm format:check`, `pnpm lint`, and `git diff --check` passed.
- `KS_WEB_ALLOW_BUILD_FOR_TEST_EVIDENCE=1 pnpm --filter web build` passed. An ordinary production
  build still refuses by design until browser identity exists (#2).
- Full disposable API/worker/PostgreSQL reader journey: 52 passed, 3 fixture-only skipped in
  Chromium; 52 passed, 3 fixture-only skipped in WebKit. Both runs dropped their test databases.
  Their command output was observed during this change; the runner's `last-run-receipt.json` is
  overwritten by each subsequent run, so it is not presented here as a per-engine receipt.
- Focused Reel/media and gesture journey: 2/2 passed in Chromium and 2/2 in WebKit with one
  labelled owner-supplied local MP4. A final Chromium 2/2 run with `KS_WEB_PRIVATE_MEDIA=1` verified
  that no tracked video-frame screenshot changed; its disposable runner receipt is included here.
- Manual live browser checks at 390×844, 320×700 and 650×420 showed the ship flight, readable
  continent-shaped land on arrival, the Reel/Scroll switch, visible video playback controls,
  Scroll reading and no document-width overflow. At 650×420 the landing action was in view; at
  320×700 the Reel playback controls were inside the initial viewport.

The landing globe is illustrative navigation, not a derived Atlas place. The switch chooses a
separate encounter kind; it does not convert a Scroll into a Reel of the same asset. A parked Scroll
is temporary memory state. Playwright WebKit is browser-engine evidence, not physical iPhone
acceptance.

## Interactive landing follow-up (2026-10-01)

- The landed planet now slowly rotates with moving clouds. Drag or arrow keys turn the globe;
  tapping the globe or moon cycles daylight, evening glow and moonlit lighting. The separate
  saved-Scroll button still opens the exact read-only Trace.
- Web unit suite: 26 files, 253 tests passed. Web typecheck, formatting, lint and diff checks
  passed.
- The full disposable reader journey passed 53 active tests and three fixture skips in Chromium,
  then the same result in WebKit. The new browser test drags the planet, changes light with the
  planet and moon, and opens the saved Scroll. Both test databases were dropped.
- Manual live checks covered drag and lighting at the default viewport, plus 390×844, 320×700 and
  650×420. At 320×700 the moon and action fit the viewport and document overflow stayed at zero.
- Rotation, clouds, moon and lighting are illustrated arrival-scene interactions. They make no
  Atlas or world write and do not assert a semantic moon or evolved interest. Physical iPhone
  touch acceptance remains open.
