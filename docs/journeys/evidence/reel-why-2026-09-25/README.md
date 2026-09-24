# #167 Reels: why sheets and continuations — emulator evidence, 2026-09-25

ADR-0043. `scripts/android-hands-on.py up --reel <authorized MP4>@<A rhythm the ocean keeps>` minted a
gated test Reel over that editorial Scroll. The run used database `knowscroll_test_hands_5da7f326eaf3`
(dropped) and the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's
preview was unchanged (`preview-untouched.json`).

Screenshots of the Reel reader show a frame of the owner's supplied demo video, so they stay in the
ignored `artifacts/`; only the continued Scroll's screenshot is committed.

## By hand

1. **Concepts.** SQL showed the Reel carrying its Scroll's concepts with the same roles (`earth.tides`
   primary, `physics.gravity` secondary), copied when it was minted.
2. **The Reel reader.**
   - "Why" sat beside "Return to origin", and there was no "Sources & truth" (#161).
   - The Why sheet showed the reason, the truth state ("SYNTHESIS — An evidence-grounded
     explanation produced by the system"), "You opened this Reel through deliberate discovery…" and
     what led here. No source.
3. **Continue.** "Continue →" listed the Reel's continuations along admitted bridges (Explains Star
   formation, Explains Tides, Explains Orbit).
4. **Following one.** "Explains Star formation" opened "A star is born from a cloud", headed "FOLLOWED
   A CONNECTION ← Supplied product demo…" and "A connection you chose: Gravity explains Star
   formation." (`hands-on-continued-scroll.png`). `branch_open` recorded 1 row.
5. **Back.** System Back returned to the Reel, still in Reel mode.

## Policy comparison

`./scripts/test.sh scripts/composer-compare.ts` walked golden and adversarial readers over Scrolls and
Reels. It found v3's tie-break clustering sequential editorial ids: 20 of 40 simulated cold starts
got an all-Reel first slate. `composer-semantic-v4` (a new policy row; v3 untouched) mixes the key,
and the figure dropped to 2 of 40. v3 stays the default; v4 runs in shadow.

## Limits

- The Reel is supplied test media (labelled "TEST MEDIA · NOT GENERATED EVIDENCE"), not a Cutroom
  generation (#9).
- The Reel's continuation dialog has no Retry or "Opening…" state yet, and following a continuation
  moves the saved Cable mode to Scroll. Both are review follow-ups in #183.
- Debug API36 emulator, not a physical device.
