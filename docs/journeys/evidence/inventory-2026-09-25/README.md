# #164 inventory v1 — emulator evidence, 2026-09-25

ADR-0046. Setup:

- Stack: `scripts/android-hands-on.py up --seed scripts/atlas/seed-day-old-history.ts`, with the worker
  started with `KS_SCROLL_TRANSPORT=fixture` and the correction catch-up every 3 s.
- Database: `knowscroll_test_hands_ec6e0584b114`, dropped afterwards.
- Writing route: `scripts/scrolls/install-supply.ts --transport fixture --request-cap 3`, with one
  allowlisted material candidate for Gravity (NASA's "What Is Gravity?" page).
- App: the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's preview
  was unchanged (`preview-untouched.json`).

## By hand

1. **Demand from real reading.** Read in the Cable and kept "A rhythm the ocean keeps" and "The pull
   you can't see", after the seeded day-old keep. Gravity formed with all three of its Scrolls read.
   The next Cable step recorded the need: `content_demand` for `physics.gravity`, decision `fund`,
   status `waiting`, and one shared `supply_request` opened.
2. **Shared supply, private binding.**
   - The worker's writing loop fetched the page and wrote with the labelled fixture transport.
   - ADR-0041's checks admitted the Scroll; the supply request moved to `fulfilled`.
   - The Quartermaster decided `reuse`, and the demand became `bound`.
   - The place sheet showed "New for you: Fixture: Gravity" and "3 of 4 Scrolls read"
     (`hands-on-01-place-need.png`).
3. **Opening it.** "New for you" opened the bound Scroll in the reader, headed "More about Gravity: you
   had already seen everything here." (`hands-on-02-bound-scroll.png`). Why it appeared: "You had
   already seen everything here" (`hands-on-03-bound-why.png`). No source anywhere.
4. **A correction withdraws it.**
   - Pressed Home and withdrew the page's source (`correct-source.ts --action revoked`). The binding
     became `withdrawn` and the demand reopened.
   - The Quartermaster decided `cannot_meet` (`no_material`): the one candidate was already used.
   - On return:
     - the place sheet reads "Nothing more about Gravity for now" and "Withdrawn: what it was based
       on changed" (`hands-on-04-away-withdrawn.png`);
     - "While you were away" says "A Scroll about Gravity you were waiting for was withdrawn: what it
       was based on changed." (`hands-on-05-atlas-away.png`).

## Limits

- **Fixture writer.** The supply loop wrote with the fixture transport. The MiniMax transport it calls
  for `minimax` is the one #162's live batch used (35 requests). Running it here would put the key in
  the hands-on stack's worker environment file, so no live request was spent on this slice.
- **"Being written…"** passed too quickly to screenshot with the fixture writer. The state
  progression (`fund` → `waiting` → `bound` → `withdrawn` → `cannot_meet`) is in the database.
- **Place count.** After the withdrawal the place still counts the withdrawn Scroll ("4 of 4").
- Debug API36 emulator, not a physical device.
